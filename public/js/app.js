// The worker iPad page: now playing, up next, search and queue, play/pause/skip, likes.
// Live state comes from Firestore (public/state); every action goes through /api.

import { el, $, art, toast, duration, clockAt, artistLine, api, storage, watchDoc, wireThemeToggle, icon } from './common.js';

const TOKEN_KEY = 'wdj.deviceToken';

const state = {
  token: null,
  device: null,
  quota: null,
  serverOffset: 0, // server clock minus this iPad's clock
  pub: null, // public/state
  conn: 'reconnecting',
  mode: 'song', // song | artist | genre | playlists
  query: '',
  results: [], // search results, or the open playlist's songs
  offset: 0,
  more: false,
  playlists: null, // warehouse playlists, loaded when the Playlists tab opens
  openPlaylist: null, // { id, name } while one is open
  added: new Set(), // track ids this iPad added in this session
  searchSeq: 0,
  busy: new Set(), // controls waiting on the server
};

// ---- device token ---------------------------------------------------------

function readToken() {
  const fromUrl = new URL(location.href).searchParams.get('t');
  if (fromUrl) {
    storage.set(TOKEN_KEY, fromUrl);
    return fromUrl;
  }
  return storage.get(TOKEN_KEY);
}

const deviceApi = (path, opts = {}) => api(path, { ...opts, headers: { 'X-Device-Token': state.token } });

async function refreshMe() {
  try {
    const me = await deviceApi('/me');
    state.device = me.device;
    state.quota = me.quota;
    state.serverOffset = me.serverTime - Date.now();
    $('#device-name').textContent = me.device.name;
    renderQuota();
    renderBanners();
  } catch (err) {
    if (err.status === 401) {
      // Removed, or replaced by a new link: forget the old key and offer setup again.
      storage.remove(TOKEN_KEY);
      showNotSetUp();
    }
  }
}

// iPhone/iPad Safari keeps a separate storage for Home Screen icons, so setup must
// happen inside the icon, not in a Safari tab. (Android shares storage; no warning.)
function inIosSafariTab() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && !navigator.standalone;
}

function showNotSetUp() {
  $('#app').hidden = true;
  $('#not-set-up').hidden = false;
  $('#ios-hint').hidden = !inIosSafariTab();
}

function setupThisDevice() {
  $('#setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = e.submitter;
    button.disabled = true;
    try {
      const r = await api('/devices/register', { method: 'POST', body: { name: $('#setup-name').value, pin: $('#setup-pin').value } });
      storage.set(TOKEN_KEY, r.token);
      toast(`This device is now "${r.device.name}".`, 'good');
      // Drop any old ?t= link from the address so the stored key is used.
      setTimeout(() => location.replace('/'), 800);
    } catch (err) {
      toast(err.message, 'bad');
      button.disabled = false;
    } finally {
      $('#setup-pin').value = '';
    }
  });
}

// ---- rendering ------------------------------------------------------------

const now = () => Date.now() + state.serverOffset;

const musicOn = () => !(state.pub && state.pub.music && !state.pub.music.on);

function renderBanners() {
  const box = $('#banners');
  const p = state.pub;
  const items = [];
  if (state.conn !== 'live') items.push(['warn', 'Reconnecting… showing the last known info.']);
  if (p && p.testMode) items.push(['warn', 'Testing mode is on: time limits are off.']);
  if (state.device && !state.device.enabled) items.push(['bad', 'This iPad has been switched off by an admin.']);
  if (!musicOn()) {
    items.push(['info', p.music.message]);
  } else if (p && !p.spotify.connected) {
    items.push(['bad', p.spotify.needsReauth ? "Spotify's login has expired. An admin needs to reconnect it on the admin page." : "Spotify isn't connected yet. An admin needs to connect it on the admin page."]);
  } else if (p && p.speaker.status === 'offline') {
    items.push(['bad', "The speaker isn't reachable. Open Spotify on the clock-in iPad and press play."]);
  } else if (p && p.speaker.status === 'private') {
    items.push(['warn', "Spotify on the speaker is in a Private Session, so this screen can't show what's playing. Turn Private Session off."]);
  } else if (p && p.speaker.status === 'restricted') {
    items.push(['bad', "Spotify won't let the app control the speaker device."]);
  }
  const sched = scheduleNow();
  if (musicOn() && sched && !sched.open) items.push(['info', sched.message]);
  $('#search-input').disabled = !musicOn();
  $('#search-input').placeholder = musicOn() ? PLACEHOLDERS[state.mode] || PLACEHOLDERS.song : 'Search opens during music hours';
  box.replaceChildren(...items.map(([kind, text]) => el('div', { class: `banner ${kind}` }, text)));
}

// The published schedule is refreshed every minute by the backend; if its "until" has
// passed and nothing new has arrived yet, stop showing the stale message.
function scheduleNow() {
  const s = state.pub && state.pub.schedule;
  if (!s) return null;
  if (!s.open && s.until && now() >= s.until) return null;
  return s;
}

function progressOf(np) {
  if (!np) return 0;
  const elapsed = np.isPlaying ? now() - np.observedAt : 0;
  return Math.min(np.durationMs, np.progressMs + elapsed);
}

function renderNow() {
  const box = $('#now');
  const np = state.pub && state.pub.nowPlaying;
  const deviceId = state.device && state.device.id;
  const liked = np && deviceId && np.likedBy.includes(deviceId);
  const playing = Boolean(np && np.isPlaying);

  const like = el('button', {
    class: `ctl${liked ? ' liked' : ''}`,
    disabled: !np || liked || state.busy.has('like') || !canControl(),
    onclick: likeCurrent,
    'aria-label': liked ? 'Liked' : 'Like this song',
  }, icon('thumb'), np && np.likes ? el('span', { class: 'ctl-count' }, String(np.likes)) : null);
  const playPause = el('button', {
    class: 'ctl ctl-main',
    id: 'btn-playpause',
    disabled: state.busy.has('playpause') || !canControl(),
    onclick: () => control(playing ? 'pause' : 'play'),
    'aria-label': playing ? 'Pause' : 'Play',
  }, icon(playing ? 'pause' : 'play'));
  const skip = el('button', {
    class: 'ctl',
    disabled: state.busy.has('skip') || !np || !canControl(),
    onclick: () => control('skip'),
    'aria-label': 'Skip',
  }, icon('next'));
  const controls = el('div', { class: 'controls' }, like, playPause, skip);

  if (!np) {
    box.replaceChildren(el('div', { class: 'now' },
      el('div', { class: 'now-top' }),
      el('div', { class: 'now-art' }, el('div', { class: 'art large' }, icon('note'))),
      el('div', { class: 'now-info' }, el('div', { class: 'empty' }, musicOn() ? 'Nothing playing right now.' : "Music's off outside music hours.")),
      controls,
    ));
    return;
  }

  const pos = progressOf(np);
  box.replaceChildren(
    el('div', { class: 'now' },
      el('div', { class: 'now-top' }, el('span', { class: 'pill by' }, np.requestedBy ? `Requested by ${np.requestedBy}` : fromPlaylistText())),
      el('div', { class: 'now-art' }, art(np.imageLarge || np.imageUrl, 'art large')),
      el('div', { class: 'now-info' },
        el('div', { class: 'title' }, np.explicit ? el('span', { class: 'badge', title: 'Explicit' }, 'E') : null, np.name),
        el('div', { class: 'artists' }, artistLine(np.artists)),
      ),
      el('div', { class: 'progress' },
        el('div', { class: 'times' }, el('span', { id: 'time-pos' }, duration(pos)), el('span', {}, duration(np.durationMs))),
        el('div', { class: 'bar' }, el('div', { id: 'bar-fill', style: `width:${(pos / np.durationMs) * 100}%` })),
      ),
      controls,
      el('a', { href: np.spotifyUrl, target: '_blank', rel: 'noopener', class: 'hint now-link' }, 'Open in Spotify'),
    ),
  );
}

function fromPlaylistText() {
  const ctx = state.pub && state.pub.context;
  return ctx && ctx.name ? `From ${ctx.name}` : 'From the playlist';
}

function canControl() {
  return state.device && state.device.enabled && state.pub && state.pub.spotify.connected && musicOn();
}

function tickProgress() {
  const np = state.pub && state.pub.nowPlaying;
  const fill = $('#bar-fill');
  if (!np || !fill) return;
  const pos = progressOf(np);
  fill.style.width = `${(pos / np.durationMs) * 100}%`;
  $('#time-pos').textContent = duration(pos);
}

function songRow(t, num, cls = 'row') {
  return el('li', { class: cls },
    num ? el('span', { class: 'num' }, num) : null,
    art(t.imageUrl, 'art small'),
    el('div', { class: 'meta' }, el('div', { class: 'name' }, t.name), el('div', { class: 'sub' }, artistLine(t.artists))),
  );
}

// Requested songs first, then what Spotify says the playlist plays next.
function renderUpNext() {
  const box = $('#up-next');
  const requested = (state.pub && state.pub.upNext) || [];
  const fromPlaylist = (state.pub && state.pub.thenFromPlaylist) || [];
  const playlist = (state.pub && state.pub.context && state.pub.context.name) || 'the playlist';
  const parts = [];
  if (requested.length) {
    parts.push(el('div', { class: 'list-label first' }, 'Requested'));
    parts.push(el('ul', { class: 'list' }, requested.map((t, i) => songRow(t, i + 1, 'row requested'))));
  } else if (musicOn()) {
    parts.push(el('div', { class: 'empty' }, 'No requested songs yet. Add one with the search.'));
  }
  if (fromPlaylist.length) {
    parts.push(el('div', { class: 'list-label' }, `${requested.length ? 'Then from' : 'Coming up from'} ${playlist}`));
    parts.push(el('ul', { class: 'list' }, fromPlaylist.map((t, i) => songRow(t, requested.length + i + 1))));
  }
  if (!parts.length) parts.push(el('div', { class: 'empty' }, "Music's off outside music hours."));
  box.replaceChildren(...parts);
}

function renderRecent() {
  const list = (state.pub && state.pub.recent) || [];
  $('#recent').replaceChildren(
    ...(list.length ? list.map((t) => songRow(t, null)) : [el('li', { class: 'empty' }, 'Nothing yet today.')]),
  );
}

function renderQuota() {
  const box = $('#quota');
  const q = state.quota;
  if (!q) {
    box.replaceChildren();
    return;
  }
  const sched = scheduleNow();
  const pips = el('div', { class: 'pips', 'aria-hidden': 'true' }, Array.from({ length: q.limit }, (_, i) => el('span', { class: `pip${i < q.remaining ? ' full' : ''}` })));
  let note;
  if (!musicOn() || (sched && !sched.open)) note = 'Queueing is closed right now';
  else if (q.remaining > 0) note = `This iPad can add ${q.remaining} more ${q.remaining === 1 ? 'song' : 'songs'}`;
  else note = `Next song available at ${clockAt(q.nextAt)}`;
  box.replaceChildren(
    el('span', {}, `${q.remaining} of ${q.limit} songs left`),
    pips,
    el('span', { class: 'note' }, note),
  );
}

function renderResults() {
  const list = $('#results');
  const browsing = state.mode === 'playlists';
  if (browsing ? !state.openPlaylist : !state.query) {
    list.replaceChildren();
    $('#more').hidden = true;
    return;
  }
  if (!state.results.length) {
    list.replaceChildren(el('li', { class: 'empty' }, browsing ? 'This playlist is empty.' : 'No songs found.'));
    $('#more').hidden = true;
    return;
  }
  list.replaceChildren(...state.results.map(resultRow));
  $('#more').hidden = !state.more;
}

function resultRow(t) {
  const added = state.added.has(t.id);
  const pending = state.busy.has(`add:${t.id}`);
  let action;
  if (added) action = el('button', { class: 'btn small good', disabled: true }, 'Added ✓');
  else if (t.blocked) action = el('span', { class: 'why' }, t.blocked.message);
  else action = el('button', { class: 'btn small primary', disabled: pending || !canControl(), onclick: () => addSong(t) }, pending ? 'Adding…' : 'Add');
  return el('li', { class: 'row' },
    art(t.imageUrl, 'art small'),
    el('div', { class: 'meta' },
      el('div', { class: 'name' }, t.explicit ? el('span', { class: 'badge', title: 'Explicit' }, 'E') : null, t.name),
      el('div', { class: 'sub' }, `${artistLine(t.artists)} · ${duration(t.durationMs)}`),
    ),
    action,
  );
}

function renderAll() {
  renderBanners();
  renderNow();
  renderUpNext();
  renderRecent();
  renderQuota();
  renderResults();
}

// ---- actions --------------------------------------------------------------

async function control(action) {
  const key = action === 'skip' ? 'skip' : 'playpause';
  state.busy.add(key);
  renderNow();
  try {
    await deviceApi(`/${action}`, { method: 'POST', body: {} });
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    state.busy.delete(key);
    renderNow();
  }
}

async function likeCurrent() {
  state.busy.add('like');
  renderNow();
  try {
    const r = await deviceApi('/like', { method: 'POST', body: {} });
    toast(r.already ? 'You already liked this one.' : 'Liked! It counts towards Warehouse Favourites.', 'good');
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    state.busy.delete('like');
    renderNow();
  }
}

async function addSong(t) {
  state.busy.add(`add:${t.id}`);
  renderResults();
  try {
    const r = await deviceApi('/queue', { method: 'POST', body: { uri: t.uri } });
    state.added.add(t.id);
    state.quota = r.quota;
    toast(`Added "${t.name}". It's number ${r.position} in the queue.`, 'good');
  } catch (err) {
    toast(err.message, 'bad');
    if (err.code === 'quota' || err.code === 'closed') refreshMe();
  } finally {
    state.busy.delete(`add:${t.id}`);
    renderQuota();
    renderResults();
  }
}

let searchTimer = null;
async function search({ append = false } = {}) {
  const q = state.query;
  const seq = ++state.searchSeq;
  const offset = append ? state.offset + 10 : 0;
  try {
    const r = await deviceApi(`/search?q=${encodeURIComponent(q)}&mode=${state.mode}&offset=${offset}`);
    if (seq !== state.searchSeq) return; // a newer search has started
    state.results = append ? [...state.results, ...r.tracks] : r.tracks;
    state.offset = offset;
    state.more = r.more;
    renderResults();
  } catch (err) {
    if (seq === state.searchSeq) toast(err.message, 'bad');
  }
}

function setupSearch() {
  const input = $('#search-input');
  input.addEventListener('input', () => {
    state.query = input.value.trim();
    $('#search-clear').hidden = !input.value;
    clearTimeout(searchTimer);
    if (!state.query) {
      state.results = [];
      renderResults();
      return;
    }
    searchTimer = setTimeout(() => search(), 450);
  });
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(searchTimer);
    input.blur(); // hide the keyboard
    if (state.query) search();
  });
  $('#search-clear').addEventListener('click', () => {
    input.value = '';
    state.query = '';
    state.results = [];
    $('#search-clear').hidden = true;
    renderResults();
    input.focus();
  });
  $('#more').addEventListener('click', () => (state.mode === 'playlists' ? loadPlaylistSongs({ append: true }) : search({ append: true })));
  for (const button of document.querySelectorAll('#modes button')) {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  }
}

// ---- search modes and warehouse playlists ------------------------------------

const PLACEHOLDERS = {
  song: 'Search songs',
  artist: 'Type an artist',
  genre: 'Type a genre, e.g. jazz rap, lo-fi, 80s rock',
};

function setMode(mode) {
  if (mode === state.mode) {
    if (mode === 'playlists') closePlaylist();
    return;
  }
  state.mode = mode;
  state.searchSeq++; // ignore answers to searches from the old mode
  for (const b of document.querySelectorAll('#modes button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  const browsing = mode === 'playlists';
  $('#search-form').hidden = browsing;
  $('#playlist-view').hidden = !browsing;
  state.results = [];
  state.openPlaylist = null;
  if (browsing) {
    loadPlaylists();
  } else {
    if (musicOn()) $('#search-input').placeholder = PLACEHOLDERS[mode];
    if (state.query) search();
  }
  renderResults();
}

async function loadPlaylists() {
  const box = $('#playlist-view');
  box.replaceChildren(el('p', { class: 'empty' }, 'Loading…'));
  try {
    state.playlists = (await deviceApi('/playlists')).playlists;
  } catch (err) {
    box.replaceChildren(el('p', { class: 'empty' }, err.message));
    return;
  }
  renderPlaylists();
}

function renderPlaylists() {
  const box = $('#playlist-view');
  if (state.openPlaylist) {
    box.replaceChildren(
      el('div', { class: 'playlist-head' },
        el('button', { class: 'btn small', type: 'button', onclick: closePlaylist }, '← All playlists'),
        el('span', { class: 'name' }, state.openPlaylist.name),
      ),
    );
    return;
  }
  const list = state.playlists || [];
  box.replaceChildren(
    list.length
      ? el('ul', { class: 'list' },
          list.map((p) =>
            el('li', { class: 'row' },
              art(p.imageUrl, 'art small'),
              el('div', { class: 'meta' },
                el('div', { class: 'name' }, p.name),
                el('div', { class: 'sub' }, [p.owner, p.trackCount ? `${p.trackCount} songs` : null].filter(Boolean).join(' · ')),
              ),
              el('button', { class: 'btn small primary', type: 'button', onclick: () => openPlaylist(p) }, 'Open'),
            )))
      : el('p', { class: 'empty' }, 'No warehouse playlists yet. An admin can add some.'),
  );
}

function openPlaylist(p) {
  state.openPlaylist = { id: p.id, name: p.name };
  state.results = [];
  renderPlaylists();
  renderResults();
  loadPlaylistSongs();
}

// Back to the list, fetched again so new weekly favourites show up.
function closePlaylist() {
  state.openPlaylist = null;
  state.results = [];
  loadPlaylists();
  renderResults();
}

async function loadPlaylistSongs({ append = false } = {}) {
  const open = state.openPlaylist;
  if (!open) return;
  const seq = ++state.searchSeq;
  const offset = append ? state.offset + 50 : 0;
  try {
    const r = await deviceApi(`/playlists/${encodeURIComponent(open.id)}/tracks?offset=${offset}`);
    if (seq !== state.searchSeq || state.openPlaylist !== open) return;
    state.results = append ? [...state.results, ...r.tracks] : r.tracks;
    state.offset = offset;
    state.more = r.more;
    renderResults();
  } catch (err) {
    if (seq === state.searchSeq) toast(err.message, 'bad');
  }
}

// ---- start ----------------------------------------------------------------

async function start() {
  wireThemeToggle($('#theme-toggle'));
  setupThisDevice();
  state.token = readToken();
  if (!state.token) {
    showNotSetUp();
    return;
  }
  $('#app').hidden = false;
  setupSearch();
  renderAll();
  await refreshMe();

  watchDoc('public/state', (data) => {
    state.pub = data;
    renderAll();
  }, (status) => {
    state.conn = status;
    $('#conn-dot').className = `dot ${status}`;
    renderBanners();
  });
  setInterval(tickProgress, 1000);
  setInterval(refreshMe, 60000);
  // Re-render each minute so schedule banners expire on time.
  setInterval(() => { renderBanners(); renderQuota(); }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshMe();
  });
}

start();
