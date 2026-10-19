import { execFile } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express from 'express';
import { Broadcaster } from './broadcaster.js';
import { config } from './config.js';
import { Queue, QueueFullError } from './queue.js';
import { Station } from './station.js';
import { isAllowedUrl, parseName, parseTrackUrl, ValidationError } from './validate.js';
import { YtDlp } from './ytdlp.js';

const execFileAsync = promisify(execFile);
const publicDir =path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// The queue lives in memory, so cached files from a previous run are orphans.
await rm(config.cacheDir, { recursive: true, force: true });
await mkdir(config.cacheDir, { recursive: true });

const queue = new Queue({ maxLength: config.maxQueueLength });
const broadcaster = new Broadcaster(config);
const ytdlp = new YtDlp({
  bin: config.ytdlpBin,
  extraArgs: config.ytdlpExtraArgs,
  maxTrackSeconds: config.maxTrackSeconds,
});
const station = new Station({
  queue,
  broadcaster,
  ytdlp,
  cacheDir: config.cacheDir,
  stationName: config.stationName,
  liveDelayMs: config.burstSeconds * 1000,
  historyLength: config.historyLength,
});

// --- Server-sent events: push the full state to every open page on each change ---

const eventClients = new Set();
let broadcastScheduled = false;

const publicState = () => ({
  ...station.state(),
  host: { enabled: Boolean(config.adminPassword), onlyControls: config.hostOnlyControls },
});

function sendState(res) {
  res.write(`data: ${JSON.stringify(publicState())}\n\n`);
}

station.on('change', () => {
  if (broadcastScheduled) return;
  broadcastScheduled = true;
  setImmediate(() => {
    broadcastScheduled = false;
    for (const res of eventClients) sendState(res);
  });
});

setInterval(() => {
  for (const res of eventClients) res.write(': ping\n\n');
}, 25_000).unref();

// --- HTTP ---

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.get('/healthz', (_req, res) => res.send('ok'));

if (config.appPassword) app.use(basicAuth(config.appPassword));

app.use(express.json({ limit: '10kb' }));

app.get('/stream', (req, res) => broadcaster.attach(req, res));

app.get('/api/state', (_req, res) => res.json(publicState()));

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  sendState(res);
  eventClients.add(res);
  req.on('close', () => eventClients.delete(res));
});

// Adds a single track or, for playlist links, every usable entry of the playlist.
app.post('/api/queue', async (req, res) => {
  const url = parseTrackUrl(req.body?.url, config.allowedDomains);
  const addedBy = parseName(req.body?.name);
  const free = queue.maxLength - queue.tracks.length;
  if (free <= 0) throw new QueueFullError(`The queue is full (${queue.maxLength} tracks).`);

  const result = await ytdlp.resolve(url, {
    wholePlaylist: req.body?.playlist === true,
    maxEntries: Math.min(config.maxPlaylistLength, free),
    allowUrl: (entryUrl) => isAllowedUrl(entryUrl, config.allowedDomains),
  });

  const added = [];
  for (const info of result.tracks) {
    try {
      added.push(queue.add({ ...info, addedBy }));
    } catch (err) {
      if (err instanceof QueueFullError) break; // filled up while we were looking it up
      throw err;
    }
  }
  if (added.length === 0) {
    throw new ValidationError(
      result.playlist ? 'None of the tracks in that playlist could be added.' : 'The queue is full.',
    );
  }

  const by = addedBy ? ` (by ${addedBy})` : '';
  if (result.playlist) {
    console.log(`[api] queued ${added.length} tracks from playlist "${result.playlist}"${by}`);
  } else {
    console.log(`[api] queued "${added[0].title}"${by}`);
  }
  res.status(201).json({
    id: added[0].id,
    title: added[0].title,
    playlist: result.playlist,
    added: added.length,
    skipped: result.tracks.length - added.length + result.skipped,
  });
});

// --- Host (admin) ---
// The host logs in once with ADMIN_PASSWORD and gets a token derived from it, sent back in
// the X-Host-Token header. Changing the password invalidates all tokens.

const hostToken = config.adminPassword
  ? createHmac('sha256', config.adminPassword).update('web-radio-host').digest('hex')
  : null;

const isHost = (req) => Boolean(hostToken) && safeEqual(req.get('x-host-token') ?? '', hostToken);

function requireHost(req, res, next) {
  if (isHost(req)) return next();
  res.status(403).json({ error: 'Only the host can do that.' });
}

// Skip, seek and remove: open to everyone unless HOST_ONLY_CONTROLS is set.
const requireControl = config.hostOnlyControls ? requireHost : (_req, _res, next) => next();

app.post('/api/host/login', async (req, res) => {
  if (hostToken && safeEqual(String(req.body?.password ?? ''), config.adminPassword)) {
    return res.json({ token: hostToken });
  }
  await new Promise((resolve) => setTimeout(resolve, 1000)); // slow down guessing
  res.status(403).json({ error: hostToken ? 'Wrong password.' : 'Host mode is not enabled.' });
});

app.get('/api/host/check', requireHost, (_req, res) => res.json({ ok: true }));

app.post('/api/pause', requireHost, (_req, res) => res.json({ changed: station.pause() }));
app.post('/api/resume', requireHost, (_req, res) => res.json({ changed: station.resume() }));

// --- Playback controls ---

app.delete('/api/queue/:id', requireControl, (req, res) => {
  if (!station.remove(req.params.id)) return res.status(404).json({ error: 'Track not found.' });
  res.status(204).end();
});

app.post('/api/skip', requireControl, (req, res) => {
  res.json({ skipped: station.skip(req.body?.id) });
});

app.post('/api/seek', requireControl, (req, res) => {
  const position = Number(req.body?.position);
  if (!Number.isFinite(position)) throw new ValidationError('Invalid position.');
  res.json({ seeked: station.seek(req.body?.id, position) });
});

app.use(
  express.static(publicDir, {
    setHeaders(res, file) {
      // The service worker and app shell must revalidate so updates roll out promptly.
      if (/\.(html|js|css|webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

app.use((err, _req, res, _next) => {
  if (err instanceof ValidationError || err instanceof QueueFullError) {
    return res.status(400).json({ error: err.message });
  }
  console.error('[api] unexpected error', err);
  res.status(500).json({ error: 'Something went wrong.' });
});

/** Constant-time string comparison. */
function safeEqual(a, b) {
  const digest = (s) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function basicAuth(password) {
  return (req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const [, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
      if (safeEqual(rest.join(':'), password)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="radio", charset="UTF-8"');
    res.status(401).send('Authentication required');
  };
}

// --- Startup / shutdown ---

if (config.hostOnlyControls && !config.adminPassword) {
  console.warn('[server] HOST_ONLY_CONTROLS is set without ADMIN_PASSWORD: nobody can skip or seek.');
}

await checkBinaries();

station.start();
const server = app.listen(config.port, () => {
  console.log(`[server] ${config.stationName} listening on http://localhost:${config.port}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] port ${config.port} is already in use (is the Docker container running?). Set PORT to use another one.`);
    process.exit(1);
  }
  throw err;
});

/** Warns once at startup if ffmpeg or yt-dlp are missing, instead of failing on every use. */
async function checkBinaries() {
  const binaries = [
    ['ffmpeg', config.ffmpegBin, ['-version'], 'FFMPEG_BIN'],
    ['yt-dlp', config.ytdlpBin, ['--version'], 'YTDLP_BIN'],
  ];
  for (const [name, bin, args, envVar] of binaries) {
    try {
      await execFileAsync(bin, args, { timeout: 10_000 });
    } catch (err) {
      console.error(
        `[server] ${name} is not usable ("${bin}": ${err.code ?? err.message}). ` +
          `Install it, set ${envVar}, or run with Docker (docker compose up), which includes it.`,
      );
    }
  }
}

function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down`);
  station.stop();
  for (const res of eventClients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
