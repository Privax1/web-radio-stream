import path from 'node:path';

const int = (name, fallback) => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
};

const list = (name, fallback) =>
  (process.env[name] ?? fallback)
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');

export const config = {
  port: int('PORT', 3000),
  stationName: process.env.STATION_NAME ?? 'Web Radio',
  // Optional shared password (HTTP Basic auth, any username). Empty = open access.
  appPassword: process.env.APP_PASSWORD ?? '',

  dataDir,
  cacheDir: path.join(dataDir, 'cache'),

  bitrateKbps: int('BITRATE_KBPS', 128),
  // Audio sent to a new listener immediately on connect. More = faster start, but more delay behind live.
  burstSeconds: int('BURST_SECONDS', 2),

  maxQueueLength: int('MAX_QUEUE_LENGTH', 100),
  maxTrackSeconds: int('MAX_TRACK_SECONDS', 30 * 60),
  // Hostnames (and their subdomains) that may be queued. Set to "*" to allow anything yt-dlp supports.
  allowedDomains: list('ALLOWED_DOMAINS', 'youtube.com,youtu.be'),

  ffmpegBin: process.env.FFMPEG_BIN ?? 'ffmpeg',
  ytdlpBin: process.env.YTDLP_BIN ?? 'yt-dlp',
  ytdlpExtraArgs: (process.env.YTDLP_EXTRA_ARGS ?? '').split(/\s+/).filter(Boolean),
};
