import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Ties the queue, the downloader and the broadcaster together.
 *
 * - Downloads queued tracks one at a time, in queue order.
 * - Plays ready tracks back to back; streams silence while nothing is ready.
 * - Emits 'change' whenever the public state (see state()) changes.
 */
export class Station extends EventEmitter {
  /** @type {(import('./queue.js').Track & {startedAt: number}) | null} */
  current = null;
  #downloading = false;
  #running = false;

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
    if (!this.current || (expectedId && this.current.id !== expectedId)) return false;
    console.log(`[station] skipped "${this.current.title}"`);
    this.broadcaster.stop();
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
    return {
      stationName: this.stationName,
      serverTime: Date.now(),
      liveDelayMs: this.liveDelayMs,
      listeners: this.broadcaster.listenerCount,
      nowPlaying: this.current ? { ...pub(this.current), startedAt: this.current.startedAt } : null,
      queue: this.queue.tracks.map(pub),
    };
  }

  async #loop() {
    while (this.#running) {
      const track = this.queue.takeNextReady();

      if (!track) {
        // Stream silence until a track becomes ready.
        const onChange = () => {
          if (this.queue.hasReady() || !this.#running) this.broadcaster.stop();
        };
        this.queue.on('change', onChange);
        const startedAt = Date.now();
        const silence = this.broadcaster.playSilence();
        onChange();
        await silence;
        this.queue.off('change', onChange);
        if (Date.now() - startedAt < 1000 && !this.queue.hasReady()) await sleep(1000); // ffmpeg broken?
        continue;
      }

      this.current = { ...track, startedAt: Date.now() };
      this.emit('change');
      console.log(`[station] now playing "${track.title}"`);

      const startedAt = Date.now();
      const { code, signal } = await this.broadcaster.playFile(track.file);
      if (code !== 0 && !signal) {
        console.error(`[station] ffmpeg exited with code ${code} while playing "${track.title}"`);
        if (Date.now() - startedAt < 1000) await sleep(1000);
      }

      this.#deleteFile(track.file);
      this.current = null;
      this.emit('change');
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
