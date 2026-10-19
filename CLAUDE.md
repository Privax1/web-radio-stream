# CLAUDE.md

This file guides Claude Code (claude.ai/code) when working in this repository.

## What this is

A self-hosted "shared radio". Anyone with the link can queue YouTube videos and SoundCloud
tracks, single songs or whole playlists. The server
downloads the audio and broadcasts one continuous live MP3 stream, so every listener hears
the same position. The frontend is an installable PWA. It uses a plain `<audio>` element plus
the Media Session API, so on Android it behaves like a music app: it keeps playing in the
background and shows notification and lock-screen controls.

## Commands

```bash
npm install            # deps (only express)
npm run dev            # node --watch; needs ffmpeg + yt-dlp on PATH locally
npm test               # node:test unit tests (test/*.test.js)
docker compose up -d --build   # the normal way to run it
docker compose build --pull --no-cache   # also updates yt-dlp (do this when YouTube breaks)
```

The local dev server listens on http://localhost:3000. For the PWA, service worker and Media
Session you need `localhost` or HTTPS.

## Stack

- Node.js 22, ES modules, **no build step and no TypeScript**. Types are documented with JSDoc where useful.
- Express 5 is the only runtime dependency. Keep it that way unless there is a strong reason.
- External binaries: `yt-dlp` (metadata + audio download) and `ffmpeg` (real-time MP3 encoding).
  Both are installed in the Docker image. In Docker, yt-dlp uses Node as its JS runtime
  (`YTDLP_EXTRA_ARGS="--js-runtimes node"`), which YouTube extraction requires.
- The frontend is vanilla JS/HTML/CSS in `public/`, served statically. No framework, no bundler.

## Architecture

```
server/
  index.js        HTTP routes, SSE fan-out, optional basic auth, startup/shutdown
  config.js       all env-var config (single source of truth)
  station.js      orchestrator: download worker + play loop + public state()
  broadcaster.js  one ffmpeg "source" at a time -> fanned out to all /stream listeners
  queue.js        in-memory ordered track list (pure, unit-tested)
  ytdlp.js        yt-dlp wrapper (resolve: track or playlist, fetchInfo, downloadAudio)
  validate.js     URL / name validation (pure, unit-tested)
  mp3.js          MP3 frame splitter used for frame-aligned pacing (pure, unit-tested)
public/
  index.html, style.css, app.js   the whole UI
  sw.js                           app-shell cache (network-first)
  manifest.webmanifest, icons/    PWA install + Android share target
```

Flow:
1. `POST /api/queue {url, name, playlist?}` takes the first link in `url` (`extractUrl`, so
   pasted share text like "Listen to X on #SoundCloud https://…" works; the client also
   trims the field to the link on paste), validates it (domain allowlist) and calls
   `YtDlp#resolve`: `yt-dlp -J --flat-playlist` for title/duration. A single track is
   appended as `pending`. For a playlist (YouTube list, SoundCloud set) every usable entry is
   appended, up to `MAX_PLAYLIST_LENGTH` and the free queue space. Entries without title or
   duration (SoundCloud flat entries) are looked up one by one, 4 at a time. Entry URLs must
   also pass the allowlist; bad entries are skipped and counted. A YouTube link that is both
   a video and a list (`watch?v=…&list=…`) adds only the video unless `playlist: true`.
2. `Station#downloadNext` downloads queued tracks **one at a time** to `DATA_DIR/cache/<id>.<ext>`
   (`pending → downloading → ready`). Failed downloads are dropped from the queue.
3. `Station#loop` takes the first `ready` track and `#playTrack` calls
   `broadcaster.playFile(file, offset)` (`ffmpeg [-ss offset] … -f mp3 pipe:1`). When
   nothing is ready, or while the station is paused, it streams silence (`anullsrc`) via
   `#silenceUntil(predicate)`. The predicate is re-checked on every station `'change'`.
   Finished files are deleted. Finished or skipped tracks go to `station.history` (newest
   first, `playedAt` = start time, capped at `HISTORY_LENGTH`), shown as "Recently played"
   with a button to queue the track again.
   Station controls (`skip`, `seek`, `pause`, `resume`) set a flag and call `#cut()`. That
   cuts the broadcaster and bumps `epoch`. `#playTrack` then reads the flag to decide what to
   stream next: a restart at a new offset, silence, or the next track. The file stays
   cached until the track really ends.
4. `Broadcaster` paces audio itself. ffmpeg encodes ahead with no `-re`, limited by pipe
   backpressure. `server/mp3.js` splits the output into whole MP3 frames, and `#pace()`
   releases them at exactly the CBR bitrate to every `/stream` response. It keeps the last
   `BURST_SECONDS` of audio to send to new listeners so playback starts instantly. Listeners
   more than 1 MB behind (paused or dead) are disconnected.
   `cut()` drops the current source and the replay buffer, and gives the **next** source a
   lead: its first `BURST_SECONDS` are sent at once. `sourceLeadSeconds` exposes the lead so
   the station can shift `startedAt`.
5. `GET /api/events` (SSE) pushes the full `station.state()` on every change. Changes are
   coalesced per tick. The client renders only from this state.

`nowPlaying` timing: `startedAt` is the server time at which position 0 would have been at
the **live edge** (the last bytes sent), so the live position is `serverTime - startedAt`.
Listeners hear that minus their buffer. The client measures the buffer as
`audio.buffered.end - currentTime` (`streamLagMs()`). While paused, `startedAt` is `null`
and `position` is frozen. Clients correct for clock skew with `serverTime`.

HTTP API: `GET /stream`, `GET /api/state`, `GET /api/events`, `POST /api/queue`,
`GET /healthz` (unauthenticated).
- Controls (everyone, or host only with `HOST_ONLY_CONTROLS`): `DELETE /api/queue/:id`,
  `POST /api/skip {id}`, `POST /api/seek {id, position}`.
- Host: `POST /api/host/login {password}` → `{token}`, `GET /api/host/check`,
  `POST /api/pause`, `POST /api/resume`. These need the `X-Host-Token` header. The token
  is an HMAC of `ADMIN_PASSWORD`, so it stays valid across restarts and changing the
  password revokes it. A custom header is used because `Authorization` is taken by the
  optional basic auth.

## Design decisions (don't undo without discussing)

- **Radio semantics.** Skip and seek are global. They take the current track `id` so stale
  or simultaneous requests don't hit the wrong song. Pause is per listener: resuming sets a
  fresh `src`, so the listener rejoins live instead of falling behind.
- **Host pause is station-wide and opt-in.** A logged-in host with "link" on turns their
  play/pause button and lock-screen controls into `/api/pause` and `/api/resume`. The host's
  own audio keeps running on silence, so the notification stays alive for resuming. OS
  pauses (phone calls) are always local and never become a global pause. A paused station
  keeps streaming silence, so listeners stay connected. While paused, the client reports
  `mediaSession.playbackState = 'paused'`. Never pass `playbackRate: 0` to
  `setPositionState`, because it throws.
- **Controls are instant via reconnect.** On an `epoch` change, listening clients call
  `play()`, which sets a fresh `src`. This drops their ~1-2 s of buffered old audio. With
  the lead from `cut()`, the new audio starts in about 100-200 ms (measured: pause 70 ms,
  resume 200 ms, versus about 2.3 s before). A pause resumes `liveDelayMs` before the live
  edge, because listeners discard what they hadn't heard yet. That can repeat a moment of
  audio but never skips any. Don't put `-re` back in ffmpeg, and don't slice MP3 frames:
  Chrome needs about 6 s to detect a stream that starts mid-frame.
- **One continuous stream, not per-track files.** This is what keeps Android background
  playback and the media notification alive across track changes. Silence between tracks
  is intentional. ffmpeg runs with `-write_xing 0 -id3v2_version 0` so concatenated
  sources stay a valid MP3 stream.
- **The client never changes `src` on a natural track change.** Only controls (an `epoch`
  bump) trigger a reconnect. Track metadata comes via SSE and is shown `streamLagMs()` late
  while listening, so the lock screen matches what you hear.
- **`pause()` keeps the `src`.** Removing it would make Android drop the notification and
  its play button.
- **The service worker must never intercept `/stream` or `/api/*`.**
- **Cover images are optional per device.** The "Load cover images" switch (localStorage
  `showCovers`) stops the client from loading thumbnails at all (cover, lists and lock-screen
  artwork), which saves data and avoids requests to YouTube/SoundCloud image hosts.
- **State is in memory.** A restart clears the queue, and the cache dir is wiped on boot.
  That is acceptable for the MVP. If persistence is added, store the queue as JSON in `DATA_DIR`.
- **Security:** URLs go to yt-dlp after `--` (no option injection) and must match
  `ALLOWED_DOMAINS` (default: YouTube only; `*` opens it up, which allows yt-dlp to fetch
  arbitrary hosts and is an SSRF risk). `APP_PASSWORD` enables HTTP Basic auth for
  everything except `/healthz`. The manifest link uses `crossorigin="use-credentials"` so
  this works with the PWA.

## Configuration (env)

`PORT` (3000), `STATION_NAME`, `APP_PASSWORD`, `ADMIN_PASSWORD` (enables host mode),
`HOST_ONLY_CONTROLS` (false), `DATA_DIR` (./data, /data in Docker),
`BITRATE_KBPS` (128), `BURST_SECONDS` (2), `MAX_QUEUE_LENGTH` (100),
`MAX_TRACK_SECONDS` (1800), `MAX_PLAYLIST_LENGTH` (50), `HISTORY_LENGTH` (50),
`ALLOWED_DOMAINS` (youtube.com,youtu.be,soundcloud.com), `FFMPEG_BIN`,
`YTDLP_BIN`, `YTDLP_EXTRA_ARGS`. Add new settings to `server/config.js`, to the
commented list in `docker-compose.yml` and to this file.

## Conventions

- Keep modules small and dependency-free. Pure logic (queue, validation) gets unit tests in `test/`.
  `YtDlp#resolve` is tested with a faked `runJson` (`test/ytdlp.test.js`).
  Station control flow is tested with a `FakeBroadcaster` (`test/station.test.js`), with no
  ffmpeg needed. Extend it when you change `Station`.
- User-facing errors: throw `ValidationError` (→ 400 with `{error}`). Anything else is logged and returns a 500.
- Logs use a `[area]` prefix (`[station]`, `[api]`, `[ffmpeg]`, `[yt-dlp]`).
- Frontend: build DOM with `textContent` (never `innerHTML` with server data). Wrap
  `localStorage` in try/catch. When you change cached shell files in a way that needs a
  hard refresh, bump `CACHE` in `public/sw.js`.
- Verify streaming changes end to end: `docker compose up -d --build`, queue a short video
  (e.g. `https://youtu.be/jNQXAC9IVRw`), then `curl localhost:3000/stream -o x.mp3` and listen.

## Deployment notes

- Production needs HTTPS (service worker, PWA install and Media Session require it). Put a
  reverse proxy in front and **disable response buffering** for `/stream` and `/api/events`.
  For nginx use `proxy_buffering off;`; the server also sends `X-Accel-Buffering: no`.
  For Caddy use `reverse_proxy radio:3000 { flush_interval -1 }`.
- Disk use: only queued tracks are cached, roughly 1 MB per minute of audio.
