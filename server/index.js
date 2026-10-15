import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Broadcaster } from './broadcaster.js';
import { config } from './config.js';
import { Queue, QueueFullError } from './queue.js';
import { Station } from './station.js';
import { parseName, parseTrackUrl, ValidationError } from './validate.js';
import { YtDlp } from './ytdlp.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

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
});

// --- Server-sent events: push the full state to every open page on each change ---

const eventClients = new Set();
let broadcastScheduled = false;

function sendState(res) {
  res.write(`data: ${JSON.stringify(station.state())}\n\n`);
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

app.get('/api/state', (_req, res) => res.json(station.state()));

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

app.post('/api/queue', async (req, res) => {
  const url = parseTrackUrl(req.body?.url, config.allowedDomains);
  const addedBy = parseName(req.body?.name);
  const info = await ytdlp.fetchInfo(url);
  const track = queue.add({ ...info, addedBy });
  console.log(`[api] queued "${track.title}"${addedBy ? ` (by ${addedBy})` : ''}`);
  res.status(201).json({ id: track.id, title: track.title });
});

app.delete('/api/queue/:id', (req, res) => {
  if (!station.remove(req.params.id)) return res.status(404).json({ error: 'Track not found.' });
  res.status(204).end();
});

app.post('/api/skip', (req, res) => {
  const skipped = station.skip(req.body?.id);
  res.json({ skipped });
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

function basicAuth(password) {
  const digest = (s) => createHash('sha256').update(s).digest();
  const expected = digest(password);
  return (req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const [, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
      if (timingSafeEqual(digest(rest.join(':')), expected)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="radio", charset="UTF-8"');
    res.status(401).send('Authentication required');
  };
}

// --- Startup / shutdown ---

station.start();
const server = app.listen(config.port, () => {
  console.log(`[server] ${config.stationName} listening on http://localhost:${config.port}`);
});

function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down`);
  station.stop();
  for (const res of eventClients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
