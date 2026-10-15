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
| Timeline slider, "jump to" time | Moves the song **for everyone**. Also works from the lock screen. |
| Volume slider / mute | Only affects you. Remembered on your device (not supported on iOS). |
| ✕ on a queued song | Removes it from the queue. |

Station-wide changes (skip, seek, host pause and resume) are heard by everyone almost
immediately.

### Host mode

Set `ADMIN_PASSWORD` to turn on host mode. A **Host** button then appears at the top. After
logging in, the host can switch on **"My play/pause controls everyone"**. With that on, the
host's play/pause button and lock-screen controls pause and resume the whole station. While
it's paused, listeners stay connected, hear silence, and see "Paused by the host". If the
host gets a phone call, only their own playback pauses.

Set `HOST_ONLY_CONTROLS=true` to also restrict skipping, seeking and removing songs to the
host.

## Configuration

Set these in `docker-compose.yml`:

| Variable | Default | |
| --- | --- | --- |
| `STATION_NAME` | `Web Radio` | Shown in the app and on the lock screen |
| `APP_PASSWORD` | *(empty)* | Set it to require a password (any username) |
| `ADMIN_PASSWORD` | *(empty)* | Host password. Turns on host mode (see above) |
| `HOST_ONLY_CONTROLS` | `false` | `true`: only the host can skip, seek and remove songs |
| `ALLOWED_DOMAINS` | `youtube.com,youtu.be` | `*` allows any site yt-dlp supports |
| `BITRATE_KBPS` | `128` | Stream bitrate |
| `MAX_TRACK_SECONDS` | `1800` | Longest allowed track |
| `MAX_QUEUE_LENGTH` | `100` | |
| `BURST_SECONDS` | `2` | Audio sent at once when someone joins or after skip, seek or pause, so playback starts instantly |

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
