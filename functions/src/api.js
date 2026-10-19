'use strict';

// HTTP API, served at /api/* through a Firebase Hosting rewrite. iPads authenticate with
// their link token (X-Device-Token); admins with a session token (Authorization: Bearer).

const express = require('express');
const { logger } = require('firebase-functions');
const auth = require('./auth');
const playback = require('./playback');
const favourites = require('./favourites');
const spotify = require('./spotify');
const store = require('./store');
const rules = require('./rules');
const { SITE_URL } = require('./config');
const { UserError, toUserError } = require('./errors');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function clientIp(req) {
  return String(req.get('fastly-client-ip') || (req.get('x-forwarded-for') || '').split(',')[0] || req.ip || '').trim();
}

// ---- iPads ----------------------------------------------------------------

const requireDevice = wrap(async (req, res, next) => {
  const device = await auth.verifyDevice(req.get('x-device-token'));
  if (!device) {
    res.status(401).json({ error: 'unknown_device', message: "This iPad isn't set up. Ask an admin for its link." });
    return;
  }
  req.device = device;
  next();
});

function requireEnabled(req, res, next) {
  if (!req.device.enabled) {
    res.status(403).json({ error: 'device_off', message: 'This iPad has been switched off by an admin.' });
    return;
  }
  next();
}

// Debounced on the iPad, but a stuck key shouldn't burn through Spotify's rate limit.
const searchTimes = new Map();
function searchLimit(req, res, next) {
  const now = Date.now();
  const times = (searchTimes.get(req.device.id) || []).filter((t) => now - t < 60000);
  if (times.length >= 30) {
    res.status(429).json({ error: 'slow_down', message: 'Too many searches. Give it a moment.' });
    return;
  }
  times.push(now);
  searchTimes.set(req.device.id, times);
  next();
}

app.get('/api/me', requireDevice, wrap(async (req, res) => {
  const [settings, c] = await Promise.all([store.getSettings(), store.readCore()]);
  const now = Date.now();
  res.json({
    device: req.device,
    quota: rules.deviceQuota(now, settings, c, req.device.id),
    schedule: rules.scheduleStatus(now, settings),
    serverTime: now,
  });
}));

app.get('/api/search', requireDevice, requireEnabled, searchLimit, wrap(async (req, res) => {
  const music = rules.musicStatus(Date.now(), await store.getSettings());
  if (!music.on) throw new UserError('music_off', music.message, 409);
  const q = String(req.query.q || '').trim();
  const offset = Math.min(Math.max(parseInt(req.query.offset, 10) || 0, 0), 200);
  if (!q) return res.json({ tracks: [], offset, total: 0, more: false });
  if (q.length > 100) throw new UserError('bad_query', 'That search is too long.');
  let data;
  try {
    data = await spotify.searchTracks(q, offset);
  } catch (err) {
    throw toUserError(err);
  }
  const page = (data && data.tracks) || { items: [], total: 0 };
  const tracks = (page.items || []).map(spotify.normalizeTrack).filter(Boolean);
  playback.rememberTracks(tracks);
  const [settings, c] = await Promise.all([store.getSettings(), store.readCore()]);
  const now = Date.now();
  res.json({
    tracks: tracks.map((t) => ({
      ...t,
      blocked: t.playable ? rules.trackBlock(now, settings, c, t) : { code: 'unplayable', message: "Not available in Australia." },
    })),
    offset,
    total: page.total || 0,
    more: Boolean(page.next),
  });
}));

app.post('/api/queue', requireDevice, requireEnabled, wrap(async (req, res) => {
  const result = await playback.queueTrack(req.device, req.body && req.body.uri);
  res.json({ ok: true, position: result.position, quota: result.quota, track: { name: result.track.name } });
}));

for (const action of ['play', 'pause', 'skip']) {
  app.post(`/api/${action}`, requireDevice, requireEnabled, wrap(async (req, res) => {
    await playback.control(action);
    logger.info('Playback control', { action, device: req.device.name });
    res.json({ ok: true });
  }));
}

app.post('/api/like', requireDevice, requireEnabled, wrap(async (req, res) => {
  res.json({ ok: true, ...(await playback.like(req.device)) });
}));

// Set up the device this request comes from: an admin types their PIN on the iPad
// itself. The token goes straight into that iPad's storage and is never shown.
app.post('/api/devices/register', wrap(async (req, res) => {
  const ip = clientIp(req);
  await auth.guardCheck(ip);
  const pin = String((req.body && req.body.pin) || '');
  const admin = /^\d{6,8}$/.test(pin) ? await auth.findAdminByPin(pin, await auth.listAdmins()) : null;
  if (!admin) {
    await auth.guardFail(ip);
    throw new UserError('bad_pin', "That PIN isn't right.", 401);
  }
  const device = await auth.createDevice(req.body.name, { via: 'setup' });
  logger.info('Device set up on the device', { device: device.name, by: admin.name });
  res.json({ token: device.token, device: { id: device.id, name: device.name } });
}));

// ---- admin sign-in --------------------------------------------------------

const requireAdmin = wrap(async (req, res, next) => {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const admin = await auth.verifySession(token);
  if (!admin) {
    res.status(401).json({ error: 'not_signed_in', message: 'Please sign in again.' });
    return;
  }
  req.admin = admin;
  req.adminToken = token;
  next();
});

function requireOwner(req, res, next) {
  if (!req.admin.owner) {
    res.status(403).json({ error: 'owner_only', message: 'Only the owner can do that.' });
    return;
  }
  next();
}

app.get('/api/admin/status', wrap(async (req, res) => {
  res.json({ hasAdmins: await auth.hasAdmins() });
}));

// First run: create the owner. Later: the owner's forgotten-PIN reset.
app.post('/api/admin/setup', wrap(async (req, res) => {
  const ip = clientIp(req);
  await auth.guardCheck(ip);
  const { code, name, pin } = req.body || {};
  if (!auth.setupCodeMatches(code)) {
    await auth.guardFail(ip);
    throw new UserError('bad_code', "That setup code isn't right.", 401);
  }
  const admins = await auth.listAdmins();
  let admin;
  if (!admins.length) {
    admin = await auth.createAdmin({ name, pin, owner: true });
  } else {
    const owner = admins.find((a) => a.owner);
    if (!owner) throw new UserError('no_owner', 'No owner account found.', 500);
    await auth.changePin(owner.id, pin);
    admin = { id: owner.id, name: owner.name, owner: true };
  }
  res.json({ token: await auth.createSession(admin), admin });
}));

app.post('/api/admin/login', wrap(async (req, res) => {
  const ip = clientIp(req);
  await auth.guardCheck(ip);
  const pin = String((req.body && req.body.pin) || '');
  const admin = /^\d{6,8}$/.test(pin) ? await auth.findAdminByPin(pin, await auth.listAdmins()) : null;
  if (!admin) {
    await auth.guardFail(ip);
    throw new UserError('bad_pin', "That PIN isn't right.", 401);
  }
  const who = { id: admin.id, name: admin.name, owner: Boolean(admin.owner) };
  res.json({ token: await auth.createSession(who), admin: who });
}));

app.post('/api/admin/logout', requireAdmin, wrap(async (req, res) => {
  await auth.endSession(req.adminToken);
  res.json({ ok: true });
}));

app.put('/api/admin/me/pin', requireAdmin, wrap(async (req, res) => {
  await auth.changePin(req.admin.id, req.body && req.body.pin);
  res.json({ ok: true });
}));

// ---- admin pages ----------------------------------------------------------

app.get('/api/admin/overview', requireAdmin, wrap(async (req, res) => {
  const [settings, login, devices, admins] = await Promise.all([
    store.getSettings({ fresh: true }),
    spotify.loginStatus(),
    auth.listDevices(),
    auth.listAdmins(),
  ]);
  res.json({
    admin: req.admin,
    settings,
    spotify: login,
    devices,
    admins: admins.map((a) => ({ id: a.id, name: a.name, owner: Boolean(a.owner), createdAt: a.createdAt })),
    siteUrl: SITE_URL,
  });
}));

app.put('/api/admin/settings', requireAdmin, wrap(async (req, res) => {
  const current = await store.getSettings({ fresh: true });
  const result = rules.validateSettings(current, req.body || {});
  if (result.errors) throw new UserError('bad_settings', result.errors.join(' '));
  await store.saveSettings(result.settings);
  logger.info('Settings changed', { by: req.admin.name });
  res.json({ settings: result.settings });
}));

app.get('/api/admin/speakers', requireAdmin, wrap(async (req, res) => {
  try {
    const devices = await spotify.devices();
    res.json({ devices: devices.map((d) => ({ name: d.name, type: d.type, active: d.is_active, restricted: d.is_restricted, privateSession: d.is_private_session })) });
  } catch (err) {
    throw toUserError(err);
  }
}));

app.post('/api/admin/control', requireAdmin, wrap(async (req, res) => {
  const action = req.body && req.body.action;
  if (action === 'loop') await playback.setLoop(Boolean(req.body.on));
  else if (action === 'shuffle') await playback.setShuffle(Boolean(req.body.on));
  else if (action === 'sync') await playback.sync({ deep: true }).catch((err) => { throw toUserError(err); });
  else await playback.control(action, { admin: true });
  res.json({ ok: true });
}));

app.post('/api/admin/test-break', requireAdmin, wrap(async (req, res) => {
  const seconds = Math.min(Math.max(parseInt(req.body && req.body.seconds, 10) || 15, 1), 40);
  res.json(await playback.testBreak(seconds));
}));

app.get('/api/admin/playlists', requireAdmin, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  let items;
  try {
    const data = q ? await spotify.searchPlaylists(q) : await spotify.myPlaylists();
    items = q ? (data && data.playlists && data.playlists.items) || [] : (data && data.items) || [];
  } catch (err) {
    throw toUserError(err);
  }
  res.json({ playlists: items.map(spotify.normalizePlaylist).filter(Boolean) });
}));

app.post('/api/admin/playlist/play', requireAdmin, wrap(async (req, res) => {
  const { uri, name } = req.body || {};
  if (!/^spotify:playlist:[A-Za-z0-9]{22}$/.test(String(uri || ''))) throw new UserError('bad_playlist', "That isn't a playlist.");
  await playback.playPlaylist({ uri, name: String(name || 'Playlist').slice(0, 100) });
  res.json({ ok: true });
}));

app.post('/api/admin/devices', requireAdmin, wrap(async (req, res) => {
  const device = await auth.createDevice(req.body && req.body.name);
  res.json({ ...device, link: `${SITE_URL}/?t=${device.token}` });
}));

app.patch('/api/admin/devices/:id', requireAdmin, wrap(async (req, res) => {
  await auth.updateDevice(req.params.id, req.body || {});
  res.json({ ok: true });
}));

app.post('/api/admin/devices/:id/link', requireAdmin, wrap(async (req, res) => {
  const device = await auth.newDeviceLink(req.params.id);
  res.json({ ...device, link: `${SITE_URL}/?t=${device.token}` });
}));

app.delete('/api/admin/devices/:id', requireAdmin, wrap(async (req, res) => {
  await auth.deleteDevice(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/admin/admins', requireAdmin, requireOwner, wrap(async (req, res) => {
  const { name, pin } = req.body || {};
  res.json(await auth.createAdmin({ name, pin }));
}));

app.delete('/api/admin/admins/:id', requireAdmin, requireOwner, wrap(async (req, res) => {
  await auth.deleteAdmin(req.params.id, req.admin);
  res.json({ ok: true });
}));

app.get('/api/admin/favourites', requireAdmin, wrap(async (req, res) => {
  const settings = await store.getSettings({ fresh: true });
  res.json({ favourites: settings.favourites, thisWeek: await favourites.preview() });
}));

app.post('/api/admin/favourites/rebuild', requireAdmin, wrap(async (req, res) => {
  res.json(await favourites.build());
}));

// ---- Spotify login ----------------------------------------------------------

app.post('/api/admin/spotify/connect', requireAdmin, wrap(async (req, res) => {
  const state = await auth.createOAuthState(req.admin.id);
  res.json({ url: spotify.authorizeUrl(state) });
}));

// Spotify redirects the admin's browser here after they approve the app.
app.get('/api/auth/callback', wrap(async (req, res) => {
  const back = (params) => res.redirect(`/admin?${new URLSearchParams(params)}`);
  if (req.query.error) return back({ spotify: 'error', reason: String(req.query.error) });
  if (!(await auth.consumeOAuthState(req.query.state))) return back({ spotify: 'error', reason: 'expired' });
  try {
    const login = await spotify.exchangeCode(String(req.query.code || ''));
    const settings = await store.getSettings({ fresh: true });
    // A different Spotify account owns a different favourites playlist.
    if (settings.favourites && settings.favourites.ownerId !== login.userId) await store.patchSettings({ favourites: null });
    await store.mutateCore((c) => {
      c.spotify = { connected: true, needsReauth: false };
    });
    await playback.sync().catch(() => null);
    logger.info('Spotify connected', { account: login.displayName });
    return back({ spotify: 'connected' });
  } catch (err) {
    logger.error('Spotify login failed', { err: err.message });
    return back({ spotify: 'error', reason: 'exchange_failed' });
  }
}));

// ---- errors -----------------------------------------------------------------

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Unknown API route.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'bad_json', message: 'Bad request.' });
    return;
  }
  const e = toUserError(err);
  if (e.status >= 500) logger.error('API error', { path: req.path, err: err.stack || err.message });
  res.status(e.status).json({ error: e.code, message: e.message, ...e.extra });
});

module.exports = app;
