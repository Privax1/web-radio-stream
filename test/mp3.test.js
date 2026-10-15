import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameSplitter, frameLength } from '../server/mp3.js';

// MPEG-1 Layer III, 128 kbps, 44.1 kHz header; padding bit toggles 417/418 bytes.
const frame = (padding, fill) => {
  const length = 417 + padding;
  const buf = Buffer.alloc(length, fill);
  buf.set([0xff, 0xfb, 0x90 | (padding << 1), 0x64]);
  return buf;
};

test('frameLength reads 128k/44.1k frame sizes and rejects non-headers', () => {
  assert.equal(frameLength(frame(0, 1), 0), 417);
  assert.equal(frameLength(frame(1, 1), 0), 418);
  assert.equal(frameLength(Buffer.from([0x00, 0xfb, 0x90, 0x64]), 0), 0);
  assert.equal(frameLength(Buffer.from([0xff, 0xfb]), 0), 0);
});

test('splitter reassembles frames across arbitrary chunk boundaries', () => {
  const stream = Buffer.concat([frame(0, 1), frame(1, 2), frame(0, 3)]);
  const splitter = new FrameSplitter();
  const frames = [];
  for (let i = 0; i < stream.length; i += 100) frames.push(...splitter.push(stream.subarray(i, i + 100)));
  assert.deepEqual(frames.map((f) => f.length), [417, 418, 417]);
  assert.deepEqual(frames.map((f) => f[10]), [1, 2, 3]);
});

test('splitter skips leading garbage to resync on a frame header', () => {
  const splitter = new FrameSplitter();
  const frames = splitter.push(Buffer.concat([Buffer.from([1, 2, 3]), frame(0, 7), frame(0, 8).subarray(0, 50)]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0][10], 7);
});
