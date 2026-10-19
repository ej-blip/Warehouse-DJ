'use strict';

// Thin Spotify Web API client for the one host account. Handles token refresh,
// 401/429/5xx retries, and turns Spotify's error objects into SpotifyError.

const { logger } = require('firebase-functions');
const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_REDIRECT_URI,
  SPOTIFY_SCOPES,
  SPOTIFY_MARKET,
  SPOTIFY_API_BASE,
  SPOTIFY_ACCOUNTS_BASE,
  SPOTIFY_LOGIN_LIFETIME_DAYS,
  SEARCH_PAGE_SIZE,
} = require('./config');
const { SPOTIFY_CLIENT_SECRET } = require('./secrets');
const { SpotifyError, SpotifyAuthError } = require('./errors');
const store = require('./store');

const TIMEOUT_MS = 10000;
const EXPIRY_MARGIN_MS = 60000;
const DAY = 86400000;

let cachedToken = null; // { accessToken, expiresAt } for this instance
let cachedAppToken = null; // same, for the app's own (no user) token
let pausedUntil = 0; // set when Spotify answers 429

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- login -----------------------------------------------------------------

function authorizeUrl(state) {
  const url = new URL(`${SPOTIFY_ACCOUNTS_BASE}/authorize`);
  url.search = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: SPOTIFY_SCOPES.join(' '),
    state,
    show_dialog: 'true',
  }).toString();
  return url.toString();
}

async function tokenRequest(params) {
  const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET.value()}`).toString('base64');
  const res = await fetch(`${SPOTIFY_ACCOUNTS_BASE}/api/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function exchangeCode(code) {
  const r = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: SPOTIFY_REDIRECT_URI });
  if (!r.ok) {
    throw new SpotifyError({ status: r.status, reason: r.data.error, message: r.data.error_description || 'Spotify login failed.' });
  }
  const now = Date.now();
  const accessToken = r.data.access_token;
  const me = await call('GET', '/me', { token: accessToken });
  const doc = {
    accessToken,
    refreshToken: r.data.refresh_token,
    expiresAt: now + r.data.expires_in * 1000,
    scope: r.data.scope || '',
    authorizedAt: now,
    userId: me.id,
    displayName: me.display_name || me.id,
    needsReauth: false,
  };
  await store.refs.spotify.set(doc);
  cachedToken = { accessToken, expiresAt: doc.expiresAt };
  return doc;
}

async function loadLogin() {
  const snap = await store.refs.spotify.get();
  return snap.exists ? snap.data() : null;
}

// What the admin page shows about the Spotify login.
async function loginStatus() {
  const doc = await loadLogin();
  if (!doc || !doc.refreshToken) return { connected: false, needsReauth: false };
  return {
    connected: !doc.needsReauth,
    needsReauth: Boolean(doc.needsReauth),
    displayName: doc.displayName || null,
    userId: doc.userId || null,
    authorizedAt: doc.authorizedAt || null,
    expiresAround: doc.authorizedAt ? doc.authorizedAt + SPOTIFY_LOGIN_LIFETIME_DAYS * DAY : null,
  };
}

async function markNeedsReauth(detail) {
  cachedToken = null;
  await store.refs.spotify.set({ needsReauth: true, needsReauthAt: Date.now(), needsReauthDetail: detail || null }, { merge: true });
  await store.mutateCore((c) => {
    c.spotify = { connected: false, needsReauth: true };
  });
}

async function accessToken({ force = false } = {}) {
  if (!force && cachedToken && cachedToken.expiresAt - Date.now() > EXPIRY_MARGIN_MS) return cachedToken.accessToken;

  const doc = await loadLogin();
  if (!doc || !doc.refreshToken) throw new SpotifyAuthError('Spotify is not connected.');
  if (doc.needsReauth) throw new SpotifyAuthError('Spotify login has expired.', { needsReauth: true });
  if (!force && doc.accessToken && doc.expiresAt - Date.now() > EXPIRY_MARGIN_MS) {
    cachedToken = { accessToken: doc.accessToken, expiresAt: doc.expiresAt };
    return doc.accessToken;
  }

  const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: doc.refreshToken });
  if (!r.ok) {
    // Another instance may have just refreshed and been handed a new refresh token.
    const latest = await loadLogin();
    if (latest && latest.refreshToken !== doc.refreshToken && latest.expiresAt - Date.now() > EXPIRY_MARGIN_MS) {
      cachedToken = { accessToken: latest.accessToken, expiresAt: latest.expiresAt };
      return latest.accessToken;
    }
    if (r.data.error === 'invalid_grant') {
      // The 6-month login has run out or was revoked. Retrying won't help.
      logger.warn('Spotify refresh token rejected; admin must reconnect', { detail: r.data.error_description });
      await markNeedsReauth(r.data.error_description);
      throw new SpotifyAuthError('Spotify login has expired.', { needsReauth: true });
    }
    throw new SpotifyError({ status: r.status, reason: r.data.error, message: 'Could not refresh the Spotify login.' });
  }

  const update = { accessToken: r.data.access_token, expiresAt: Date.now() + r.data.expires_in * 1000 };
  if (r.data.refresh_token) update.refreshToken = r.data.refresh_token;
  await store.refs.spotify.set(update, { merge: true });
  cachedToken = { accessToken: update.accessToken, expiresAt: update.expiresAt };
  return update.accessToken;
}

// A token for the app itself rather than the host account. Searches use it so results
// aren't ranked by the host's own likes and listening history.
async function appToken({ force = false } = {}) {
  if (!force && cachedAppToken && cachedAppToken.expiresAt - Date.now() > EXPIRY_MARGIN_MS) return cachedAppToken.accessToken;
  const r = await tokenRequest({ grant_type: 'client_credentials' });
  if (!r.ok) throw new SpotifyError({ status: r.status, reason: r.data.error, message: 'Could not get an app token from Spotify.' });
  cachedAppToken = { accessToken: r.data.access_token, expiresAt: Date.now() + r.data.expires_in * 1000 };
  return cachedAppToken.accessToken;
}

// ---- requests --------------------------------------------------------------

// `as: 'app'` sends the request as the app instead of the host account.
async function call(method, path, { query, body, token, as = 'user', retry = true } = {}) {
  if (Date.now() < pausedUntil) {
    const retryAfter = Math.ceil((pausedUntil - Date.now()) / 1000);
    throw new SpotifyError({ status: 429, reason: 'RATE_LIMITED', message: 'Spotify asked us to slow down.', retryAfter });
  }
  const url = new URL(SPOTIFY_API_BASE + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const bearer = token || (as === 'app' ? await appToken() : await accessToken());
  const again = () => call(method, path, { query, body, token, as, retry: false });

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      // Spotify wants a Content-Length on bodiless PUT/POST.
      body: body !== undefined ? JSON.stringify(body) : method === 'GET' ? undefined : '',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (retry) {
      await sleep(400);
      return again();
    }
    throw new SpotifyError({ status: 0, reason: 'NETWORK', message: `Could not reach Spotify: ${err.message}` });
  }

  if (res.status === 401 && !token && retry) {
    if (as === 'app') await appToken({ force: true });
    else await accessToken({ force: true });
    return again();
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after')) || 5;
    if (retry && retryAfter <= 3) {
      await sleep(retryAfter * 1000);
      return again();
    }
    pausedUntil = Date.now() + retryAfter * 1000;
    logger.warn('Spotify rate limit hit', { path, retryAfter });
    throw new SpotifyError({ status: 429, reason: 'RATE_LIMITED', message: 'Spotify asked us to slow down.', retryAfter });
  }
  if (res.status >= 500 && retry) {
    await sleep(500);
    return again();
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const e = (data && typeof data.error === 'object' && data.error) || {};
    throw new SpotifyError({ status: res.status, reason: e.reason || null, message: e.message || `Spotify returned ${res.status} for ${path}` });
  }
  return data; // null for 204 No Content
}

// ---- shapes ----------------------------------------------------------------

function normalizeTrack(t) {
  if (!t || !t.id || (t.type && t.type !== 'track')) return null; // local files have no id
  const images = (t.album && t.album.images) || [];
  const image = images.find((i) => i.width && i.width >= 200 && i.width <= 320) || images[1] || images[0];
  return {
    id: t.id,
    uri: t.uri || `spotify:track:${t.id}`,
    name: t.name,
    artists: (t.artists || []).map((a) => a.name).filter(Boolean),
    album: t.album ? t.album.name : '',
    imageUrl: image ? image.url : null,
    spotifyUrl: (t.external_urls && t.external_urls.spotify) || `https://open.spotify.com/track/${t.id}`,
    durationMs: t.duration_ms || 0,
    explicit: Boolean(t.explicit),
    playable: t.is_playable !== false,
  };
}

function normalizePlaylist(p) {
  if (!p || !p.id) return null; // Spotify's playlist search can return null entries
  const images = p.images || [];
  const count = (p.items && p.items.total) ?? (p.tracks && p.tracks.total) ?? null;
  return {
    id: p.id,
    uri: p.uri || `spotify:playlist:${p.id}`,
    name: p.name,
    owner: (p.owner && (p.owner.display_name || p.owner.id)) || '',
    imageUrl: (images[images.length > 1 ? 1 : 0] || {}).url || null,
    spotifyUrl: (p.external_urls && p.external_urls.spotify) || `https://open.spotify.com/playlist/${p.id}`,
    trackCount: count,
  };
}

// ---- endpoints -------------------------------------------------------------

const market = SPOTIFY_MARKET;

module.exports = {
  authorizeUrl,
  exchangeCode,
  loginStatus,
  accessToken,
  call,
  normalizeTrack,
  normalizePlaylist,

  playback: () => call('GET', '/me/player', { query: { market, additional_types: 'track' } }),
  devices: async () => ((await call('GET', '/me/player/devices')) || {}).devices || [],
  queue: () => call('GET', '/me/player/queue'),
  addToQueue: (uri, deviceId) => call('POST', '/me/player/queue', { query: { uri, device_id: deviceId } }),
  play: (deviceId, body) => call('PUT', '/me/player/play', { query: { device_id: deviceId }, body }),
  pause: (deviceId) => call('PUT', '/me/player/pause', { query: { device_id: deviceId } }),
  next: (deviceId) => call('POST', '/me/player/next', { query: { device_id: deviceId } }),
  transfer: (deviceId, play) => call('PUT', '/me/player', { body: { device_ids: [deviceId], play } }),
  setRepeat: (state, deviceId) => call('PUT', '/me/player/repeat', { query: { state, device_id: deviceId } }),
  setShuffle: (on, deviceId) => call('PUT', '/me/player/shuffle', { query: { state: on ? 'true' : 'false', device_id: deviceId } }),
  // Catalogue lookups go out as the app, so nothing about the host account shapes them.
  track: (id) => call('GET', `/tracks/${encodeURIComponent(id)}`, { query: { market }, as: 'app' }),
  searchTracks: (q, offset = 0) => call('GET', '/search', { query: { q, type: 'track', market, limit: SEARCH_PAGE_SIZE, offset }, as: 'app' }),
  searchPlaylists: (q, offset = 0) => call('GET', '/search', { query: { q, type: 'playlist', market, limit: SEARCH_PAGE_SIZE, offset }, as: 'app' }),
  myPlaylists: () => call('GET', '/me/playlists', { query: { limit: 50 } }),
  createPlaylist: (name, description) => call('POST', '/me/playlists', { body: { name, description, public: false } }),
  // Spotify renamed /tracks to /items in February 2026; the old path is refused in Development Mode.
  replacePlaylistItems: (id, uris) => call('PUT', `/playlists/${encodeURIComponent(id)}/items`, { body: { uris } }),
};
