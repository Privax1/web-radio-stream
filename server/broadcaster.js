import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

// A listener this many bytes behind (paused tab, dead connection) gets disconnected.
// Clients reconnect to rejoin live when they resume.
const MAX_PENDING_BYTES = 1024 * 1024;

/**
 * One continuous MP3 stream shared by every listener, like an Icecast mount.
 *
 * A single ffmpeg "source" process at a time encodes either a track file or silence in
 * real time (-re). Its output is fanned out to all connected HTTP responses, so every
 * listener hears the same position. Switching sources just concatenates MP3 frames, which
 * browsers handle seamlessly. Silence between tracks keeps the connection (and the
 * phone's media notification) alive.
 */
export class Broadcaster extends EventEmitter {
  /** @type {Set<import('node:http').ServerResponse>} */
  #listeners = new Set();
  /** Most recent audio, replayed to new listeners so playback starts instantly. */
  #burst = [];
  #burstBytes = 0;
  #burstMax;
  /** @type {import('node:child_process').ChildProcess|null} */
  #source = null;
  #spawnFailing = false;

  constructor({ ffmpegBin, bitrateKbps, burstSeconds }) {
    super();
    this.ffmpegBin = ffmpegBin;
    this.bitrateKbps = bitrateKbps;
    this.#burstMax = Math.round(((bitrateKbps * 1000) / 8) * burstSeconds);
  }

  get listenerCount() {
    return this.#listeners.size;
  }

  attach(req, res) {
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-store',
      'X-Accel-Buffering': 'no',
    });
    if (req.method === 'HEAD') return res.end();

    for (const chunk of this.#burst) res.write(chunk);
    this.#listeners.add(res);
    this.emit('listeners');
    res.on('close', () => {
      if (this.#listeners.delete(res)) this.emit('listeners');
    });
  }

  /**
   * Streams a local audio file in real time, starting `offsetSeconds` in.
   * Resolves when it finished or was stopped.
   */
  playFile(file, offsetSeconds = 0) {
    const seek = offsetSeconds > 0 ? ['-ss', offsetSeconds.toFixed(3)] : [];
    return this.#runSource(['-re', ...seek, '-i', file]);
  }

  /** Streams silence until stop() is called. */
  playSilence() {
    return this.#runSource(['-re', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']);
  }

  stop() {
    this.#source?.kill('SIGKILL');
  }

  closeAll() {
    this.stop();
    for (const res of this.#listeners) res.destroy();
  }

  #broadcast(chunk) {
    this.#burst.push(chunk);
    this.#burstBytes += chunk.length;
    while (this.#burst.length > 1 && this.#burstBytes - this.#burst[0].length >= this.#burstMax) {
      this.#burstBytes -= this.#burst.shift().length;
    }

    for (const res of this.#listeners) {
      if (res.writableLength > MAX_PENDING_BYTES) res.destroy();
      else res.write(chunk);
    }
  }

  /** @returns {Promise<{code: number|null, signal: string|null}>} */
  #runSource(inputArgs) {
    this.stop();
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      ...inputArgs,
      '-vn', '-map_metadata', '-1',
      '-ac', '2', '-ar', '44100',
      '-c:a', 'libmp3lame', '-b:a', `${this.bitrateKbps}k`,
      // Plain frames only: no per-track headers that would confuse a continuous stream.
      '-write_xing', '0', '-id3v2_version', '0',
      '-flush_packets', '1',
      '-f', 'mp3', 'pipe:1',
    ];
    const proc = spawn(this.ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.#source = proc;

    proc.stdout.on('data', (chunk) => {
      if (this.#source === proc) this.#broadcast(chunk);
    });
    proc.stderr.on('data', (data) => console.error(`[ffmpeg] ${String(data).trim()}`));

    return new Promise((resolve) => {
      const done = (code, signal) => {
        if (this.#source === proc) this.#source = null;
        resolve({ code, signal });
      };
      proc.on('spawn', () => {
        if (this.#spawnFailing) console.log('[ffmpeg] started again');
        this.#spawnFailing = false;
      });
      proc.on('error', (err) => {
        // Log once per outage; the station keeps retrying with backoff.
        if (!this.#spawnFailing) console.error(`[ffmpeg] failed to start: ${err.message}`);
        this.#spawnFailing = true;
        done(null, null);
      });
      proc.on('close', done);
    });
  }
}
