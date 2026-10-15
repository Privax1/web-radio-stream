import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseName, parseTrackUrl, ValidationError } from '../server/validate.js';

const yt = ['youtube.com', 'youtu.be'];

test('accepts YouTube links including subdomains', () => {
  assert.equal(parseTrackUrl('https://youtu.be/abc', yt), 'https://youtu.be/abc');
  assert.equal(
    parseTrackUrl(' https://www.youtube.com/watch?v=abc ', yt),
    'https://www.youtube.com/watch?v=abc',
  );
  assert.ok(parseTrackUrl('https://music.youtube.com/watch?v=abc', yt));
});

test('rejects other hosts, look-alike hosts and non-http schemes', () => {
  for (const input of [
    'https://example.com/video',
    'https://notyoutube.com/watch?v=abc',
    'https://youtube.com.evil.net/watch',
    'file:///etc/passwd',
    '--exec=rm',
    '',
    42,
  ]) {
    assert.throws(() => parseTrackUrl(input, yt), ValidationError, String(input));
  }
});

test('"*" allows any http(s) host', () => {
  assert.ok(parseTrackUrl('https://soundcloud.com/a/b', ['*']));
  assert.throws(() => parseTrackUrl('ftp://x.org/a', ['*']), ValidationError);
});

test('parseName trims, truncates and drops empty names', () => {
  assert.equal(parseName('  Sam  '), 'Sam');
  assert.equal(parseName('x'.repeat(50)).length, 32);
  assert.equal(parseName('   '), null);
  assert.equal(parseName(undefined), null);
});
