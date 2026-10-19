'use strict';

// A small in-memory stand-in for the Spotify accounts service and Web API, just
// faithful enough to exercise the backend end to end.

const http = require('node:http');

const id22 = (s) => (s + '0000000000000000000000').slice(0, 22);

function makeTrack(key, name, extra = {}) {
  const id = id22(key);
  return {
    type: 'track',
    id,
    uri: `spotify:track:${id}`,
    name,
    artists: [{ name: `${name} Artist` }],
    album: { name: `${name} Album`, images: [{ url: `https://img.example/${key}.jpg`, width: 300, height: 300 }] },
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    duration_ms: 200000,
    explicit: false,
    is_playable: true,
    ...extra,
  };
}

function createFakeSpotify() {
  const catalogue = [
    makeTrack('songA', 'Song A'),
    makeTrack('songB', 'Song B'),
    makeTrack('songC', 'Song C'),
    makeTrack('songD', 'Song D'),
    makeTrack('songLong', 'Song Long', { duration_ms: 9 * 60000 }),
    makeTrack('base1', 'Base One'),
    makeTrack('base2', 'Base Two'),
    makeTrack('base3', 'Base Three'),
  ];
  const byUri = new Map(catalogue.map((t) => [t.uri, t]));
  const contextTracks = catalogue.filter((t) => t.name.startsWith('Base'));

  const s = {
    catalogue,
    accessToken: null,
    refreshToken: null,
    appToken: null,
    lastCatalogueAuth: null,
    rejectRefresh: false,
    me: { id: 'host-user', display_name: 'Host Account' },
    devices: [{ id: 'dev-speaker', name: 'Clock-in iPad', type: 'Tablet', is_active: false, is_restricted: false, is_private_session: false }],
    player: null, // { deviceId, isPlaying, item, progressMs, context, repeat, shuffle, ctxIndex }
    queue: [],
    playlists: {},
    calls: [],
  };

  const activeDevice = () => s.devices.find((d) => d.is_active) || null;
  const setActive = (id) => s.devices.forEach((d) => { d.is_active = d.id === id; });
  const nextFromContext = () => {
    s.player.ctxIndex = (s.player.ctxIndex + 1) % contextTracks.length;
    return contextTracks[s.player.ctxIndex];
  };
  const advance = () => {
    const nextUri = s.queue.shift();
    s.player.item = nextUri ? byUri.get(nextUri) : nextFromContext();
    s.player.progressMs = 0;
  };

  function send(res, status, body) {
    if (body === undefined) {
      res.writeHead(status);
      res.end();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
  const playerError = (res, status, reason, message) => send(res, status, { error: { status, message, reason } });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const path = url.pathname;
    s.calls.push(`${req.method} ${path}`);

    if (path === '/authorize') {
      // Pretend the user approved straight away.
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'good-code');
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { Location: back.toString() });
      res.end();
      return;
    }
    if (path === '/api/token') {
      const p = new URLSearchParams(raw);
      if (p.get('grant_type') === 'authorization_code') {
        if (p.get('code') !== 'good-code') return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
        s.accessToken = 'access-1';
        s.refreshToken = 'refresh-1';
        return send(res, 200, { access_token: s.accessToken, token_type: 'Bearer', expires_in: 3600, refresh_token: s.refreshToken, scope: 'x' });
      }
      if (p.get('grant_type') === 'client_credentials') {
        s.appToken = 'app-token';
        return send(res, 200, { access_token: s.appToken, token_type: 'Bearer', expires_in: 3600 });
      }
      if (p.get('grant_type') === 'refresh_token') {
        if (s.rejectRefresh || p.get('refresh_token') !== s.refreshToken) {
          return send(res, 400, { error: 'invalid_grant', error_description: 'Refresh token expired' });
        }
        s.accessToken = `access-${Date.now()}`;
        return send(res, 200, { access_token: s.accessToken, token_type: 'Bearer', expires_in: 3600, scope: 'x' });
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }

    // Catalogue endpoints accept the app's own token; everything else needs the user's.
    const isCatalogue = path === '/v1/search' || path.startsWith('/v1/tracks/');
    const asApp = Boolean(s.appToken) && req.headers.authorization === `Bearer ${s.appToken}`;
    if (!(isCatalogue && asApp) && req.headers.authorization !== `Bearer ${s.accessToken}`) {
      return send(res, 401, { error: { status: 401, message: 'The access token expired' } });
    }
    if (isCatalogue) s.lastCatalogueAuth = asApp ? 'app' : 'user';
    const body = raw ? JSON.parse(raw) : {};
    const deviceId = url.searchParams.get('device_id');

    if (req.method === 'GET' && path === '/v1/me') return send(res, 200, s.me);
    if (req.method === 'GET' && path === '/v1/me/player/devices') return send(res, 200, { devices: s.devices });
    if (req.method === 'GET' && path === '/v1/me/player') {
      const d = activeDevice();
      if (!d || !s.player) return send(res, 204);
      return send(res, 200, {
        device: d,
        is_playing: s.player.isPlaying,
        item: s.player.item,
        progress_ms: s.player.progressMs,
        context: s.player.context,
        repeat_state: s.player.repeat,
        shuffle_state: s.player.shuffle,
        timestamp: Date.now(),
      });
    }
    if (req.method === 'GET' && path === '/v1/me/player/queue') {
      if (!s.player) return send(res, 200, { currently_playing: null, queue: [] });
      const upcoming = s.queue.map((u) => byUri.get(u));
      for (let i = 1; upcoming.length < 10; i++) upcoming.push(contextTracks[(s.player.ctxIndex + i) % contextTracks.length]);
      return send(res, 200, { currently_playing: s.player.item, queue: upcoming });
    }
    if (req.method === 'POST' && path === '/v1/me/player/queue') {
      if (!activeDevice() && !deviceId) return playerError(res, 404, 'NO_ACTIVE_DEVICE', 'Player command failed: No active device found');
      if (deviceId) setActive(deviceId);
      s.queue.push(url.searchParams.get('uri'));
      return send(res, 200);
    }
    if (req.method === 'PUT' && path === '/v1/me/player') {
      setActive(body.device_ids[0]);
      if (s.player && body.play) s.player.isPlaying = true;
      return send(res, 204);
    }
    if (req.method === 'PUT' && path === '/v1/me/player/play') {
      const target = deviceId || (activeDevice() && activeDevice().id);
      if (!target) return playerError(res, 404, 'NO_ACTIVE_DEVICE', 'Player command failed: No active device found');
      setActive(target);
      if (body.context_uri) {
        s.player = { isPlaying: true, item: contextTracks[0], progressMs: 0, context: { uri: body.context_uri, type: 'playlist' }, repeat: 'off', shuffle: false, ctxIndex: 0 };
      } else if (s.player) {
        s.player.isPlaying = true;
      }
      return send(res, 204);
    }
    if (req.method === 'PUT' && path === '/v1/me/player/pause') {
      if (!s.player || !s.player.isPlaying) return playerError(res, 403, 'ALREADY_PAUSED', 'Player command failed: Restriction violated');
      s.player.isPlaying = false;
      return send(res, 204);
    }
    if (req.method === 'POST' && path === '/v1/me/player/next') {
      if (!s.player) return playerError(res, 404, 'NO_ACTIVE_DEVICE', 'Player command failed: No active device found');
      advance();
      return send(res, 204);
    }
    if (req.method === 'PUT' && path === '/v1/me/player/repeat') {
      s.player.repeat = url.searchParams.get('state');
      return send(res, 204);
    }
    if (req.method === 'PUT' && path === '/v1/me/player/shuffle') {
      s.player.shuffle = url.searchParams.get('state') === 'true';
      return send(res, 204);
    }
    if (req.method === 'GET' && path.startsWith('/v1/tracks/')) {
      const t = catalogue.find((x) => x.id === path.split('/').pop());
      return t ? send(res, 200, t) : send(res, 404, { error: { status: 404, message: 'Not found' } });
    }
    if (req.method === 'GET' && path === '/v1/search') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      if (Number(url.searchParams.get('limit')) > 10) return send(res, 400, { error: { status: 400, message: 'Invalid limit' } });
      const items = catalogue.filter((t) => t.name.toLowerCase().includes(q));
      return send(res, 200, { tracks: { items, total: items.length, next: null } });
    }
    if (req.method === 'GET' && path === '/v1/me/playlists') {
      const mix = { id: id22('mix'), uri: `spotify:playlist:${id22('mix')}`, name: 'Warehouse Mix', owner: { display_name: 'Host Account' }, images: [], items: { total: 3 } };
      return send(res, 200, { items: [mix, null] });
    }
    if (req.method === 'POST' && path === '/v1/me/playlists') {
      const pid = id22(`pl${Object.keys(s.playlists).length}`);
      s.playlists[pid] = { id: pid, name: body.name, public: body.public, uris: [] };
      return send(res, 201, { id: pid, uri: `spotify:playlist:${pid}`, external_urls: { spotify: `https://open.spotify.com/playlist/${pid}` } });
    }
    const items = /^\/v1\/playlists\/([^/]+)\/items$/.exec(path);
    if (req.method === 'PUT' && items) {
      const pl = s.playlists[items[1]];
      if (!pl) return send(res, 404, { error: { status: 404, message: 'Not found' } });
      pl.uris = body.uris;
      return send(res, 200, { snapshot_id: 'snap' });
    }
    return send(res, 404, { error: { status: 404, message: `fake: no route ${req.method} ${path}` } });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      send(res, 500, { error: { status: 500, message: err.message } });
    });
  });
  return { state: s, server, catalogue, contextTracks };
}

module.exports = { createFakeSpotify };
