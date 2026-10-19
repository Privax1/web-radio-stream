import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Queue } from '../server/queue.js';
import { Station } from '../server/station.js';

/** Records what would be streamed; each source runs until stop() or finish(). */
class FakeBroadcaster extends EventEmitter {
  listenerCount = 0;
  calls = [];
  #end = null;

  playFile(file, offset = 0) {
    return this.#start(['file', file, offset]);
  }
  playSilence() {
    return this.#start(['silence']);
  }
  stop() {
    this.#end?.({ code: null, signal: 'SIGKILL' });
  }
  finish() {
    this.#end?.({ code: 0, signal: null });
  }
  closeAll() {
    this.stop();
  }
  cut() {
    this.stop();
    this.cuts = (this.cuts ?? 0) + 1;
  }
  sourceLeadSeconds = 0;
  get last() {
    return this.calls.at(-1);
  }
  #start(call) {
    this.stop();
    this.calls.push(call);
    return new Promise((resolve) => {
      this.#end = (result) => {
        this.#end = null;
        resolve(result);
      };
    });
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function setup() {
  const queue = new Queue({ maxLength: 10 });
  const broadcaster = new FakeBroadcaster();
  const ytdlp = { downloadAudio: async (_url, dir, name) => `${dir}/${name}.m4a` };
  const station = new Station({
    queue,
    broadcaster,
    ytdlp,
    cacheDir: '/nonexistent',
    stationName: 'Test',
    liveDelayMs: 0,
  });
  station.start();
  const track = queue.add({ url: 'https://youtu.be/a', title: 'A', duration: 200 });
  await settle();
  await settle();
  return { queue, broadcaster, station, track, file: `/nonexistent/${track.id}.m4a` };
}

test('plays a downloaded track from the start', async (t) => {
  const { broadcaster, station, track, file } = await setup();
  t.after(() => station.stop());

  assert.deepEqual(broadcaster.last, ['file', file, 0]);
  assert.equal(station.state().nowPlaying.id, track.id);
});

test('seek restarts the current track at the new position', async (t) => {
  const { broadcaster, station, track, file } = await setup();
  t.after(() => station.stop());

  assert.equal(station.seek(track.id, 42), true);
  await settle();

  assert.deepEqual(broadcaster.last, ['file', file, 42]);
  const np = station.state().nowPlaying;
  assert.equal(np.position, 42);
  assert.ok(Math.abs(Date.now() - np.startedAt - 42_000) < 500);
});

test('seek is clamped to the track and ignores stale track ids', async (t) => {
  const { broadcaster, station, track, file } = await setup();
  t.after(() => station.stop());

  assert.equal(station.seek('other-id', 10), false);
  station.seek(track.id, 9999);
  await settle();
  assert.deepEqual(broadcaster.last, ['file', file, 199]);

  station.seek(track.id, -5);
  await settle();
  assert.deepEqual(broadcaster.last, ['file', file, 0]);
});

test('pause streams silence and resume continues where it stopped', async (t) => {
  const { broadcaster, station, track, file } = await setup();
  t.after(() => station.stop());
  station.seek(track.id, 30);
  await settle();

  assert.equal(station.pause(), true);
  await settle();
  assert.deepEqual(broadcaster.last, ['silence']);
  const paused = station.state();
  assert.equal(paused.paused, true);
  assert.equal(paused.nowPlaying.startedAt, null);
  assert.ok(Math.abs(paused.nowPlaying.position - 30) < 0.5);

  assert.equal(station.resume(), true);
  await settle();
  assert.equal(broadcaster.last[0], 'file');
  assert.ok(Math.abs(broadcaster.last[2] - 30) < 0.5);
});

test('seeking while paused moves the resume position without playing', async (t) => {
  const { broadcaster, station, track, file } = await setup();
  t.after(() => station.stop());
  station.pause();
  await settle();

  station.seek(track.id, 90);
  await settle();
  assert.deepEqual(broadcaster.last, ['silence']);
  assert.equal(station.state().nowPlaying.position, 90);

  station.resume();
  await settle();
  assert.deepEqual(broadcaster.last, ['file', file, 90]);
});

test('a paused station does not start the next track', async (t) => {
  const { queue, broadcaster, station, track } = await setup();
  t.after(() => station.stop());
  queue.add({ url: 'https://youtu.be/b', title: 'B', duration: 100 });
  station.pause();
  await settle();

  station.skip(track.id);
  await settle();
  await settle();

  assert.equal(station.state().nowPlaying, null);
  assert.deepEqual(broadcaster.last, ['silence']);

  station.resume();
  await settle();
  assert.equal(station.state().nowPlaying.title, 'B');
});

test('audible controls start a new epoch and cut the stream; a paused seek does not', async (t) => {
  const { broadcaster, station, track } = await setup();
  t.after(() => station.stop());
  const epoch = () => station.state().epoch;
  const start = epoch();

  station.seek(track.id, 10);
  assert.equal(epoch(), start + 1);
  station.pause();
  assert.equal(epoch(), start + 2);
  await settle();
  station.seek(track.id, 20); // nothing audible changes while paused
  assert.equal(epoch(), start + 2);
  station.resume();
  assert.equal(epoch(), start + 3);
  await settle();
  station.skip(track.id);
  assert.equal(epoch(), start + 4);
  assert.equal(broadcaster.cuts, 4);
});

test('a finished track moves on to the next one', async (t) => {
  const { queue, broadcaster, station } = await setup();
  t.after(() => station.stop());
  const b = queue.add({ url: 'https://youtu.be/b', title: 'B', duration: 100 });
  await settle();

  broadcaster.finish();
  await settle();
  await settle();

  assert.equal(station.state().nowPlaying.id, b.id);
});

test('finished and skipped tracks go to the history, newest first', async (t) => {
  const { queue, broadcaster, station, track } = await setup();
  t.after(() => station.stop());
  assert.deepEqual(station.state().history, []);
  const b = queue.add({ url: 'https://youtu.be/b', title: 'B', duration: 100, addedBy: 'Sam' });
  await settle();

  broadcaster.finish();
  await settle();
  await settle();
  station.skip(b.id);
  await settle();
  await settle();

  const history = station.state().history;
  assert.deepEqual(history.map((h) => h.id), [b.id, track.id]);
  assert.equal(history[0].addedBy, 'Sam');
  assert.equal(typeof history[0].playedAt, 'number');
  assert.equal('file' in history[0], false);
});

test('the history is capped at historyLength', async (t) => {
  const queue = new Queue({ maxLength: 10 });
  const broadcaster = new FakeBroadcaster();
  const ytdlp = { downloadAudio: async (_url, dir, name) => `${dir}/${name}.m4a` };
  const station = new Station({
    queue, broadcaster, ytdlp, cacheDir: '/nonexistent', stationName: 'T', liveDelayMs: 0, historyLength: 2,
  });
  station.start();
  t.after(() => station.stop());
  for (const title of ['a', 'b', 'c']) queue.add({ url: `https://youtu.be/${title}`, title, duration: 10 });
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 6; j++) await settle();
    broadcaster.finish();
  }
  for (let j = 0; j < 4; j++) await settle();

  assert.deepEqual(station.state().history.map((h) => h.title), ['c', 'b']);
});
