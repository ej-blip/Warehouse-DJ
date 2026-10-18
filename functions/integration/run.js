'use strict';

// End-to-end test of the backend: the real Express app and Firestore code, against the
// Firestore emulator and a fake Spotify. Run with `npm run test:integration` (needs the
// Firebase CLI and Java).

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createFakeSpotify } = require('./fake-spotify');

const fake = createFakeSpotify();
let base; // URL of the backend under test
let mods; // backend modules, required after the environment is set
let ownerToken;
let ipad1;
let ipad2;
let server;

const MIN = 60000;

async function call(method, path, { body, device, admin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (device) headers['X-Device-Token'] = device;
  if (admin) headers.Authorization = `Bearer ${admin}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const json = (res.headers.get('content-type') || '').includes('application/json');
  return { status: res.status, body: json ? await res.json() : null, location: res.headers.get('location') };
}

async function publicState() {
  return (await mods.store.refs.state.get()).data();
}

before(async () => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'run this through `firebase emulators:exec`');
  await new Promise((r) => fake.server.listen(0, '127.0.0.1', r));
  const port = fake.server.address().port;
  Object.assign(process.env, {
    SPOTIFY_API_BASE: `http://127.0.0.1:${port}/v1`,
    SPOTIFY_ACCOUNTS_BASE: `http://127.0.0.1:${port}`,
    SITE_URL: 'http://localhost:5000',
    SPOTIFY_CLIENT_SECRET: 'test-client-secret',
    ADMIN_SETUP_CODE: 'let-me-in',
  });
  mods = {
    app: require('../src/api'),
    store: require('../src/store'),
    playback: require('../src/playback'),
    favourites: require('../src/favourites'),
  };
  server = http.createServer(mods.app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fake.server.close();
});

test('first admin is created with the setup code; PINs work; lockout kicks in', async () => {
  assert.deepEqual((await call('GET', '/api/admin/status')).body, { hasAdmins: false });
  assert.equal((await call('POST', '/api/admin/setup', { body: { code: 'nope', name: 'Ethan', pin: '123456' } })).status, 401);
  assert.equal((await call('POST', '/api/admin/setup', { body: { code: 'let-me-in', name: 'Ethan', pin: '12' } })).status, 400);
  const setup = await call('POST', '/api/admin/setup', { body: { code: 'let-me-in', name: 'Ethan', pin: '123456' } });
  assert.equal(setup.status, 200);
  assert.equal(setup.body.admin.owner, true);
  ownerToken = setup.body.token;

  const login = await call('POST', '/api/admin/login', { body: { pin: '123456' } });
  assert.equal(login.status, 200);
  assert.equal((await call('GET', '/api/admin/overview')).status, 401);
  assert.equal((await call('GET', '/api/admin/overview', { admin: login.body.token })).status, 200);

  // A second admin can sign in but can't manage admins.
  assert.equal((await call('POST', '/api/admin/admins', { admin: ownerToken, body: { name: 'Sam', pin: '123456' } })).body.error, 'pin_taken');
  assert.equal((await call('POST', '/api/admin/admins', { admin: ownerToken, body: { name: 'Sam', pin: '654321' } })).status, 200);
  const sam = await call('POST', '/api/admin/login', { body: { pin: '654321' } });
  assert.equal((await call('POST', '/api/admin/admins', { admin: sam.body.token, body: { name: 'X', pin: '111111' } })).status, 403);
});

test('Spotify login through the OAuth callback', async () => {
  const before = await call('GET', '/api/admin/overview', { admin: ownerToken });
  assert.equal(before.body.spotify.connected, false);
  const connect = await call('POST', '/api/admin/spotify/connect', { admin: ownerToken, body: {} });
  const authUrl = new URL(connect.body.url);
  assert.equal(authUrl.searchParams.get('redirect_uri'), 'http://localhost:5000/api/auth/callback');
  assert.match(authUrl.searchParams.get('scope'), /user-modify-playback-state/);
  const state = authUrl.searchParams.get('state');

  const bad = await call('GET', `/api/auth/callback?code=good-code&state=${'x'.repeat(32)}`);
  assert.equal(bad.location, '/admin?spotify=error&reason=expired');
  const ok = await call('GET', `/api/auth/callback?code=good-code&state=${state}`);
  assert.equal(ok.location, '/admin?spotify=connected');
  // A state can only be used once.
  assert.equal((await call('GET', `/api/auth/callback?code=good-code&state=${state}`)).location, '/admin?spotify=error&reason=expired');

  const after = await call('GET', '/api/admin/overview', { admin: ownerToken });
  assert.equal(after.body.spotify.connected, true);
  assert.equal(after.body.spotify.displayName, 'Host Account');
});

test('settings: validation, speaker choice, and an always-open schedule for testing', async () => {
  const bad = await call('PUT', '/api/admin/settings', { admin: ownerToken, body: { open: '17:00', close: '09:00' } });
  assert.equal(bad.status, 400);
  const ok = await call('PUT', '/api/admin/settings', {
    admin: ownerToken,
    body: { days: [1, 2, 3, 4, 5, 6, 7], open: '00:00', close: '23:59', breaks: [], speakerDeviceName: 'Clock-in iPad' },
  });
  assert.equal(ok.status, 200);
  const speakers = await call('GET', '/api/admin/speakers', { admin: ownerToken });
  assert.equal(speakers.body.devices[0].name, 'Clock-in iPad');
});

test('iPads get links; unknown and switched-off iPads are refused', async () => {
  const a = await call('POST', '/api/admin/devices', { admin: ownerToken, body: { name: 'Packing 1' } });
  const b = await call('POST', '/api/admin/devices', { admin: ownerToken, body: { name: 'Dispatch' } });
  assert.match(a.body.link, /^http:\/\/localhost:5000\/\?t=[a-f0-9]{10}\./);
  ipad1 = a.body.token;
  ipad2 = b.body.token;

  const me = await call('GET', '/api/me', { device: ipad1 });
  assert.equal(me.body.device.name, 'Packing 1');
  assert.equal(me.body.quota.remaining, 3);
  assert.equal((await call('GET', '/api/me', { device: `${ipad1.split('.')[0]}.${'A'.repeat(32)}` })).status, 401);
  assert.equal((await call('GET', '/api/me')).status, 401);
});

test('starting playlist plays on the speaker and shows up on the iPads', async () => {
  const play = await call('POST', '/api/admin/playlist/play', { admin: ownerToken, body: { uri: `spotify:playlist:${'b'.repeat(22)}`, name: 'Warehouse Mix' } });
  assert.equal(play.status, 200);
  const pub = await publicState();
  assert.equal(pub.nowPlaying.name, 'Base One');
  assert.equal(pub.nowPlaying.requestedBy, null);
  assert.equal(pub.context.name, 'Warehouse Mix');
  assert.equal(pub.speaker.status, 'online');
  assert.equal(pub.spotify.connected, true);
});

test('search results are capped at 10 and flag songs that break the rules', async () => {
  const r = await call('GET', '/api/search?q=song', { device: ipad1 });
  assert.equal(r.status, 200);
  const long = r.body.tracks.find((t) => t.name === 'Song Long');
  assert.equal(long.blocked.code, 'too_long');
  assert.equal(r.body.tracks.find((t) => t.name === 'Song A').blocked, null);
});

test('queueing enforces 3 songs per iPad, no duplicates, and fills Up Next', async () => {
  const [A, B, C, D] = fake.catalogue;
  const q = (device, track) => call('POST', '/api/queue', { device, body: { uri: track.uri } });

  assert.equal((await q(ipad1, A)).body.position, 1);
  assert.equal((await q(ipad1, B)).body.position, 2);
  const third = await q(ipad1, C);
  assert.equal(third.body.position, 3);
  assert.equal(third.body.quota.remaining, 0);

  const fourth = await q(ipad1, D);
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.error, 'quota');
  assert.ok(fourth.body.retryAt > Date.now() + 29 * MIN);

  assert.equal((await q(ipad2, A)).body.error, 'in_queue');
  assert.equal((await call('POST', '/api/queue', { device: ipad2, body: { uri: 'spotify:album:xyz' } })).body.error, 'not_track');

  const pub = await publicState();
  assert.deepEqual(pub.upNext.map((t) => [t.name, t.deviceName]), [['Song A', 'Packing 1'], ['Song B', 'Packing 1'], ['Song C', 'Packing 1']]);
  assert.deepEqual(fake.state.queue, [A.uri, B.uri, C.uri]);
});

test('skip moves to the requested song, credits its iPad, and has a cooldown', async () => {
  assert.equal((await call('POST', '/api/skip', { device: ipad2, body: {} })).status, 200);
  const pub = await publicState();
  assert.equal(pub.nowPlaying.name, 'Song A');
  assert.equal(pub.nowPlaying.requestedBy, 'Packing 1');
  assert.deepEqual(pub.upNext.map((t) => t.name), ['Song B', 'Song C']);
  assert.equal(pub.recent[0].name, 'Base One');

  const again = await call('POST', '/api/skip', { device: ipad2, body: {} });
  assert.equal(again.status, 429);
  assert.equal(again.body.error, 'skip_cooldown');
});

test('likes count once per iPad', async () => {
  assert.deepEqual((await call('POST', '/api/like', { device: ipad2, body: {} })).body, { ok: true, already: false, likes: 1 });
  assert.equal((await call('POST', '/api/like', { device: ipad2, body: {} })).body.already, true);
  assert.equal((await call('POST', '/api/like', { device: ipad1, body: {} })).body.likes, 2);
  assert.equal((await publicState()).nowPlaying.likes, 2);
});

test('pause and play from an iPad', async () => {
  await call('POST', '/api/pause', { device: ipad1, body: {} });
  assert.equal((await publicState()).nowPlaying.isPlaying, false);
  // Pausing twice is harmless.
  assert.equal((await call('POST', '/api/pause', { device: ipad1, body: {} })).status, 200);
  await call('POST', '/api/play', { device: ipad1, body: {} });
  assert.equal((await publicState()).nowPlaying.isPlaying, true);
});

test('a queue lost during a long pause is re-added when music comes back', async () => {
  const [, B, C] = fake.catalogue;
  fake.state.player.isPlaying = false;
  await mods.playback.sync();
  // Pretend the pause started 20 minutes ago and that Spotify forgot its queue (iOS
  // closed the app during the break).
  await mods.store.mutateCore((c) => {
    c.pausedSince = Date.now() - 20 * MIN;
    for (const p of c.pending) p.queuedAt -= 25 * MIN;
  });
  fake.state.queue = [];
  fake.state.player.isPlaying = true;
  await mods.playback.sync();
  assert.deepEqual(fake.state.queue, [B.uri, C.uri]);
  assert.deepEqual((await publicState()).upNext.map((t) => t.name), ['Song B', 'Song C']);
});

test('queueing with no active device wakes the speaker without starting music', async () => {
  const [, , , D] = fake.catalogue;
  fake.state.devices[0].is_active = false;
  fake.state.player.isPlaying = false;
  const r = await call('POST', '/api/queue', { device: ipad2, body: { uri: D.uri } });
  assert.equal(r.status, 200);
  assert.equal(fake.state.devices[0].is_active, true);
  assert.equal(fake.state.player.isPlaying, false);
  assert.ok(fake.state.queue.includes(D.uri));
  fake.state.player.isPlaying = true;
});

test('breaks pause the music and resume it afterwards', async () => {
  const settings = { ...(await mods.store.getSettings({ fresh: true })), breaks: [{ start: '10:20', minutes: 20 }], autoPause: true, autoResume: true };
  // Monday 19 Oct 2026, Melbourne (UTC+11).
  const at = (h, m) => Date.UTC(2026, 9, 19, h, m) - 11 * 3600000;
  assert.equal(await mods.playback.handleBreaks(settings, at(10, 21)), 'paused');
  assert.equal(fake.state.player.isPlaying, false);
  assert.equal(await mods.playback.handleBreaks(settings, at(10, 22)), null); // only once per break
  assert.equal(await mods.playback.handleBreaks(settings, at(10, 41)), 'resumed');
  assert.equal(fake.state.player.isPlaying, true);
  assert.equal(await mods.playback.handleBreaks(settings, at(10, 42)), null);
});

test('weekly favourites: liked songs first, then queued ones', async () => {
  const r = await call('POST', '/api/admin/favourites/rebuild', { admin: ownerToken, body: {} });
  assert.equal(r.status, 200);
  const pl = fake.state.playlists[r.body.playlistId];
  assert.equal(pl.public, false);
  assert.equal(pl.uris[0], fake.catalogue[0].uri); // Song A: 2 likes
  assert.equal(pl.uris.length, 4);
  // Rebuilding reuses the same playlist.
  const again = await call('POST', '/api/admin/favourites/rebuild', { admin: ownerToken, body: {} });
  assert.equal(again.body.playlistId, r.body.playlistId);
  const preview = await call('GET', '/api/admin/favourites', { admin: ownerToken });
  assert.equal(preview.body.thisWeek.top[0].likes, 2);
});

test('switched-off iPads cannot queue', async () => {
  const id = ipad2.split('.')[0];
  await call('PATCH', `/api/admin/devices/${id}`, { admin: ownerToken, body: { enabled: false } });
  const r = await call('POST', '/api/queue', { device: ipad2, body: { uri: fake.catalogue[4].uri } });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'device_off');
});

test('wrong PINs lock sign-in for a while', async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await call('POST', '/api/admin/login', { body: { pin: '000000' } });
  assert.equal(last.status, 429);
  assert.equal(last.body.error, 'locked');
});

test('an expired Spotify login is reported, not retried forever', async () => {
  fake.state.rejectRefresh = true;
  fake.state.accessToken = 'rotated-away';
  await mods.store.refs.spotify.set({ expiresAt: 0 }, { merge: true });
  await assert.rejects(mods.playback.sync(), /expired/);
  const pub = await publicState();
  assert.equal(pub.spotify.connected, false);
  assert.equal(pub.spotify.needsReauth, true);
  const r = await call('POST', '/api/play', { device: ipad1, body: {} });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'spotify_disconnected');
});
