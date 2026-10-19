import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAllowedUrl, ValidationError } from '../server/validate.js';
import { YtDlp } from '../server/ytdlp.js';

const domains = ['youtube.com', 'youtu.be', 'soundcloud.com'];
const allowUrl = (url) => isAllowedUrl(url, domains);

/** A YtDlp whose JSON lookups come from `responses` (keyed by URL) instead of yt-dlp. */
function fakeYtDlp(responses) {
  const ytdlp = new YtDlp({ bin: 'nonexistent', maxTrackSeconds: 600 });
  ytdlp.calls = [];
  ytdlp.runJson = async (args) => {
    ytdlp.calls.push(args);
    const url = args.at(-1);
    if (!(url in responses)) throw new Error('not found');
    return responses[url];
  };
  return ytdlp;
}

test('resolve returns a single track for a plain link', async () => {
  const ytdlp = fakeYtDlp({
    'https://soundcloud.com/a/song': {
      title: 'Song', duration: 200, uploader: 'A', thumbnail: 'https://i1.sndcdn.com/x.jpg',
      webpage_url: 'https://soundcloud.com/a/song',
    },
  });
  const result = await ytdlp.resolve('https://soundcloud.com/a/song', { maxEntries: 50, allowUrl });
  assert.equal(result.playlist, null);
  assert.deepEqual(result.tracks, [{
    url: 'https://soundcloud.com/a/song', title: 'Song', duration: 200,
    thumbnail: 'https://i1.sndcdn.com/x.jpg', uploader: 'A',
  }]);
  assert.ok(ytdlp.calls[0].includes('--no-playlist'));
  assert.ok(ytdlp.calls[0].includes('1:50'));
});

test('resolve rejects unusable single tracks with a ValidationError', async () => {
  const ytdlp = fakeYtDlp({
    'https://youtu.be/long': { title: 'Long', duration: 9999 },
    'https://youtu.be/live': { title: 'Live', live_status: 'is_live' },
  });
  for (const url of ['https://youtu.be/long', 'https://youtu.be/live', 'https://youtu.be/missing']) {
    await assert.rejects(ytdlp.resolve(url, { maxEntries: 5, allowUrl }), ValidationError, url);
  }
});

test('resolve expands a playlist, looks up incomplete entries and skips bad ones', async () => {
  const ytdlp = fakeYtDlp({
    'https://soundcloud.com/a/sets/mix': {
      _type: 'playlist',
      title: 'Mix',
      entries: [
        // YouTube-style flat entry: complete, no extra lookup
        { url: 'https://www.youtube.com/watch?v=1', title: 'One', duration: 60,
          thumbnails: [{ url: 'https://i.ytimg.com/small.jpg' }, { url: 'https://i.ytimg.com/big.jpg' }] },
        // SoundCloud-style flat entry: only a URL, needs a lookup
        { url: 'https://api-v2.soundcloud.com/tracks/2' },
        // unavailable
        { url: 'https://api-v2.soundcloud.com/tracks/3' },
        // not on the allowlist
        { url: 'https://evil.example/track', title: 'Evil', duration: 10 },
        // too long
        { url: 'https://www.youtube.com/watch?v=5', title: 'Five', duration: 5000 },
        null,
      ],
    },
    'https://api-v2.soundcloud.com/tracks/2': {
      title: 'Two', duration: 120, webpage_url: 'https://soundcloud.com/a/two',
    },
  });

  const result = await ytdlp.resolve('https://soundcloud.com/a/sets/mix', { maxEntries: 50, allowUrl });

  assert.equal(result.playlist, 'Mix');
  assert.deepEqual(result.tracks.map((t) => t.title), ['One', 'Two']);
  assert.equal(result.tracks[0].thumbnail, 'https://i.ytimg.com/big.jpg');
  assert.equal(result.tracks[1].url, 'https://soundcloud.com/a/two');
  assert.equal(result.skipped, 3);
  assert.ok(!ytdlp.calls.some((args) => args.at(-1) === 'https://evil.example/track'));
});

test('resolve takes the whole playlist only when asked, and respects maxEntries', async () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({
    url: `https://www.youtube.com/watch?v=${i}`, title: `T${i}`, duration: 30,
  }));
  const ytdlp = fakeYtDlp({ 'https://www.youtube.com/watch?v=0&list=PL1': { _type: 'playlist', entries } });

  const result = await ytdlp.resolve('https://www.youtube.com/watch?v=0&list=PL1', {
    wholePlaylist: true, maxEntries: 3, allowUrl,
  });

  assert.ok(ytdlp.calls[0].includes('--yes-playlist'));
  assert.deepEqual(result.tracks.map((t) => t.title), ['T0', 'T1', 'T2']);
});
