import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { FrameSplitter } from './mp3.js';

// A listener this many bytes behind (paused tab, dead connection) gets disconnected.
// Clients reconnect to rejoin live when they resume.
const MAX_PENDING_BYTES = 1024 * 1024;
// How often paced audio is released to listeners.
const PACE_INTERVAL_MS = 40;
// Encoded audio held ahead of the pacer; ffmpeg is paused (pipe backpressure) above this.
const HIGH_WATER_SECONDS = 4;

/**
 * One continuous MP3 stream shared by every listener, like an Icecast mount.
 *
 * A single ffmpeg "source" process at a time encodes either a track file or silence. Its
 * output is paced in Node at exactly the (constant) bitrate and fanned out to all connected
 * HTTP responses, so every listener hears the same position. Switching sources just
 * concatenates MP3 frames, which browsers handle seamlessly. Silence between tracks keeps
 * the connection (and the phone's media notification) alive.
 *
 * Pacing here instead of with ffmpeg's -re lets the first source after cut() start with a
 * head start ("lead") of a few seconds sent at once. Clients that reconnect after a station
 * control then get enough audio to start playing immediately, just like a fresh join.
 */
export class Broadcaster extends EventEmitter {
  /** @type {Set<import('node:http').ServerResponse>} */
  #listeners = new Set();
  /** Most recent audio, replayed to new listeners so playback starts instantly. */
  #burst = [];
  #burstBytes = 0;
  #burstMax;
  #bytesPerSecond;
  #leadSeconds;
  /** Whether the next source gets a lead (set by cut()). */
  #leadNext = false;
  /** @type {Source|null} */
  #source = null;
  #spawnFailing = false;

  constructor({ ffmpegBin, bitrateKbps, burstSeconds }) {
    super();
    this.ffmpegBin = ffmpegBin;
    this.bitrateKbps = bitrateKbps;
    this.#bytesPerSecond = (bitrateKbps * 1000) / 8;
    this.#burstMax = Math.round(this.#bytesPerSecond * burstSeconds);
    this.#leadSeconds = burstSeconds;
    setInterval(() => this.#pace(), PACE_INTERVAL_MS).unref();
  }

  get listenerCount() {
    return this.#listeners.size;
  }

  /** Seconds the current source runs ahead of real time (its lead), 0 for normal sources. */
  get sourceLeadSeconds() {
    return this.#source?.leadSeconds ?? 0;
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
   * Streams a local audio file starting `offsetSeconds` in.
   * Resolves when it has been fully sent, or was stopped.
   */
  playFile(file, offsetSeconds = 0) {
    const seek = offsetSeconds > 0 ? ['-ss', offsetSeconds.toFixed(3)] : [];
    return this.#runSource([...seek, '-i', file]);
  }

  /** Streams silence until stop() is called. */
  playSilence() {
    return this.#runSource(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']);
  }

  /** Ends the current source; anything it has not sent yet is dropped. */
  stop() {
    const source = this.#source;
    if (!source) return;
    this.#source = null;
    source.proc.kill('SIGKILL');
    source.finish({ code: null, signal: 'SIGKILL' });
  }

  /**
   * Hard cut for station controls: stops the current source, forgets the replay buffer so
   * (re)connecting listeners get none of the old audio, and gives the next source a lead.
   */
  cut() {
    this.stop();
    this.#burst = [];
    this.#burstBytes = 0;
    this.#leadNext = true;
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

  /** Releases the bytes the current source is due to have sent by now. */
  #pace() {
    const source = this.#source;
    if (!source) return;

    // Whole frames only (see mp3.js); being up to one frame early is fine.
    const elapsed = (performance.now() - source.startedAt) / 1000;
    let budget = Math.floor((elapsed + source.leadSeconds) * this.#bytesPerSecond) - source.sent;
    const due = [];
    while (budget > 0 && source.queue.length > 0) {
      const frame = source.queue.shift();
      source.queued -= frame.length;
      source.sent += frame.length;
      budget -= frame.length;
      due.push(frame);
    }
    if (due.length > 0) this.#broadcast(due.length === 1 ? due[0] : Buffer.concat(due));

    if (source.queued < this.#bytesPerSecond * (HIGH_WATER_SECONDS / 2)) source.proc.stdout.resume();
    if (source.exit && source.queued === 0) {
      this.#source = null;
      source.finish(source.exit);
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
      // Constant bitrate, so bytes map exactly to playback time for pacing.
      '-c:a', 'libmp3lame', '-b:a', `${this.bitrateKbps}k`,
      // Plain frames only: no per-track headers that would confuse a continuous stream.
      '-write_xing', '0', '-id3v2_version', '0',
      '-flush_packets', '1',
      '-f', 'mp3', 'pipe:1',
    ];
    const proc = spawn(this.ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let finish;
    const done = new Promise((resolve) => (finish = resolve));
    const source = makeSource(proc, this.#leadNext ? this.#leadSeconds : 0, finish);
    this.#leadNext = false;
    this.#source = source;

    const highWater = this.#bytesPerSecond * HIGH_WATER_SECONDS;
    const splitter = new FrameSplitter();
    proc.stdout.on('data', (chunk) => {
      if (this.#source !== source) return;
      for (const frame of splitter.push(chunk)) {
        source.queue.push(frame);
        source.queued += frame.length;
      }
      if (source.queued > highWater) proc.stdout.pause();
    });
    proc.stderr.on('data', (data) => console.error(`[ffmpeg] ${String(data).trim()}`));

    proc.on('spawn', () => {
      if (this.#spawnFailing) console.log('[ffmpeg] started again');
      this.#spawnFailing = false;
    });
    proc.on('error', (err) => {
      // Log once per outage; the station keeps retrying with backoff.
      if (!this.#spawnFailing) console.error(`[ffmpeg] failed to start: ${err.message}`);
      this.#spawnFailing = true;
      if (this.#source === source) this.#source = null;
      source.finish({ code: null, signal: null });
    });
    // Natural end: keep pacing out what is still queued, then finish (see #pace).
    proc.on('close', (code, signal) => {
      source.exit = { code, signal };
    });

    return done;
  }
}

/** @typedef {ReturnType<typeof makeSource>} Source */

function makeSource(proc, leadSeconds, resolve) {
  let finished = false;
  return {
    proc,
    leadSeconds,
    startedAt: performance.now(),
    /** @type {Buffer[]} whole MP3 frames not yet sent */
    queue: [],
    queued: 0,
    sent: 0,
    /** @type {{code: number|null, signal: string|null} | null} set once ffmpeg exited */
    exit: null,
    finish(result) {
      if (finished) return;
      finished = true;
      resolve(result);
    },
  };
}
