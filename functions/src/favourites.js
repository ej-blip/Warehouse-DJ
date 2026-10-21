'use strict';

// Weekly favourites: every Sunday night (or when an admin asks) a new numbered playlist,
// "Warehouse Favourites #3 · 26 Oct – 1 Nov", is made from the songs queued and liked
// since the previous one. Older ones are archived, never deleted. Admins can add and
// remove songs; nothing rebuilds a playlist once it's made, so edits stick.

const { logger } = require('firebase-functions');
const spotify = require('./spotify');
const store = require('./store');
const playlists = require('./playlists');
const weekly = require('./weekly');
const { weekKeyAt } = require('./time');
const { FAVOURITES_MAX_TRACKS, PLAYLIST_PAGE_SIZE } = require('./config');
const { UserError, toUserError } = require('./errors');

const DAY = 86400000;
// The first playlist, or one after a long gap, looks back at most this far.
const FIRST_LOOKBACK_MS = 7 * DAY;
const MAX_LOOKBACK_MS = 8 * 7 * DAY;
const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;

// Most liked first, then most often queued, then queued from the most iPads.
function rank(tracks) {
  return [...tracks].sort(
    (a, b) =>
      (b.likes || 0) - (a.likes || 0) ||
      (b.queued || 0) - (a.queued || 0) ||
      (b.devices || []).length - (a.devices || []).length ||
      (b.lastAt || 0) - (a.lastAt || 0),
  );
}

// Songs queued or liked since `since`, combined across the weekly tallies they're kept in.
async function tracksSince(since, now = Date.now()) {
  const keys = new Set([weekKeyAt(now)]);
  for (let t = Math.max(since, now - MAX_LOOKBACK_MS); t < now; t += DAY) keys.add(weekKeyAt(t));
  const merged = new Map();
  for (const key of keys) {
    const snap = await store.db.collection(`weeks/${key}/tracks`).get();
    for (const doc of snap.docs) {
      const t = doc.data();
      if (!t.uri || (t.lastAt || 0) < since) continue;
      const m = merged.get(t.trackId);
      merged.set(t.trackId, m
        ? {
            ...t,
            likes: (m.likes || 0) + (t.likes || 0),
            queued: (m.queued || 0) + (t.queued || 0),
            devices: [...new Set([...(m.devices || []), ...(t.devices || [])])],
            lastAt: Math.max(m.lastAt || 0, t.lastAt || 0),
          }
        : t);
    }
  }
  return rank([...merged.values()]);
}

function sinceFor(list, now) {
  const prev = weekly.latest(list);
  return prev ? prev.madeAt : now - FIRST_LOOKBACK_MS;
}

// What the next playlist would hold if it were made now.
async function preview(now = Date.now()) {
  const settings = await store.getSettings({ fresh: true });
  const list = settings.weeklyPlaylists || [];
  const tracks = await tracksSince(sinceFor(list, now), now);
  return {
    latest: weekly.latest(list),
    total: tracks.length,
    top: tracks.slice(0, 20).map((t) => ({
      trackId: t.trackId,
      name: t.name,
      artists: t.artists,
      imageUrl: t.imageUrl,
      likes: t.likes || 0,
      queued: t.queued || 0,
    })),
  };
}

// The playlist that used to be rebuilt every week takes its new "#1" name in Spotify too.
async function renameOld(list) {
  const out = [];
  for (const p of list) {
    if (p.renamed === false) {
      await spotify.renamePlaylist(p.playlistId, p.name, `Songs queued and liked on the warehouse iPads, ${p.label}.`)
        .catch((err) => logger.warn('Could not rename an old favourites playlist', { name: p.name, err: err.message }));
      out.push({ ...p, renamed: true });
    } else {
      out.push(p);
    }
  }
  return out;
}

async function build({ now = Date.now() } = {}) {
  const login = await spotify.loginStatus();
  if (!login.connected) throw new UserError('spotify_disconnected', 'Connect Spotify first.', 503);
  const settings = await store.getSettings({ fresh: true });
  const list = settings.weeklyPlaylists || [];
  const prev = weekly.latest(list);
  const since = sinceFor(list, now);

  const tracks = await tracksSince(since, now);
  if (!tracks.length) {
    const message = prev
      ? `No songs have been queued or liked since ${prev.name} was made, so no new playlist was made.`
      : 'No songs have been queued or liked this week, so no playlist was made.';
    logger.info('No new favourites', { since });
    return { skipped: true, message };
  }

  const uris = tracks.slice(0, FAVOURITES_MAX_TRACKS).map((t) => t.uri);
  const number = list.reduce((n, p) => Math.max(n, p.number || 0), 0) + 1;
  const label = weekly.labelFor(since, now, settings.musicEnd);
  const name = weekly.nameFor(number, label);
  let created;
  try {
    created = await spotify.createPlaylist(name, `Songs queued and liked on the warehouse iPads, ${label}.`);
    await spotify.replacePlaylistItems(created.id, uris);
  } catch (err) {
    throw toUserError(err);
  }

  const entry = {
    playlistId: created.id,
    uri: created.uri || `spotify:playlist:${created.id}`,
    url: (created.external_urls && created.external_urls.spotify) || `https://open.spotify.com/playlist/${created.id}`,
    ownerId: login.userId,
    number,
    name,
    label,
    madeAt: now,
    trackCount: uris.length,
    archived: false,
    kept: false,
  };
  const before = await renameOld(list);
  const next = weekly.autoArchive([...before, entry], settings.defaultPlaylistId);
  const nowArchived = next.filter((p) => p.archived && !before.find((b) => b.playlistId === p.playlistId).archived);
  await store.patchSettings({ weeklyPlaylists: next });
  logger.info('Favourites playlist made', { name, tracks: uris.length, archived: nowArchived.map((p) => p.name) });
  return { skipped: false, ...entry, archivedNames: nowArchived.map((p) => p.name) };
}

function findWeekly(settings, id) {
  const p = (settings.weeklyPlaylists || []).find((x) => x.playlistId === id);
  if (!p) throw new UserError('not_found', "That isn't one of the weekly favourites playlists.", 404);
  return p;
}

// Archiving hides a playlist from the iPads; it stays in Spotify. A restored one stays on
// the iPads until it's archived again by hand.
async function setArchived(id, archive) {
  const settings = await store.getSettings({ fresh: true });
  findWeekly(settings, id);
  const patch = {
    weeklyPlaylists: settings.weeklyPlaylists.map((p) => (p.playlistId === id ? { ...p, archived: archive, kept: !archive } : p)),
  };
  if (archive && settings.defaultPlaylistId === id) patch.defaultPlaylistId = null;
  await store.patchSettings(patch);
}

// Every entry's URI (to write back unchanged) and the songs that can be shown.
async function readAll(id) {
  const uris = [];
  const tracks = [];
  for (let offset = 0; offset < FAVOURITES_MAX_TRACKS * 2; offset += PLAYLIST_PAGE_SIZE) {
    const data = await spotify.playlistItems(id, offset);
    for (const entry of (data && data.items) || []) {
      const raw = entry && (entry.item || entry.track);
      if (!raw || !raw.uri) continue;
      uris.push(raw.uri);
      const t = spotify.normalizeTrack(raw);
      if (t) tracks.push(t);
    }
    if (!(data && data.next)) break;
  }
  return { uris, tracks };
}

async function songs(id) {
  const settings = await store.getSettings({ fresh: true });
  const playlist = findWeekly(settings, id);
  try {
    return { playlist, tracks: (await readAll(id)).tracks };
  } catch (err) {
    throw toUserError(err);
  }
}

// Edits rewrite the whole list in one go, the same way the playlist was made.
async function edit(id, change) {
  findWeekly(await store.getSettings({ fresh: true }), id);
  let uris;
  try {
    uris = change((await readAll(id)).uris);
    await spotify.replacePlaylistItems(id, uris);
  } catch (err) {
    throw toUserError(err);
  }
  playlists.forget(id);
  const fresh = await store.getSettings({ fresh: true });
  await store.patchSettings({
    weeklyPlaylists: fresh.weeklyPlaylists.map((p) => (p.playlistId === id ? { ...p, trackCount: uris.length } : p)),
  });
  return { trackCount: uris.length };
}

function addSong(id, uri) {
  if (!TRACK_URI.test(String(uri || ''))) throw new UserError('not_track', 'Only songs can be added.');
  return edit(id, (uris) => {
    if (uris.includes(uri)) throw new UserError('already_added', "That song's already on this playlist.");
    if (uris.length >= FAVOURITES_MAX_TRACKS) throw new UserError('too_many', `A favourites playlist holds ${FAVOURITES_MAX_TRACKS} songs. Remove one first.`);
    return [...uris, uri];
  });
}

function removeSong(id, trackId) {
  return edit(id, (uris) => uris.filter((u) => u !== `spotify:track:${trackId}`));
}

module.exports = { rank, tracksSince, preview, build, setArchived, songs, addSong, removeSong };
