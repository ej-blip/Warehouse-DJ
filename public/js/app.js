// The worker iPad page: now playing, up next, search and queue, play/pause/skip, likes.
// Live state comes from Firestore (public/state); every action goes through /api.

import { el, $, art, toast, duration, clockAt, artistLine, api, storage, watchDoc } from './common.js';

const TOKEN_KEY = 'wdj.deviceToken';

const state = {
  token: null,
  device: null,
  quota: null,
  serverOffset: 0, // server clock minus this iPad's clock
  pub: null, // public/state
  conn: 'reconnecting',
  query: '',
  results: [],
  offset: 0,
  more: false,
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
    if (err.status === 401) showNotSetUp();
  }
}

function showNotSetUp() {
  $('#app').hidden = true;
  $('#not-set-up').hidden = false;
}

// ---- rendering ------------------------------------------------------------

const now = () => Date.now() + state.serverOffset;

function renderBanners() {
  const box = $('#banners');
  const p = state.pub;
  const items = [];
  if (state.conn !== 'live') items.push(['warn', 'Reconnecting… showing the last known info.']);
  if (state.device && !state.device.enabled) items.push(['bad', 'This iPad has been switched off by an admin.']);
  if (p && !p.spotify.connected) {
    items.push(['bad', p.spotify.needsReauth ? "Spotify's login has expired. An admin needs to reconnect it on the admin page." : "Spotify isn't connected yet. An admin needs to connect it on the admin page."]);
  } else if (p && p.speaker.status === 'offline') {
    items.push(['bad', "The speaker isn't reachable. Open Spotify on the clock-in iPad and press play."]);
  } else if (p && p.speaker.status === 'private') {
    items.push(['warn', "Spotify on the speaker is in a Private Session, so this screen can't show what's playing. Turn Private Session off."]);
  } else if (p && p.speaker.status === 'restricted') {
    items.push(['bad', "Spotify won't let the app control the speaker device."]);
  }
  const sched = scheduleNow();
  if (sched && !sched.open) items.push(['info', sched.message]);
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

  const playPause = el('button', {
    class: 'btn primary',
    id: 'btn-playpause',
    disabled: state.busy.has('playpause') || !canControl(),
    onclick: () => control(np && np.isPlaying ? 'pause' : 'play'),
  }, np && np.isPlaying ? '❚❚ Pause' : '▶ Play');
  const skip = el('button', { class: 'btn', disabled: state.busy.has('skip') || !np || !canControl(), onclick: () => control('skip') }, '⏭ Skip');
  const like = el('button', {
    class: `btn${liked ? ' liked' : ''}`,
    disabled: !np || liked || state.busy.has('like') || !canControl(),
    onclick: likeCurrent,
    'aria-label': liked ? 'Liked' : 'Like this song',
  }, `👍 ${np ? np.likes : ''}`.trim());

  if (!np) {
    box.replaceChildren(el('div', { class: 'now' }, el('div', { class: 'empty' }, 'Nothing playing right now.'), el('div', { class: 'controls' }, playPause, skip, like)));
    return;
  }

  const pos = progressOf(np);
  box.replaceChildren(
    el('div', { class: 'now' },
      el('div', { class: 'now-main' },
        art(np.imageUrl),
        el('div', {},
          el('div', { class: 'title' }, np.explicit ? el('span', { class: 'badge', title: 'Explicit' }, 'E') : null, np.name),
          el('div', { class: 'artists' }, artistLine(np.artists)),
          el('div', { class: 'by' }, np.requestedBy ? `Requested by ${np.requestedBy}` : fromPlaylistText()),
        ),
      ),
      el('div', { class: 'progress' },
        el('div', { class: 'bar' }, el('div', { id: 'bar-fill', style: `width:${(pos / np.durationMs) * 100}%` })),
        el('div', { class: 'times' }, el('span', { id: 'time-pos' }, duration(pos)), el('span', {}, duration(np.durationMs))),
      ),
      el('div', { class: 'controls' }, playPause, skip, like),
      el('a', { href: np.spotifyUrl, target: '_blank', rel: 'noopener', class: 'hint' }, 'Open in Spotify'),
    ),
  );
}

function fromPlaylistText() {
  const ctx = state.pub && state.pub.context;
  return ctx && ctx.name ? `From ${ctx.name}` : 'From the playlist';
}

function canControl() {
  return state.device && state.device.enabled && state.pub && state.pub.spotify.connected;
}

function tickProgress() {
  const np = state.pub && state.pub.nowPlaying;
  const fill = $('#bar-fill');
  if (!np || !fill) return;
  const pos = progressOf(np);
  fill.style.width = `${(pos / np.durationMs) * 100}%`;
  $('#time-pos').textContent = duration(pos);
}

function renderUpNext() {
  const box = $('#up-next');
  const list = (state.pub && state.pub.upNext) || [];
  const then = state.pub && state.pub.context && state.pub.context.name;
  const rows = list.map((t, i) =>
    el('li', { class: 'row' },
      el('span', { class: 'num' }, i + 1),
      art(t.imageUrl, 'art small'),
      el('div', { class: 'meta' }, el('div', { class: 'name' }, t.name), el('div', { class: 'sub' }, artistLine(t.artists))),
      el('span', { class: 'tag' }, t.deviceName),
    ));
  box.replaceChildren(
    rows.length ? el('ul', { class: 'list' }, rows) : el('div', { class: 'empty' }, 'No requested songs yet.'),
    el('p', { class: 'hint' }, rows.length ? `Then back to ${then || 'the playlist'}.` : `Playing ${then || 'the playlist'} until someone adds a song.`),
  );
}

function renderRecent() {
  const list = (state.pub && state.pub.recent) || [];
  $('#recent').replaceChildren(
    ...(list.length
      ? list.map((t) =>
          el('li', { class: 'row' },
            art(t.imageUrl, 'art small'),
            el('div', { class: 'meta' }, el('div', { class: 'name' }, t.name), el('div', { class: 'sub' }, artistLine(t.artists))),
            t.requestedBy ? el('span', { class: 'tag' }, t.requestedBy) : null,
          ))
      : [el('li', { class: 'empty' }, 'Nothing yet today.')]),
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
  if (sched && !sched.open) note = 'Queueing is closed right now';
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
  if (!state.query) {
    list.replaceChildren();
    $('#more').hidden = true;
    return;
  }
  if (!state.results.length) {
    list.replaceChildren(el('li', { class: 'empty' }, 'No songs found.'));
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
    const r = await deviceApi(`/search?q=${encodeURIComponent(q)}&offset=${offset}`);
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
  $('#more').addEventListener('click', () => search({ append: true }));
}

// ---- start ----------------------------------------------------------------

async function start() {
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
