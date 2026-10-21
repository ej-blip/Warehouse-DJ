'use strict';

// Warehouse playlists: the newest weekly favourites plus the ones admins add. Everyone
// can open them and queue songs one at a time. The host's own playlists never appear here.

const spotify = require('./spotify');
const store = require('./store');
const weekly = require('./weekly');
const { UserError, SpotifyError, toUserError } = require('./errors');
const { MAX_WAREHOUSE_PLAYLISTS } = require('./config');

const PLAYLIST_ID = /^[A-Za-z0-9]{22}$/;
const CACHE_MS = 5 * 60000;
const pageCache = new Map(); // `${id}:${offset}` -> { at, page }

const blocked = (err) => err instanceof SpotifyError && (err.status === 403 || err.status === 404);

const weeklyEntry = (p) => ({
  id: p.playlistId,
  uri: p.uri,
  name: p.name,
  owner: 'Weekly favourites',
  imageUrl: null,
  kind: 'weekly',
  browsable: true,
  trackCount: p.trackCount || null,
  spotifyUrl: p.url || null,
});

// What the iPads list: weekly favourites, newest first, then the admin-added ones.
function warehouseList(settings) {
  const start = weekly.startingPlaylist(settings);
  return [
    ...weekly.visible(settings.weeklyPlaylists).map(weeklyEntry),
    ...(settings.warehousePlaylists || []).map((p) => ({ ...p, kind: 'saved' })),
  ].map((p) => ({ ...p, starting: Boolean(start && start.id === p.id) }));
}

// The admin page also sees archived weekly playlists and which one music starts from.
function adminList(settings) {
  const start = weekly.startingPlaylist(settings);
  return {
    playlists: warehouseList(settings),
    archived: weekly.archived(settings.weeklyPlaylists).map(weeklyEntry),
    starting: start,
    defaultPlaylistId: start && start.chosen ? start.id : null,
  };
}

// Switch on the playlist music starts from, or pass null to go back to the newest weekly one.
async function setDefault(id) {
  const settings = await store.getSettings({ fresh: true });
  if (id !== null && !warehouseList(settings).some((p) => p.id === id)) {
    throw new UserError('not_found', "That playlist isn't on the warehouse list.", 404);
  }
  await store.patchSettings({ defaultPlaylistId: id });
}

async function fetchPage(id, offset) {
  const key = `${id}:${offset}`;
  const hit = pageCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.page;
  const data = await spotify.playlistItems(id, offset);
  // Spotify renamed each entry's "track" to "item" in 2026; accept either.
  const tracks = ((data && data.items) || [])
    .map((entry) => spotify.normalizeTrack(entry && (entry.item || entry.track)))
    .filter(Boolean);
  const page = { tracks, total: (data && data.total) || tracks.length, more: Boolean(data && data.next) };
  pageCache.set(key, { at: Date.now(), page });
  return page;
}

function forget(id) {
  for (const key of pageCache.keys()) if (key.startsWith(`${id}:`)) pageCache.delete(key);
}

async function tracksFor(settings, id, offset = 0) {
  const entry = warehouseList(settings).find((p) => p.id === id);
  if (!entry || !entry.browsable) throw new UserError('not_found', "That playlist isn't on the warehouse list.", 404);
  try {
    return await fetchPage(id, offset);
  } catch (err) {
    if (blocked(err)) throw new UserError('playlist_hidden', "Spotify won't let the app show this playlist's songs.", 409);
    throw toUserError(err);
  }
}

// Spotify stops apps reading some playlists (its own editorial ones, for example), even
// though they can still be played. Those stay admin-only, for starting music.
async function canBrowse(id) {
  try {
    await spotify.playlistItems(id, 0, 1);
    return true;
  } catch (err) {
    if (blocked(err)) return false;
    throw toUserError(err);
  }
}

async function add(playlist) {
  const id = String((playlist && playlist.id) || '');
  if (!PLAYLIST_ID.test(id)) throw new UserError('bad_playlist', "That isn't a playlist.");
  const settings = await store.getSettings({ fresh: true });
  const current = settings.warehousePlaylists || [];
  if (current.some((p) => p.id === id) || (settings.weeklyPlaylists || []).some((p) => p.playlistId === id)) {
    throw new UserError('already_added', "That playlist's already on the list.");
  }
  if (current.length >= MAX_WAREHOUSE_PLAYLISTS) {
    throw new UserError('too_many', `The list holds ${MAX_WAREHOUSE_PLAYLISTS} playlists. Remove one first.`);
  }
  const entry = {
    id,
    uri: `spotify:playlist:${id}`,
    name: String(playlist.name || 'Playlist').slice(0, 100),
    owner: String(playlist.owner || '').slice(0, 100),
    imageUrl: typeof playlist.imageUrl === 'string' && playlist.imageUrl.startsWith('https://') ? playlist.imageUrl : null,
    browsable: await canBrowse(id),
    trackCount: Number.isInteger(playlist.trackCount) && playlist.trackCount >= 0 ? playlist.trackCount : null,
  };
  await store.patchSettings({ warehousePlaylists: [...current, entry] });
  return entry;
}

async function remove(id) {
  const settings = await store.getSettings({ fresh: true });
  await store.patchSettings({
    warehousePlaylists: (settings.warehousePlaylists || []).filter((p) => p.id !== id),
    ...(settings.defaultPlaylistId === id ? { defaultPlaylistId: null } : {}),
  });
  forget(id);
}

module.exports = { warehouseList, adminList, setDefault, tracksFor, add, remove, forget };
