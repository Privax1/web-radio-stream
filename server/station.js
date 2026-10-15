import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Ties the queue, the downloader and the broadcaster together.
 *
 * - Downloads queued tracks one at a time, in queue order.
 * - Plays ready tracks back to back; streams silence while nothing is ready or while paused.
 * - Station-wide controls: skip, seek, pause/resume. Each one stops the current ffmpeg
 *   source; the play loop then decides what to stream next.
 * - Emits 'change' whenever the public state (see state()) changes.
 */
export class Station extends EventEmitter {
  /**
   * The track on air. `startedAt` is the server time at which position 0 would have played
   * (null while paused); `position` is the offset in seconds the current source started at.
   * @type {(import('./queue.js').Track & {startedAt: number|null, position: number}) | null}
   */
  current = null;
  paused = false;
  #downloading = false;
  #running = false;
  #skipRequested = false;
  /** @type {number|null} */
  #seekTo = null;
  #silenceFailures = 0;

  /**
   * @param {object} deps
   * @param {import('./queue.js').Queue} deps.queue
   * @param {import('./broadcaster.js').Broadcaster} deps.broadcaster
   * @param {import('./ytdlp.js').YtDlp} deps.ytdlp
   */
  constructor({ queue, broadcaster, ytdlp, cacheDir, stationName, liveDelayMs }) {
    super();
    this.queue = queue;
    this.broadcaster = broadcaster;
    this.ytdlp = ytdlp;
    this.cacheDir = cacheDir;
    this.stationName = stationName;
    this.liveDelayMs = liveDelayMs;

    queue.on('change', () => {
      this.#downloadNext();
      this.emit('change');
    });
    broadcaster.on('listeners', () => this.emit('change'));
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#loop().catch((err) => console.error('[station] loop crashed', err));
  }

  stop() {
    this.#running = false;
    this.broadcaster.closeAll();
  }

  /** Skips the current track. `expectedId` prevents two simultaneous skips from skipping twice. */
  skip(expectedId) {
    if (!this.#isCurrent(expectedId)) return false;
    console.log(`[station] skipped "${this.current.title}"`);
    this.#skipRequested = true;
    this.broadcaster.stop();
    return true;
  }

  /** Jumps the current track to `seconds` for everyone. */
  seek(expectedId, seconds) {
    if (!this.#isCurrent(expectedId) || !Number.isFinite(seconds)) return false;
    const position = Math.min(Math.max(seconds, 0), Math.max(this.current.duration - 1, 0));
    if (this.paused) {
      this.current.position = position;
      this.emit('change');
    } else {
      this.#seekTo = position;
      this.broadcaster.stop();
    }
    return true;
  }

  /** Pauses the station for everyone. Listeners stay connected and hear silence. */
  pause() {
    if (this.paused) return false;
    this.paused = true;
    console.log('[station] paused');
    if (this.current) this.broadcaster.stop();
    this.emit('change');
    return true;
  }

  resume() {
    if (!this.paused) return false;
    this.paused = false;
    console.log('[station] resumed');
    this.emit('change'); // ends the paused silence, see #silenceUntil
    return true;
  }

  /** Removes a queued (not playing) track and its downloaded file. */
  remove(id) {
    const track = this.queue.remove(id);
    if (track?.file) this.#deleteFile(track.file);
    return Boolean(track);
  }

  state() {
    const pub = (t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      duration: t.duration,
      thumbnail: t.thumbnail,
      uploader: t.uploader,
      addedBy: t.addedBy,
      status: t.status,
    });
    const now = this.current;
    return {
      stationName: this.stationName,
      serverTime: Date.now(),
      liveDelayMs: this.liveDelayMs,
      listeners: this.broadcaster.listenerCount,
      paused: this.paused,
      nowPlaying: now ? { ...pub(now), startedAt: now.startedAt, position: now.position } : null,
      queue: this.queue.tracks.map(pub),
    };
  }

  #isCurrent(expectedId) {
    return Boolean(this.current) && (!expectedId || this.current.id === expectedId);
  }

  async #loop() {
    while (this.#running) {
      if (this.paused) {
        await this.#silenceUntil(() => !this.paused);
        continue;
      }
      const track = this.queue.takeNextReady();
      if (!track) {
        await this.#silenceUntil(() => this.queue.hasReady() || this.paused);
        continue;
      }

      console.log(`[station] now playing "${track.title}"`);
      await this.#playTrack(track);
      this.#deleteFile(track.file);
      this.current = null;
      this.emit('change');
    }
  }

  /** Plays one track to the end, handling seeks and pauses on the way. */
  async #playTrack(track) {
    let position = 0;
    this.#skipRequested = false;
    this.#seekTo = null;

    while (this.#running) {
      if (this.paused) {
        this.current = { ...track, startedAt: null, position };
        this.emit('change');
        await this.#silenceUntil(() => !this.paused || this.#skipRequested);
        if (this.#skipRequested) break;
        position = this.current.position; // a seek while paused moves this
        continue;
      }

      const startedAt = Date.now() - position * 1000;
      this.current = { ...track, startedAt, position };
      this.emit('change');

      const sourceStart = Date.now();
      const { code, signal } = await this.broadcaster.playFile(track.file, position);

      if (this.#skipRequested) break;
      if (this.#seekTo !== null) {
        position = this.#seekTo;
        this.#seekTo = null;
        continue;
      }
      if (this.paused) {
        position = Math.min((Date.now() - startedAt) / 1000, track.duration);
        continue;
      }
      if (code !== 0 && !signal) {
        console.error(`[station] ffmpeg exited with code ${code} while playing "${track.title}"`);
        if (Date.now() - sourceStart < 1000) await sleep(1000);
      }
      break; // finished
    }
    this.#skipRequested = false;
  }

  /** Streams silence until `done()` is true (re-checked on every state change). */
  async #silenceUntil(done) {
    const check = () => {
      if (done() || !this.#running) this.broadcaster.stop();
    };
    this.on('change', check);
    const startedAt = Date.now();
    const silence = this.broadcaster.playSilence();
    check();
    await silence;
    this.off('change', check);

    // Silence ending on its own within a second means ffmpeg is broken or missing.
    // Back off (1s, 2s, 4s … 30s) instead of retrying in a tight loop.
    if (Date.now() - startedAt < 1000 && !done()) {
      await sleep(Math.min(1000 * 2 ** this.#silenceFailures, 30_000));
      this.#silenceFailures++;
    } else {
      this.#silenceFailures = 0;
    }
  }

  async #downloadNext() {
    if (this.#downloading) return;
    const track = this.queue.nextPending();
    if (!track) return;

    this.#downloading = true;
    this.queue.setStatus(track.id, 'downloading');
    try {
      const file = await this.ytdlp.downloadAudio(track.url, this.cacheDir, track.id);
      if (this.queue.get(track.id)) {
        this.queue.setStatus(track.id, 'ready', file);
      } else {
        this.#deleteFile(file); // removed from the queue while downloading
      }
    } catch (err) {
      console.error(`[station] download failed for "${track.title}": ${err.message}`);
      this.queue.remove(track.id);
    } finally {
      this.#downloading = false;
      this.#downloadNext();
    }
  }

  #deleteFile(file) {
    if (file) rm(file, { force: true }).catch(() => {});
  }
}
