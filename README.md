# Web Radio

A shared, self-hosted radio. Anyone with the link can queue YouTube songs, and everyone
hears the same live stream on their own device. It's an installable PWA with full
background playback and lock-screen and notification controls on Android.

## Run

```bash
docker compose up -d --build
```

Then open http://localhost:3000.

On a phone, open the site over HTTPS in Chrome and use **Add to Home screen**. After
installing, you can share a YouTube link from the YouTube app straight to "Radio" to
prefill it.

## Controls

| Action | Effect |
| --- | --- |
| Play / Pause | Only affects you. Resuming rejoins the live broadcast. |
| Skip (in the app or from the notification) | Skips the current song **for everyone**. |
| ✕ on a queued song | Removes it from the queue. |

## Configuration

Set these in `docker-compose.yml`:

| Variable | Default | |
| --- | --- | --- |
| `STATION_NAME` | `Web Radio` | Shown in the app and on the lock screen |
| `APP_PASSWORD` | *(empty)* | Set it to require a password (any username) |
| `ALLOWED_DOMAINS` | `youtube.com,youtu.be` | `*` allows any site yt-dlp supports |
| `BITRATE_KBPS` | `128` | Stream bitrate |
| `MAX_TRACK_SECONDS` | `1800` | Longest allowed track |
| `MAX_QUEUE_LENGTH` | `100` | |
| `BURST_SECONDS` | `2` | Startup buffer for new listeners (also their delay behind live) |

## HTTPS / reverse proxy

You need HTTPS for the PWA install, the service worker and lock-screen controls. With Caddy:

```
radio.example.com {
	reverse_proxy localhost:3000 {
		flush_interval -1
	}
}
```

If you use nginx, set `proxy_buffering off;` and `proxy_read_timeout 1d;`.

## When YouTube stops working

YouTube changes often. Rebuild the image to get the latest yt-dlp:

```bash
docker compose build --pull --no-cache && docker compose up -d
```
