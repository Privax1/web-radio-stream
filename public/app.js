// Web Radio client: plays the shared live stream and mirrors server state.
//
// Playback model (radio-like):
// - Everyone hears the same live MP3 stream from /stream.
// - Pause is personal. Resuming reconnects, so you rejoin live instead of falling behind.
//   Exception: a logged-in host with "link" on pauses/resumes the whole station instead.
// - Skip and seek are shared: they move the whole station.
// - The Media Session API provides the Android notification / lock-screen controls.

const $ = (selector) => document.querySelector(selector);

const audio = $('#audio');
const playBtn = $('#play');
const skipBtn = $('#skip');
const seekInput = $('#seek');
const volumeInput = $('#volume');
const muteBtn = $('#mute');
const nameInput = $('#name');

let state = null;
let clockOffset = 0; // serverTime - Date.now()
let wantPlaying = false;
let reconnectTimer = null;
let reconnectDelay = 1000;
let shownTrack = null; // what the UI shows as "now playing" (lags the server while listening)
let shownKey;
let nowPlayingTimer = null;
let dragging = false; // user is dragging the seek slider

let hostToken = load('hostToken');
let hostLinked = load('hostLinked') !== 'false';

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
  renderHost();

  // While listening, audio reaches us ~liveDelayMs after the server sends it. Delay track
  // changes, seeks and pauses by the same amount so the screen matches what you hear.
  const np = next.nowPlaying;
  const key = np ? `${np.id}|${np.startedAt}|${np.position}` : null;
  if (key !== shownKey) {
    shownKey = key;
    clearTimeout(nowPlayingTimer);
    const delay = first || !wantPlaying ? 0 : next.liveDelayMs;
    nowPlayingTimer = setTimeout(() => setNowPlaying(np), delay);
  }
  updateControls();
}

// --- Permissions ---

const isHost = () => Boolean(hostToken && state?.host.enabled);
const canControl = () => Boolean(state) && (!state.host.onlyControls || isHost());
const linked = () => isHost() && hostLinked;

// --- Now playing ---

function setNowPlaying(track) {
  const trackChanged = track?.id !== shownTrack?.id;
  shownTrack = track;

  if (trackChanged) {
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
    seekInput.max = String(Math.floor(track?.duration ?? 0));
    updateMediaMetadata(track);
  }

  updateControls();
  updateProgress();
  updatePositionState();
}

/** Position in seconds of what this listener hears right now. */
function elapsedSeconds(track) {
  if (track.startedAt === null) return track.position; // station paused
  const lag = wantPlaying ? state.liveDelayMs : 0;
  const ms = Date.now() + clockOffset - track.startedAt - lag;
  return Math.min(Math.max(ms / 1000, 0), track.duration);
}

function updateProgress() {
  const track = shownTrack;
  const elapsed = track ? elapsedSeconds(track) : 0;
  if (!dragging) {
    $('#elapsed').textContent = formatTime(elapsed);
    seekInput.value = String(Math.floor(elapsed));
  }
}

function updateControls() {
  const control = canControl() && Boolean(shownTrack);
  for (const el of [skipBtn, seekInput]) el.disabled = !control;
  $('#jump-form').hidden = !control;

  const eyebrow = $('#now-eyebrow');
  eyebrow.textContent = state?.paused ? 'Paused by the host' : 'Now playing';
  eyebrow.classList.toggle('paused', Boolean(state?.paused));

  const playing = showsPlaying();
  playBtn.classList.toggle('playing', playing);
  playBtn.setAttribute(
    'aria-label',
    linked() ? (playing ? 'Pause for everyone' : 'Play for everyone') : playing ? 'Pause' : 'Play',
  );
  if ('mediaSession' in navigator) {
    // A paused station still streams silence, but the lock screen should show it as paused.
    navigator.mediaSession.playbackState = playing && !state?.paused ? 'playing' : 'paused';
  }
  updateActionHandlers();
}

/** What the play/pause button shows. A linked host sees the station's state. */
function showsPlaying() {
  return linked() ? wantPlaying && !state.paused : wantPlaying;
}

function formatTime(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Parses "83", "1:23" or "1:02:03" into seconds; NaN if invalid. */
function parseTime(text) {
  const parts = text.trim().split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return NaN;
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}

// --- Local playback ---

function play() {
  wantPlaying = true;
  clearTimeout(reconnectTimer);
  // A fresh URL forces a new connection, so we always start at the live edge.
  audio.src = `/stream?t=${Date.now()}`;
  audio.play().catch((err) => {
    console.warn('play() failed', err);
    if (err.name === 'NotAllowedError') {
      wantPlaying = false;
      updateControls();
    }
  });
  updateControls();
  updateProgress();
  updatePositionState();
}

function pause() {
  wantPlaying = false;
  clearTimeout(reconnectTimer);
  // Keep the src so Android keeps the media notification (and its play button) around.
  // The server drops the idle connection after a while; play() reconnects anyway.
  audio.pause();
  updateControls();
  updateProgress();
  updatePositionState();
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
// The OS can pause us (e.g. a phone call). Mirror that locally instead of fighting it;
// never turn it into a station-wide pause.
// (audio.paused is re-checked because swapping src in play() can queue a stale 'pause'.)
audio.addEventListener('pause', () => {
  if (wantPlaying && audio.paused && !audio.error && !audio.ended) {
    wantPlaying = false;
    updateControls();
  }
});

// --- Play/pause button (local, or station-wide for a linked host) ---

function onPlay() {
  if (!linked()) return play();
  if (state.paused) hostApi('POST', '/api/resume');
  if (!wantPlaying) play();
}

function onPause() {
  if (!linked()) return pause();
  // Keep our own stream running: silence keeps the notification alive for resuming.
  hostApi('POST', '/api/pause');
}

playBtn.addEventListener('click', () => (showsPlaying() ? onPause() : onPlay()));

// --- Station-wide controls ---

async function skip() {
  if (!shownTrack || !canControl()) return;
  skipBtn.disabled = true;
  try {
    await api('POST', '/api/skip', { id: state?.nowPlaying?.id });
  } catch (err) {
    showMessage(err.message, true);
  } finally {
    updateControls();
  }
}

async function seekTo(seconds) {
  const track = shownTrack;
  if (!track || !canControl() || !Number.isFinite(seconds)) return;
  const position = Math.min(Math.max(seconds, 0), track.duration);
  try {
    await api('POST', '/api/seek', { id: track.id, position });
  } catch (err) {
    showMessage(err.message, true);
  }
}

skipBtn.addEventListener('click', skip);

seekInput.addEventListener('input', () => {
  dragging = true;
  $('#elapsed').textContent = formatTime(Number(seekInput.value));
});
seekInput.addEventListener('change', () => {
  dragging = false;
  seekTo(Number(seekInput.value));
});

$('#jump-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#jump');
  const seconds = parseTime(input.value);
  if (Number.isNaN(seconds) || !shownTrack || seconds > shownTrack.duration) {
    showMessage('Enter a time within the track, like 1:23.', true);
    return;
  }
  input.value = '';
  input.blur();
  seekTo(seconds);
});

// --- Volume (personal, remembered per device) ---
// Note: iOS ignores audio.volume; there the hardware buttons are the only volume control.

function setVolume(volume, muted) {
  audio.volume = volume;
  audio.muted = muted;
  volumeInput.value = String(muted ? 0 : volume);
  muteBtn.classList.toggle('muted', muted || volume === 0);
  muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  save('volume', String(volume));
  save('muted', String(muted));
}

volumeInput.addEventListener('input', () => {
  const volume = Number(volumeInput.value);
  setVolume(volume, volume === 0);
});
muteBtn.addEventListener('click', () => {
  // Unmuting from zero restores an audible level.
  const volume = audio.volume || 0.5;
  setVolume(volume, !audio.muted && audio.volume > 0);
});

{
  const stored = Number(load('volume') ?? 1);
  setVolume(Number.isFinite(stored) ? Math.min(Math.max(stored, 0), 1) : 1, load('muted') === 'true');
}

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

let handlersKey;

/** Registers lock-screen actions. Seek/skip only appear for people allowed to use them. */
function updateActionHandlers() {
  if (!('mediaSession' in navigator)) return;
  const control = canControl();
  if (handlersKey === control) return;
  handlersKey = control;

  const handlers = {
    play: onPlay,
    pause: onPause,
    stop: pause,
    nexttrack: control ? skip : null,
    seekto: control ? (d) => seekTo(d.seekTime) : null,
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler && ((details) => handler(details)));
    } catch {
      // Action not supported by this browser.
    }
  }
}

// --- Host ---

function renderHost() {
  const enabled = Boolean(state?.host.enabled);
  const hostBtn = $('#host-btn');
  hostBtn.hidden = !enabled;
  hostBtn.classList.toggle('active', isHost());
  hostBtn.textContent = isHost() ? 'Host ✓' : 'Host';
  $('#host-panel').hidden = !isHost();
  $('#host-link').checked = hostLinked;
}

$('#host-btn').addEventListener('click', async () => {
  if (isHost()) {
    $('#host-panel').hidden = !$('#host-panel').hidden;
    return;
  }
  const password = prompt('Host password');
  if (!password) return;
  try {
    const { token } = await api('POST', '/api/host/login', { password });
    hostToken = token;
    save('hostToken', token);
    showMessage('You are now the host.');
  } catch (err) {
    showMessage(err.message, true);
  }
  refreshPermissions();
});

$('#host-link').addEventListener('change', (e) => {
  hostLinked = e.target.checked;
  save('hostLinked', String(hostLinked));
  updateControls();
});

$('#host-logout').addEventListener('click', logoutHost);

function logoutHost() {
  hostToken = null;
  save('hostToken', null);
  refreshPermissions();
}

function refreshPermissions() {
  if (!state) return;
  renderHost();
  renderQueue(state.queue);
  updateControls();
}

async function hostApi(method, url, body) {
  try {
    return await api(method, url, body);
  } catch (err) {
    showMessage(err.message, true);
    if (err.status === 403) logoutHost(); // password changed on the server
  }
}

// --- Queue ---

const removeIcon =
  '<svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg>';

function renderQueue(tracks) {
  const control = canControl();
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
      li.append(thumb, text);

      if (control) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove';
        remove.setAttribute('aria-label', `Remove ${track.title}`);
        remove.innerHTML = removeIcon;
        remove.addEventListener('click', () =>
          api('DELETE', `/api/queue/${track.id}`).catch((err) => showMessage(err.message, true)),
        );
        li.append(remove);
      }
      return li;
    }),
  );
  $('#queue-count').textContent = tracks.length ? `(${tracks.length})` : '';
  $('#queue-empty').hidden = tracks.length > 0;
}

// --- Adding songs ---

nameInput.value = load('name') ?? '';
nameInput.addEventListener('change', () => save('name', nameInput.value.trim()));

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
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (hostToken) headers['X-Host-Token'] = hostToken;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

setInterval(updateProgress, 1000);
// Keep the lock-screen progress bar honest after clock drift / stream hiccups.
setInterval(updatePositionState, 15_000);

connectEvents();

// Drop a stale host token (e.g. ADMIN_PASSWORD changed) without waiting for a failed action.
if (hostToken) {
  api('GET', '/api/host/check').catch((err) => err.status === 403 && logoutHost());
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('SW registration failed', err));
}
