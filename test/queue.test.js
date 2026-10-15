import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Queue, QueueFullError } from '../server/queue.js';

const info = (title) => ({ url: `https://youtu.be/${title}`, title, duration: 180 });

test('add appends pending tracks and emits change', () => {
  const queue = new Queue({ maxLength: 10 });
  let changes = 0;
  queue.on('change', () => changes++);

  const track = queue.add(info('a'));

  assert.equal(track.status, 'pending');
  assert.deepEqual(queue.tracks.map((t) => t.title), ['a']);
  assert.equal(changes, 1);
});

test('add rejects when the queue is full', () => {
  const queue = new Queue({ maxLength: 1 });
  queue.add(info('a'));
  assert.throws(() => queue.add(info('b')), QueueFullError);
});

test('nextPending returns the first track that is not downloaded yet', () => {
  const queue = new Queue({ maxLength: 10 });
  const a = queue.add(info('a'));
  const b = queue.add(info('b'));
  queue.setStatus(a.id, 'downloading');
  assert.equal(queue.nextPending().id, b.id);
});

test('takeNextReady takes the first ready track, skipping ones still downloading', () => {
  const queue = new Queue({ maxLength: 10 });
  const a = queue.add(info('a'));
  const b = queue.add(info('b'));
  queue.setStatus(a.id, 'downloading');
  assert.equal(queue.takeNextReady(), undefined);

  queue.setStatus(b.id, 'ready', '/tmp/b.webm');
  const taken = queue.takeNextReady();

  assert.equal(taken.id, b.id);
  assert.equal(taken.file, '/tmp/b.webm');
  assert.deepEqual(queue.tracks.map((t) => t.title), ['a']);
});

test('remove deletes by id and reports missing ids', () => {
  const queue = new Queue({ maxLength: 10 });
  const a = queue.add(info('a'));
  assert.equal(queue.remove(a.id).id, a.id);
  assert.equal(queue.remove(a.id), undefined);
  assert.equal(queue.tracks.length, 0);
});
