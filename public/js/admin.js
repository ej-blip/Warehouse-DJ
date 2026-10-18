// The admin page: Spotify login, speaker choice, starting playlist, rules, iPad links,
// admins and the weekly favourites playlist.

import { el, $, art, toast, dateAt, ago, artistLine, api, storage, watchDoc } from './common.js';

const SESSION_KEY = 'wdj.adminSession';
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY = 86400000;

const s = {
  token: storage.get(SESSION_KEY),
  overview: null,
  pub: null,
  speakers: null,
  resetMode: false,
  watching: false,
};

// ---- plumbing -------------------------------------------------------------

async function adminApi(path, opts = {}) {
  try {
    return await api(`/admin${path}`, { ...opts, headers: { Authorization: `Bearer ${s.token}` } });
  } catch (err) {
    if (err.code === 'not_signed_in') signedOut();
    throw err;
  }
}

// Run an admin action with a busy button and a toast on failure.
async function act(button, fn, success) {
  if (button) button.disabled = true;
  try {
    const result = await fn();
    if (success) toast(typeof success === 'function' ? success(result) : success, 'good');
    return result;
  } catch (err) {
    toast(err.message, 'bad');
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}

function show(id) {
  for (const x of ['setup', 'login', 'main']) $(`#${x}`).hidden = x !== id;
  $('#sign-out').hidden = id !== 'main';
}

function signedOut() {
  s.token = null;
  storage.remove(SESSION_KEY);
  $('#who').textContent = '';
  showSignIn();
}

function signedIn({ token, admin }) {
  s.token = token;
  storage.set(SESSION_KEY, token);
  toast(`Signed in as ${admin.name}.`, 'good');
  enterMain();
}

// ---- sign in --------------------------------------------------------------

async function showSignIn() {
  try {
    const { hasAdmins } = await api('/admin/status');
    setSetupMode(false);
    show(hasAdmins ? 'login' : 'setup');
    $(hasAdmins ? '#login-pin' : '#setup-code').focus();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

function setSetupMode(reset) {
  s.resetMode = reset;
  $('#setup-title').textContent = reset ? 'Reset the owner PIN' : 'Set up Warehouse DJ';
  $('#setup-hint').textContent = reset
    ? 'Enter the setup code you saved when deploying, then choose a new 6–8 digit PIN for the owner.'
    : 'Enter the setup code you saved when deploying, then choose your name and a 6–8 digit PIN.';
  $('#setup-name-field').hidden = reset;
  $('#setup-name').required = !reset;
  $('#setup-back').hidden = !reset;
}

function wireSignIn() {
  $('#setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { code: $('#setup-code').value, name: $('#setup-name').value, pin: $('#setup-pin').value };
    const r = await act(e.submitter, () => api('/admin/setup', { method: 'POST', body }));
    if (r) signedIn(r);
  });
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await act(e.submitter, () => api('/admin/login', { method: 'POST', body: { pin: $('#login-pin').value } }));
    $('#login-pin').value = '';
    if (r) signedIn(r);
  });
  $('#forgot').addEventListener('click', (e) => {
    e.preventDefault();
    setSetupMode(true);
    show('setup');
  });
  $('#back-to-login').addEventListener('click', (e) => {
    e.preventDefault();
    showSignIn();
  });
  $('#sign-out').addEventListener('click', async () => {
    await adminApi('/logout', { method: 'POST', body: {} }).catch(() => null);
    signedOut();
  });
}

// Spotify sends the admin back to /admin?spotify=connected (or =error).
function handleSpotifyReturn() {
  const params = new URLSearchParams(location.search);
  const result = params.get('spotify');
  if (!result) return;
  if (result === 'connected') toast('Spotify connected.', 'good');
  else toast(`Spotify login didn't finish (${params.get('reason') || 'unknown'}). Try again.`, 'bad');
  history.replaceState(null, '', '/admin');
}

// ---- main page -------------------------------------------------------------

async function loadOverview() {
  s.overview = await adminApi('/overview');
  const a = s.overview.admin;
  $('#who').textContent = `${a.name}${a.owner ? ' (owner)' : ''}`;
}

async function enterMain() {
  try {
    await loadOverview();
  } catch (err) {
    // An expired session already sent us back to sign in.
    if (err.code !== 'not_signed_in') {
      toast(err.message, 'bad');
      showSignIn();
    }
    return;
  }
  show('main');
  renderOverview();
  loadSpeakers();
  loadPlaylists();
  loadFavourites();
  if (!s.watching) {
    s.watching = true;
    watchDoc('public/state', (data) => {
      s.pub = data;
      renderNow();
      renderBanners();
    });
  }
}

function renderOverview() {
  renderBanners();
  renderSpotify();
  renderBase();
  renderRules();
  renderDevices();
  renderAdmins();
}

function renderBanners() {
  const o = s.overview;
  if (!o) return;
  const items = [];
  if (!o.spotify.connected) {
    items.push(['bad', o.spotify.needsReauth ? "Spotify's login has expired. Reconnect it below." : 'Connect Spotify below to get started.']);
  } else if (o.spotify.expiresAround && o.spotify.expiresAround - Date.now() < 14 * DAY) {
    items.push(['warn', `Spotify's login runs out around ${dateAt(o.spotify.expiresAround)}. Reconnect below to reset it.`]);
  }
  if (o.spotify.connected && !o.settings.speakerDeviceName) items.push(['warn', 'Choose the speaker iPad below.']);
  if (s.pub && o.spotify.connected) {
    if (s.pub.speaker.status === 'offline') items.push(['bad', "The speaker iPad isn't reachable. Open Spotify on it."]);
    if (s.pub.speaker.status === 'private') items.push(['warn', 'Spotify on the speaker iPad is in a Private Session. Turn it off.']);
  }
  if (!o.settings.basePlaylist) items.push(['info', "Pick a starting playlist below. It plays whenever nobody's queued anything."]);
  $('#banners').replaceChildren(...items.map(([kind, text]) => el('div', { class: `banner ${kind}` }, text)));
}

function renderNow() {
  const np = s.pub && s.pub.nowPlaying;
  const ctl = (action, label, cls = 'btn') =>
    el('button', { class: cls, onclick: (e) => act(e.currentTarget, () => adminApi('/control', { method: 'POST', body: { action } })) }, label);
  $('#now').replaceChildren(
    np
      ? el('div', { class: 'now-main' },
          art(np.imageUrl, 'art small'),
          el('div', { class: 'meta' },
            el('div', { class: 'name' }, np.name),
            el('div', { class: 'sub' }, artistLine(np.artists)),
            el('div', { class: 'by' }, np.requestedBy ? `Requested by ${np.requestedBy}` : 'From the playlist'),
          ))
      : el('div', { class: 'empty' }, 'Nothing playing.'),
    el('div', { class: 'controls', style: 'margin-top:12px' },
      ctl(np && np.isPlaying ? 'pause' : 'play', np && np.isPlaying ? '❚❚ Pause' : '▶ Play', 'btn primary'),
      ctl('skip', '⏭ Skip'),
      ctl('sync', '↻ Refresh'),
    ),
  );
  const ctx = s.pub && s.pub.context;
  $('#loop').checked = Boolean(ctx && ctx.repeat === 'context');
  $('#shuffle').checked = Boolean(ctx && ctx.shuffle);
}

function renderSpotify() {
  const sp = s.overview.spotify;
  const connect = el('button', {
    class: `btn ${sp.connected ? '' : 'primary'}`,
    onclick: async (e) => {
      const r = await act(e.currentTarget, () => adminApi('/spotify/connect', { method: 'POST', body: {} }));
      if (r) location.href = r.url;
    },
  }, sp.connected ? 'Reconnect Spotify' : 'Connect Spotify');
  $('#spotify').replaceChildren(
    sp.connected
      ? el('p', {}, el('span', { class: 'ok' }, 'Connected'), ` as ${sp.displayName}. Logged in ${dateAt(sp.authorizedAt)}; Spotify will ask for a fresh login around `, el('strong', {}, dateAt(sp.expiresAround)), '.')
      : el('p', {}, el('span', { class: 'bad-text' }, sp.needsReauth ? 'Login expired. ' : 'Not connected. '), 'Sign in with the Spotify account that plays the music.'),
    connect,
  );
}

async function loadSpeakers() {
  const select = $('#speaker');
  if (!s.overview.spotify.connected) {
    select.replaceChildren(el('option', {}, 'Connect Spotify first'));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  try {
    s.speakers = (await adminApi('/speakers')).devices;
  } catch (err) {
    toast(err.message, 'bad');
    s.speakers = [];
  }
  const chosen = s.overview.settings.speakerDeviceName;
  const options = [el('option', { value: '' }, '— Choose the speaker iPad —')];
  const names = new Set();
  for (const d of s.speakers) {
    names.add(d.name);
    const notes = [d.type, d.active && 'playing now', d.restricted && "can't be controlled", d.privateSession && 'private session'].filter(Boolean);
    options.push(el('option', { value: d.name, selected: d.name === chosen }, `${d.name} (${notes.join(', ')})`));
  }
  if (chosen && !names.has(chosen)) options.push(el('option', { value: chosen, selected: true }, `${chosen} (not open right now)`));
  select.replaceChildren(...options);
}

async function saveSettings(patch, message = 'Saved.') {
  const r = await adminApi('/settings', { method: 'PUT', body: patch });
  s.overview.settings = r.settings;
  renderBanners();
  toast(message, 'good');
  return r;
}

function renderBase() {
  const base = s.overview.settings.basePlaylist;
  $('#base-playlist').textContent = base
    ? `Current starting playlist: ${base.name}. Tap Play on another one to switch.`
    : "None chosen yet. It plays whenever nobody's queued anything.";
}

async function loadPlaylists(query = '') {
  const list = $('#playlists');
  if (!s.overview.spotify.connected) {
    list.replaceChildren(el('li', { class: 'empty' }, 'Connect Spotify first.'));
    return;
  }
  list.replaceChildren(el('li', { class: 'empty' }, 'Loading…'));
  try {
    const { playlists } = await adminApi(`/playlists${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    list.replaceChildren(
      ...(playlists.length
        ? playlists.map((p) =>
            el('li', { class: 'row' },
              art(p.imageUrl, 'art small'),
              el('div', { class: 'meta' },
                el('div', { class: 'name' }, p.name),
                el('div', { class: 'sub' }, [p.owner, p.trackCount !== null ? `${p.trackCount} songs` : null].filter(Boolean).join(' · ')),
              ),
              el('button', { class: 'btn small primary', onclick: (e) => playPlaylist(e.currentTarget, p) }, 'Play'),
            ))
        : [el('li', { class: 'empty' }, 'No playlists found.')]),
    );
  } catch (err) {
    list.replaceChildren(el('li', { class: 'empty' }, err.message));
  }
}

async function playPlaylist(button, p) {
  const r = await act(button, () => adminApi('/playlist/play', { method: 'POST', body: { uri: p.uri, name: p.name } }), `Playing ${p.name}.`);
  if (r) {
    s.overview.settings.basePlaylist = { uri: p.uri, name: p.name };
    renderBase();
    renderBanners();
  }
}

// ---- rules ----------------------------------------------------------------

function breakRow(b = { start: '12:00', minutes: 30 }) {
  const row = el('div', { class: 'inline breakrow', style: 'margin-bottom:8px' },
    el('div', { class: 'field' }, el('label', {}, 'Starts'), el('input', { type: 'time', class: 'b-start', value: b.start, required: true })),
    el('div', { class: 'field' }, el('label', {}, 'Minutes'), el('input', { type: 'number', class: 'b-min', min: 1, max: 240, value: b.minutes, required: true })),
    el('button', { class: 'btn small danger', type: 'button', style: 'align-self:end', onclick: () => row.remove() }, 'Remove'),
  );
  return row;
}

function renderRules() {
  const st = s.overview.settings;
  $('#days').replaceChildren(
    ...DAY_NAMES.map((name, i) =>
      el('label', {}, el('input', { type: 'checkbox', value: i + 1, checked: st.days.includes(i + 1) }), name)),
  );
  $('#open').value = st.open;
  $('#close').value = st.close;
  $('#breaks').replaceChildren(...st.breaks.map(breakRow));
  for (const key of ['autoPause', 'autoResume', 'allowExplicit']) $(`#${key}`).checked = st[key];
  for (const key of ['songsPerWindow', 'windowMinutes', 'queueCap', 'maxTrackMinutes', 'noRepeatHours']) $(`#${key}`).value = st[key];
}

function readRules() {
  const num = (id) => Number($(`#${id}`).value);
  return {
    days: [...document.querySelectorAll('#days input:checked')].map((c) => Number(c.value)),
    open: $('#open').value,
    close: $('#close').value,
    breaks: [...document.querySelectorAll('#breaks .breakrow')].map((r) => ({ start: r.querySelector('.b-start').value, minutes: Number(r.querySelector('.b-min').value) })),
    autoPause: $('#autoPause').checked,
    autoResume: $('#autoResume').checked,
    allowExplicit: $('#allowExplicit').checked,
    songsPerWindow: num('songsPerWindow'),
    windowMinutes: num('windowMinutes'),
    queueCap: num('queueCap'),
    maxTrackMinutes: num('maxTrackMinutes'),
    noRepeatHours: num('noRepeatHours'),
  };
}

// ---- iPads and admins -------------------------------------------------------

function renderDevices() {
  const devices = s.overview.devices;
  $('#devices').replaceChildren(
    ...(devices.length
      ? devices.map((d) =>
          el('li', { class: 'row' },
            el('div', { class: 'meta' },
              el('div', { class: 'name' }, d.name),
              el('div', { class: 'sub' }, `${d.enabled ? 'On' : 'Switched off'} · last seen ${ago(d.lastSeenAt)}`),
            ),
            el('button', { class: 'btn small', onclick: (e) => renameDevice(e.currentTarget, d) }, 'Rename'),
            el('button', { class: 'btn small', onclick: (e) => toggleDevice(e.currentTarget, d) }, d.enabled ? 'Switch off' : 'Switch on'),
            el('button', { class: 'btn small', onclick: (e) => newLink(e.currentTarget, d) }, 'New link'),
            el('button', { class: 'btn small danger', onclick: (e) => removeDevice(e.currentTarget, d) }, 'Remove'),
          ))
      : [el('li', { class: 'empty' }, 'No iPads yet. Add one below.')]),
  );
}

function showLink({ name, link }) {
  const box = $('#new-link');
  box.hidden = false;
  box.replaceChildren(
    el('p', {}, el('strong', {}, `Link for ${name}. `), 'Open it on that iPad in Safari, then tap Share → Add to Home Screen. Anyone with this link can queue songs as this iPad, so keep it to that iPad.'),
    el('div', { class: 'linkbox' }, link),
    el('div', { class: 'inline', style: 'margin-top:8px' },
      el('button', {
        class: 'btn small',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(link);
            toast('Link copied.', 'good');
          } catch {
            toast('Copy failed. Select the link and copy it by hand.', 'bad');
          }
        },
      }, 'Copy link'),
      el('button', { class: 'btn small', onclick: () => { box.hidden = true; } }, 'Done'),
    ),
  );
}

async function refreshDevices() {
  await loadOverview();
  renderDevices();
}

async function renameDevice(button, d) {
  const name = prompt('New name for this iPad', d.name);
  if (!name || name === d.name) return;
  if (await act(button, () => adminApi(`/devices/${d.id}`, { method: 'PATCH', body: { name } }), 'Renamed.')) refreshDevices();
}

async function toggleDevice(button, d) {
  if (await act(button, () => adminApi(`/devices/${d.id}`, { method: 'PATCH', body: { enabled: !d.enabled } }), d.enabled ? 'Switched off.' : 'Switched on.')) refreshDevices();
}

async function newLink(button, d) {
  if (!confirm(`Make a new link for ${d.name}? Its old link stops working.`)) return;
  const r = await act(button, () => adminApi(`/devices/${d.id}/link`, { method: 'POST', body: {} }));
  if (r) showLink(r);
}

async function removeDevice(button, d) {
  if (!confirm(`Remove ${d.name}? Its link stops working.`)) return;
  if (await act(button, () => adminApi(`/devices/${d.id}`, { method: 'DELETE' }), 'Removed.')) refreshDevices();
}

function renderAdmins() {
  const me = s.overview.admin;
  $('#admins').replaceChildren(
    ...s.overview.admins.map((a) =>
      el('li', { class: 'row' },
        el('div', { class: 'meta' }, el('div', { class: 'name' }, a.name, a.owner ? el('span', { class: 'tag' }, '  owner') : null)),
        me.owner && !a.owner
          ? el('button', {
              class: 'btn small danger',
              onclick: async (e) => {
                if (!confirm(`Remove ${a.name} as an admin?`)) return;
                if (await act(e.currentTarget, () => adminApi(`/admins/${a.id}`, { method: 'DELETE' }), 'Removed.')) {
                  await loadOverview();
                  renderAdmins();
                }
              },
            }, 'Remove')
          : null,
      )),
  );
  $('#add-admin').hidden = !me.owner;
}

// ---- favourites -------------------------------------------------------------

async function loadFavourites() {
  const box = $('#favourites');
  try {
    const { favourites: fav, thisWeek } = await adminApi('/favourites');
    const rebuild = el('button', {
      class: 'btn small',
      onclick: async (e) => {
        const r = await act(e.currentTarget, () => adminApi('/favourites/rebuild', { method: 'POST', body: {} }), (res) => (res.skipped ? res.message : `Playlist rebuilt with ${res.trackCount} songs.`));
        if (r) loadFavourites();
      },
    }, 'Rebuild now from this week');
    const play = fav
      ? el('button', { class: 'btn small primary', onclick: (e) => playPlaylist(e.currentTarget, { uri: fav.uri, name: 'Warehouse Favourites' }) }, 'Play it now')
      : null;
    box.replaceChildren(
      el('p', { class: 'hint' }, fav
        ? el('span', {}, el('a', { href: fav.url, target: '_blank', rel: 'noopener' }, 'Warehouse Favourites'), ` has ${fav.trackCount} songs from ${fav.weekKey} (built ${dateAt(fav.builtAt)}).`)
        : 'Built every Sunday at 8pm from the songs queued and liked that week.'),
      el('div', { class: 'inline' }, play, rebuild),
      el('h3', {}, `This week so far (${thisWeek.total} songs)`),
      thisWeek.top.length
        ? el('ul', { class: 'list' },
            thisWeek.top.map((t, i) =>
              el('li', { class: 'row' },
                el('span', { class: 'num' }, i + 1),
                art(t.imageUrl, 'art small'),
                el('div', { class: 'meta' }, el('div', { class: 'name' }, t.name), el('div', { class: 'sub' }, artistLine(t.artists))),
                el('span', { class: 'tag' }, `👍 ${t.likes} · queued ${t.queued}`),
              )))
        : el('p', { class: 'empty' }, 'Nothing queued or liked yet this week.'),
    );
  } catch (err) {
    box.replaceChildren(el('p', { class: 'empty' }, err.message));
  }
}

// ---- wiring ----------------------------------------------------------------

function wireMain() {
  $('#loop').addEventListener('change', (e) =>
    act(null, () => adminApi('/control', { method: 'POST', body: { action: 'loop', on: e.target.checked } }), e.target.checked ? 'Loop on.' : 'Loop off.'));
  $('#shuffle').addEventListener('change', (e) =>
    act(null, () => adminApi('/control', { method: 'POST', body: { action: 'shuffle', on: e.target.checked } }), e.target.checked ? 'Shuffle on.' : 'Shuffle off.'));

  $('#speaker').addEventListener('change', (e) =>
    act(null, () => saveSettings({ speakerDeviceName: e.target.value }, e.target.value ? `Speaker set to ${e.target.value}.` : 'Speaker cleared.')));
  $('#speaker-refresh').addEventListener('click', () => loadSpeakers());

  $('#tab-mine').addEventListener('click', () => {
    $('#tab-mine').setAttribute('aria-pressed', 'true');
    $('#tab-search').setAttribute('aria-pressed', 'false');
    $('#pl-search-form').hidden = true;
    loadPlaylists();
  });
  $('#tab-search').addEventListener('click', () => {
    $('#tab-mine').setAttribute('aria-pressed', 'false');
    $('#tab-search').setAttribute('aria-pressed', 'true');
    $('#pl-search-form').hidden = false;
    $('#playlists').replaceChildren();
    $('#pl-search').focus();
  });
  $('#pl-search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#pl-search').value.trim();
    if (q) loadPlaylists(q);
  });

  $('#add-break').addEventListener('click', () => $('#breaks').append(breakRow()));
  $('#rules').addEventListener('submit', (e) => {
    e.preventDefault();
    act(e.submitter, () => saveSettings(readRules(), 'Rules saved.'));
  });

  $('#add-device').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await act(e.submitter, () => adminApi('/devices', { method: 'POST', body: { name: $('#device-name').value } }));
    if (r) {
      $('#device-name').value = '';
      showLink(r);
      refreshDevices();
    }
  });
  $('#add-admin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { name: $('#admin-name').value, pin: $('#admin-pin').value };
    if (await act(e.submitter, () => adminApi('/admins', { method: 'POST', body }), `${body.name} can now sign in with their PIN.`)) {
      $('#admin-name').value = '';
      $('#admin-pin').value = '';
      await loadOverview();
      renderAdmins();
    }
  });
  $('#change-pin').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await act(e.submitter, () => adminApi('/me/pin', { method: 'PUT', body: { pin: $('#my-pin').value } }), 'PIN changed.')) $('#my-pin').value = '';
  });
}

function start() {
  handleSpotifyReturn();
  wireSignIn();
  wireMain();
  if (s.token) enterMain();
  else showSignIn();
}

start();
