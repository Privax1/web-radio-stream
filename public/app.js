// Web Radio client: plays the shared live stream and mirrors server state.
//
// Playback model (radio-like):
// - Everyone hears the same live MP3 stream from /stream.
// - Pause is personal. Resuming reconnects, so you rejoin live instead of falling behind.
// - Skip is shared: it moves the whole station to the next track.
// - The Media Session API provides the Android notification / lock-screen controls.

const $ = (selector) => document.querySelector(selector);

const audio = $('#audio');
const playBtn = $('#play');
const skipBtn = $('#skip');
const nameInput = $('#name');

let state = null;
let clockOffset = 0; // serverTime - Date.now()
let wantPlaying = false;
let reconnectTimer = null;
let reconnectDelay = 1000;
let shownTrack = null; // what the UI shows as "now playing" (lags the server while listening)
let pendingTrackId;
let nowPlayingTimer = null;

// --- Server state (SSE) ---

function connectEvents() {
  const events = new EventSource('/api/events');
  events.onopen = () => setConnection('live', 'live');
  events.onmessage = (e) => applyState(JSON.parse(e.data));
  events.onerror = () => setConnection('offline', 'reconnecting…');
}

function setConnection(kind, label) {
  const pill = $('#connection');
  pill.dataset.state = kind;
  pill.textContent = label;
}

function applyState(next) {
  const first = state === null;
  state = next;
  clockOffset = next.serverTime - Date.now();

  document.title = next.stationName;
  $('#station-name').textContent = next.stationName;
  const n = next.listeners;
  $('#listeners').textContent = n === 1 ? '1 listener' : `${n} listeners`;
  renderQueue(next.queue);

  // While listening, audio reaches us ~liveDelayMs after the server sends it. Delay the
  // track change by the same amount so the screen matches what you actually hear.
  const trackId = next.nowPlaying?.id ?? null;
  if (trackId !== pendingTrackId) {
    pendingTrackId = trackId;
    clearTimeout(nowPlayingTimer);
    const delay = first || !wantPlaying ? 0 : next.liveDelayMs;
    nowPlayingTimer = setTimeout(() => setNowPlaying(next.nowPlaying), delay);
  }
}

// --- Now playing ---

function setNowPlaying(track) {
  shownTrack = track;
  skipBtn.disabled = !track;

  const img = $('#cover-img');
  if (track?.thumbnail) {
    img.src = track.thumbnail;
    img.hidden = false;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
  }

  $('#now-title').textContent = track ? track.title : 'Nothing yet';
  $('#now-sub').textContent = track
    ? [track.uploader, track.addedBy && `added by ${track.addedBy}`].filter(Boolean).join(' · ')
    : 'Add a song below to get the radio going.';
  $('#duration').textContent = formatTime(track?.duration ?? 0);

  updateMediaMetadata(track);
  updateProgress();
}

function elapsedSeconds(track) {
  const lag = wantPlaying ? state.liveDelayMs : 0;
  const ms = Date.now() + clockOffset - track.startedAt - lag;
  return Math.min(Math.max(ms / 1000, 0), track.duration);
}

function updateProgress() {
  const track = shownTrack;
  const elapsed = track ? elapsedSeconds(track) : 0;
  $('#elapsed').textContent = formatTime(elapsed);
  $('#progress-fill').style.width = track ? `${(elapsed / track.duration) * 100}%` : '0';
}

function formatTime(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// --- Playback ---

function play() {
  wantPlaying = true;
  clearTimeout(reconnectTimer);
  // A fresh URL forces a new connection, so we always start at the live edge.
  audio.src = `/stream?t=${Date.now()}`;
  audio.play().catch((err) => {
    console.warn('play() failed', err);
    if (err.name === 'NotAllowedError') {
      wantPlaying = false;
      updatePlayState();
    }
  });
  updatePlayState();
}

function pause() {
  wantPlaying = false;
  clearTimeout(reconnectTimer);
  // Keep the src so Android keeps the media notification (and its play button) around.
  // The server drops the idle connection after a while; play() reconnects anyway.
  audio.pause();
  updatePlayState();
}

function scheduleReconnect() {
  if (!wantPlaying) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(play, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
}

audio.addEventListener('playing', () => {
  reconnectDelay = 1000;
});
audio.addEventListener('error', scheduleReconnect);
audio.addEventListener('ended', scheduleReconnect);
// The OS can pause us (e.g. a phone call). Mirror that instead of fighting it.
// (audio.paused is re-checked because swapping src in play() can queue a stale 'pause'.)
audio.addEventListener('pause', () => {
  if (wantPlaying && audio.paused && !audio.error && !audio.ended) {
    wantPlaying = false;
    updatePlayState();
  }
});

function updatePlayState() {
  playBtn.classList.toggle('playing', wantPlaying);
  playBtn.setAttribute('aria-label', wantPlaying ? 'Pause' : 'Play');
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = wantPlaying ? 'playing' : 'paused';
  }
  updateProgress();
  updatePositionState();
}

async function skip() {
  if (!shownTrack) return;
  skipBtn.disabled = true;
  try {
    await api('POST', '/api/skip', { id: state?.nowPlaying?.id });
  } finally {
    skipBtn.disabled = !shownTrack;
  }
}

playBtn.addEventListener('click', () => (wantPlaying ? pause() : play()));
skipBtn.addEventListener('click', skip);

// --- Media Session (notification + lock-screen controls) ---

function updateMediaMetadata(track) {
  if (!('mediaSession' in navigator)) return;
  const stationName = state?.stationName ?? 'Web Radio';
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track ? track.title : 'Waiting for the next song…',
    artist: track?.uploader ?? stationName,
    album: stationName,
    artwork: track?.thumbnail
      ? [{ src: track.thumbnail }]
      : [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
  updatePositionState();
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  try {
    if (shownTrack && wantPlaying) {
      navigator.mediaSession.setPositionState({
        duration: shownTrack.duration,
        position: elapsedSeconds(shownTrack),
        playbackRate: 1,
      });
    } else {
      navigator.mediaSession.setPositionState();
    }
  } catch (err) {
    console.debug('setPositionState failed', err);
  }
}

if ('mediaSession' in navigator) {
  const handlers = { play, pause, stop: pause, nexttrack: skip };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, () => handler());
    } catch {
      // Action not supported by this browser.
    }
  }
}

// --- Queue ---

const removeIcon =
  '<svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg>';

function renderQueue(tracks) {
  const list = $('#queue-list');
  list.replaceChildren(
    ...tracks.map((track) => {
      const li = document.createElement('li');

      const thumb = document.createElement(track.thumbnail ? 'img' : 'div');
      thumb.className = 'thumb';
      if (track.thumbnail) {
        thumb.src = track.thumbnail;
        thumb.alt = '';
        thumb.loading = 'lazy';
      }

      const text = document.createElement('div');
      text.style.minWidth = '0';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = track.title;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = [
        formatTime(track.duration),
        track.status === 'ready' ? null : track.status === 'downloading' ? 'loading…' : 'waiting',
        track.addedBy && `by ${track.addedBy}`,
      ]
        .filter(Boolean)
        .join(' · ');
      text.append(title, meta);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.setAttribute('aria-label', `Remove ${track.title}`);
      remove.innerHTML = removeIcon;
      remove.addEventListener('click', () => api('DELETE', `/api/queue/${track.id}`));

      li.append(thumb, text, remove);
      return li;
    }),
  );
  $('#queue-count').textContent = tracks.length ? `(${tracks.length})` : '';
  $('#queue-empty').hidden = tracks.length > 0;
}

// --- Adding songs ---

try {
  nameInput.value = localStorage.getItem('name') ?? '';
} catch {}
nameInput.addEventListener('change', () => {
  try {
    localStorage.setItem('name', nameInput.value.trim());
  } catch {}
});

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const urlInput = $('#url');
  const button = $('#add-btn');
  button.disabled = true;
  showMessage('Looking it up…');
  try {
    const track = await api('POST', '/api/queue', { url: urlInput.value, name: nameInput.value });
    showMessage(`Added “${track.title}”.`);
    urlInput.value = '';
  } catch (err) {
    showMessage(err.message, true);
  } finally {
    button.disabled = false;
  }
});

function showMessage(text, isError = false) {
  const el = $('#message');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// Android "share to" target: /?url=... (see share_target in the manifest).
const shared = new URLSearchParams(location.search);
const sharedUrl = shared.get('url') || shared.get('text')?.match(/https?:\/\/\S+/)?.[0];
if (sharedUrl) {
  $('#url').value = sharedUrl;
  history.replaceState(null, '', '/');
}

// --- Helpers & startup ---

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

setInterval(updateProgress, 1000);
// Keep the lock-screen progress bar honest after clock drift / stream hiccups.
setInterval(updatePositionState, 15_000);

connectEvents();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('SW registration failed', err));
}
