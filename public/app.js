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
// Cover images come from YouTube/SoundCloud servers. Turning them off saves data and
// avoids those third-party requests. Personal, remembered per device.
let showCovers = load('showCovers') !== 'false';

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
  const newEpoch = !first && next.epoch !== state.epoch;
  state = next;

  // Someone skipped, seeked, paused or resumed the station. Reconnect so we drop the ~1-2s
  // of old audio still buffered here and hear the change right away.
  if (newEpoch && wantPlaying) play();
  clockOffset = next.serverTime - Date.now();

  document.title = next.stationName;
  $('#station-name').textContent = next.stationName;
  const n = next.listeners;
  $('#listeners').textContent = n === 1 ? '1 listener' : `${n} listeners`;
  renderQueue(next.queue);
  renderHistory(next.history);
  renderHost();

  // While listening, we hear audio streamLagMs() after the server sends it. Delay natural
  // track changes by the same amount so the screen matches what you hear. (Controls
  // reconnect the stream, so their effect is immediate.)
  const np = next.nowPlaying;
  const key = np ? `${np.id}|${np.startedAt}|${np.position}` : null;
  if (key !== shownKey) {
    shownKey = key;
    clearTimeout(nowPlayingTimer);
    const delay = first || newEpoch ? 0 : streamLagMs();
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
    renderCover(track);
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

function renderCover(track) {
  const img = $('#cover-img');
  if (showCovers && track?.thumbnail) {
    img.src = track.thumbnail;
    img.hidden = false;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
  }
}

/**
 * How far behind the live broadcast this listener hears, in ms: the audio buffered ahead of
 * the playhead. Measured instead of assumed, because it shrinks after a reconnect.
 */
function streamLagMs() {
  const buffered = audio.buffered;
  if (!wantPlaying || buffered.length === 0) return 0;
  return Math.max(0, (buffered.end(buffered.length - 1) - audio.currentTime) * 1000);
}

/** Position in seconds of what this listener hears right now. */
function elapsedSeconds(track) {
  if (track.startedAt === null) return track.position; // station paused
  const ms = Date.now() + clockOffset - track.startedAt - streamLagMs();
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
    artwork: showCovers && track?.thumbnail
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
const addIcon = '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>';

/** One row of the queue or history list: cover, title, meta line and an optional button. */
function trackRow(track, metaParts, button) {
  const li = document.createElement('li');

  if (showCovers) {
    const thumb = document.createElement(track.thumbnail ? 'img' : 'div');
    thumb.className = 'thumb';
    if (track.thumbnail) {
      thumb.src = track.thumbnail;
      thumb.alt = '';
      thumb.loading = 'lazy';
    }
    li.append(thumb);
  }

  const text = document.createElement('div');
  text.className = 'text';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = track.title;
  title.title = track.title;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = metaParts.filter(Boolean).join(' · ');
  text.append(title, meta);
  li.append(text);

  if (button) li.append(button);
  return li;
}

function iconButton(className, icon, label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = icon; // static markup, no server data
  button.addEventListener('click', () => onClick(button));
  return button;
}

function renderQueue(tracks) {
  const control = canControl();
  $('#queue-list').replaceChildren(
    ...tracks.map((track) =>
      trackRow(
        track,
        [
          formatTime(track.duration),
          track.status === 'ready' ? null : track.status === 'downloading' ? 'loading…' : 'waiting',
          track.addedBy && `by ${track.addedBy}`,
        ],
        control &&
          iconButton('remove', removeIcon, `Remove ${track.title}`, () =>
            api('DELETE', `/api/queue/${track.id}`).catch((err) => showMessage(err.message, true)),
          ),
      ),
    ),
  );
  $('#queue-count').textContent = tracks.length ? `(${tracks.length})` : '';
  $('#queue-empty').hidden = tracks.length > 0;
}

// --- History ---

function renderHistory(tracks = []) {
  $('#history-list').replaceChildren(
    ...tracks.map((track) =>
      trackRow(
        track,
        [timeAgo(track.playedAt), formatTime(track.duration), track.addedBy && `by ${track.addedBy}`],
        iconButton('requeue', addIcon, `Add ${track.title} again`, async (button) => {
          button.disabled = true;
          try {
            await addToQueue(track.url);
          } finally {
            button.disabled = false;
          }
        }),
      ),
    ),
  );
  $('#history-count').textContent = tracks.length ? `(${tracks.length})` : '';
  $('#history-empty').hidden = tracks.length > 0;
}

/** "just now", "5 min ago", "2 h ago" or a date, from a server timestamp. */
function timeAgo(serverMs) {
  const minutes = Math.floor((Date.now() + clockOffset - serverMs) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return new Date(serverMs - clockOffset).toLocaleDateString();
}

// --- Cover images toggle ---

function applyCovers() {
  document.body.classList.toggle('no-covers', !showCovers);
  $('#show-covers').checked = showCovers;
}

$('#show-covers').addEventListener('change', (e) => {
  showCovers = e.target.checked;
  save('showCovers', String(showCovers));
  applyCovers();
  renderCover(shownTrack);
  if (shownTrack) updateMediaMetadata(shownTrack);
  if (state) {
    renderQueue(state.queue);
    renderHistory(state.history);
  }
});
applyCovers();

// --- Adding songs ---

nameInput.value = load('name') ?? '';
nameInput.addEventListener('change', () => save('name', nameInput.value.trim()));

/** Queues a link (song or playlist). Resolves to true on success; shows the outcome. */
async function addToQueue(url, playlist = false) {
  showMessage(playlist || looksLikePlaylist(url) ? 'Loading the playlist…' : 'Looking it up…');
  try {
    const result = await api('POST', '/api/queue', { url, name: nameInput.value, playlist });
    if (result.playlist) {
      const skipped = result.skipped ? ` (${result.skipped} skipped)` : '';
      showMessage(`Added ${result.added} songs from “${result.playlist}”${skipped}.`);
    } else {
      showMessage(`Added “${result.title}”.`);
    }
    return true;
  } catch (err) {
    showMessage(err.message, true);
    return false;
  }
}

/** Pure playlist links (always added whole), e.g. YouTube ?list= or SoundCloud /sets/. */
function looksLikePlaylist(url) {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  return /\/sets\//.test(parsed.pathname) || (parsed.searchParams.has('list') && !isMixedLink(parsed));
}

/** A YouTube link to one video inside a playlist: we ask whether to take the whole list. */
function isMixedLink(parsed) {
  return parsed.searchParams.has('list') && (parsed.searchParams.has('v') || parsed.hostname.endsWith('youtu.be'));
}

function parseUrl(text) {
  try {
    return new URL(text.trim());
  } catch {
    return null;
  }
}

const urlInput = $('#url');
const playlistOption = $('#playlist-option');

function updatePlaylistOption() {
  const parsed = parseUrl(urlInput.value);
  playlistOption.hidden = !(parsed && isMixedLink(parsed));
}
urlInput.addEventListener('input', updatePlaylistOption);

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $('#add-btn');
  button.disabled = true;
  const wholePlaylist = !playlistOption.hidden && $('#whole-playlist').checked;
  if (await addToQueue(urlInput.value, wholePlaylist)) {
    urlInput.value = '';
    $('#whole-playlist').checked = false;
    updatePlaylistOption();
  }
  button.disabled = false;
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
  urlInput.value = sharedUrl;
  updatePlaylistOption();
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
// Keep "5 min ago" in the history current.
setInterval(() => state && renderHistory(state.history), 60_000);
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
