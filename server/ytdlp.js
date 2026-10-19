import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ValidationError } from './validate.js';

const execFileAsync = promisify(execFile);

/** Wraps yt-dlp. URLs are always passed after `--` so they can never be read as options. */
export class YtDlp {
  constructor({ bin, extraArgs = [], maxTrackSeconds }) {
    this.bin = bin;
    this.extraArgs = extraArgs;
    this.maxTrackSeconds = maxTrackSeconds;
  }

  async #run(args, timeout) {
    try {
      const { stdout } = await execFileAsync(this.bin, [...this.extraArgs, ...args], {
        timeout,
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      const detail = String(err.stderr ?? err.message).trim().split('\n').at(-1);
      throw new Error(`yt-dlp failed: ${detail}`);
    }
  }

  /** Runs yt-dlp with `-J` and parses its JSON output. Replaced by a fake in tests. */
  async runJson(args, timeout) {
    return JSON.parse(await this.#run(['-J', '--no-warnings', ...args], timeout));
  }

  /** Looks up a single track without downloading it. Throws ValidationError for unusable links. */
  async fetchInfo(url) {
    let info;
    try {
      info = await this.runJson(['--no-playlist', '--', url], 60_000);
    } catch (err) {
      console.warn(`[yt-dlp] info lookup failed for ${url}: ${err.message}`);
      throw new ValidationError('Could not load that link. Is it public?');
    }
    if (info._type === 'playlist') {
      throw new ValidationError('That link is a playlist, not a single track.');
    }
    return this.#toTrack(info, url);
  }

  /**
   * Resolves a link to the tracks it stands for: one track, or the entries of a playlist
   * (YouTube playlist, SoundCloud set, ...). Unusable playlist entries are skipped.
   *
   * @param {string} url
   * @param {object} options
   * @param {boolean} [options.wholePlaylist] for links that are both a video and a playlist
   *   (YouTube `watch?v=…&list=…`): take the playlist instead of just the video
   * @param {number} options.maxEntries upper limit of playlist entries to look at
   * @param {(url: string) => boolean} options.allowUrl filter for entry URLs (domain allowlist)
   * @returns {Promise<{tracks: TrackInfo[], skipped: number, playlist: string|null}>}
   */
  async resolve(url, { wholePlaylist = false, maxEntries, allowUrl }) {
    let info;
    try {
      // --flat-playlist lists entries without extracting each one (fast for YouTube, which
      // includes title and duration; SoundCloud entries are looked up one by one below).
      info = await this.runJson(
        [
          '--flat-playlist',
          wholePlaylist ? '--yes-playlist' : '--no-playlist',
          '--playlist-items', `1:${maxEntries}`,
          '--', url,
        ],
        120_000,
      );
    } catch (err) {
      console.warn(`[yt-dlp] lookup failed for ${url}: ${err.message}`);
      throw new ValidationError('Could not load that link. Is it public?');
    }

    if (info._type !== 'playlist') {
      return { tracks: [this.#toTrack(info, url)], skipped: 0, playlist: null };
    }

    const entries = (info.entries ?? []).filter(Boolean).slice(0, maxEntries);
    const results = await mapLimit(entries, 4, async (entry) => {
      const entryUrl = entry.webpage_url ?? entry.url;
      if (typeof entryUrl !== 'string' || !allowUrl(entryUrl)) return null;
      try {
        // Flat entries that already carry title and duration need no extra lookup.
        if (entry.title && Number(entry.duration) > 0) return this.#toTrack(entry, entryUrl);
        return await this.fetchInfo(entryUrl);
      } catch (err) {
        console.warn(`[yt-dlp] skipped playlist entry ${entryUrl}: ${err.message}`);
        return null;
      }
    });
    const tracks = results.filter(Boolean);
    return {
      tracks,
      skipped: results.length - tracks.length,
      playlist: info.title ?? 'Playlist',
    };
  }

  /** Checks a yt-dlp info dict and reduces it to what the queue needs. */
  #toTrack(info, fallbackUrl) {
    if (info.is_live || info.live_status === 'is_live' || info.live_status === 'is_upcoming') {
      throw new ValidationError('Live streams cannot be queued.');
    }
    const duration = Number(info.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new ValidationError('Could not determine the length of that track.');
    }
    if (duration > this.maxTrackSeconds) {
      throw new ValidationError(
        `That track is too long (max ${Math.round(this.maxTrackSeconds / 60)} minutes).`,
      );
    }
    return {
      url: info.webpage_url ?? fallbackUrl,
      title: info.title ?? 'Untitled',
      duration,
      thumbnail: info.thumbnail ?? info.thumbnails?.at(-1)?.url ?? null,
      uploader: info.uploader ?? info.channel ?? null,
    };
  }

  /**
   * Downloads the best audio-only format to `<dir>/<name>.<ext>`.
   * @returns {Promise<string>} path of the downloaded file
   */
  async downloadAudio(url, dir, name) {
    await this.#run(
      [
        '-f', 'bestaudio/best',
        '--no-playlist', '--no-part', '--no-progress', '--no-mtime', '--no-warnings',
        '-o', path.join(dir, `${name}.%(ext)s`),
        '--', url,
      ],
      10 * 60_000,
    );
    const file = (await readdir(dir)).find((f) => f.startsWith(`${name}.`));
    if (!file) throw new Error('yt-dlp finished but produced no file');
    return path.join(dir, file);
  }
}

/** Like Promise.all(items.map(fn)), but runs at most `limit` calls at once. Keeps order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * @typedef {object} TrackInfo
 * @property {string} url
 * @property {string} title
 * @property {number} duration seconds
 * @property {string|null} thumbnail
 * @property {string|null} uploader
 */
