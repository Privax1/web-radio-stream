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

  /** Looks up a single video without downloading it. Throws ValidationError for unusable links. */
  async fetchInfo(url) {
    let info;
    try {
      info = JSON.parse(await this.#run(['-J', '--no-playlist', '--no-warnings', '--', url], 60_000));
    } catch (err) {
      console.warn(`[yt-dlp] info lookup failed for ${url}: ${err.message}`);
      throw new ValidationError('Could not load that link. Is it a public video?');
    }

    if (info._type === 'playlist') {
      throw new ValidationError('Playlists are not supported yet. Please add single videos.');
    }
    if (info.is_live || info.live_status === 'is_live' || info.live_status === 'is_upcoming') {
      throw new ValidationError('Live streams cannot be queued.');
    }
    const duration = Number(info.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new ValidationError('Could not determine the length of that video.');
    }
    if (duration > this.maxTrackSeconds) {
      throw new ValidationError(
        `That track is too long (max ${Math.round(this.maxTrackSeconds / 60)} minutes).`,
      );
    }

    return {
      url: info.webpage_url ?? url,
      title: info.title ?? 'Untitled',
      duration,
      thumbnail: info.thumbnail ?? null,
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
