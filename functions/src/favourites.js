'use strict';

// Rebuilds the "Warehouse Favourites" playlist from one week's queued and liked songs.
// Each week stands alone: last week's songs only come back if someone queues or likes
// them again.

const { logger } = require('firebase-functions');
const spotify = require('./spotify');
const store = require('./store');
const playlists = require('./playlists');
const { weekKeyAt } = require('./time');
const { FAVOURITES_PLAYLIST_NAME, FAVOURITES_MAX_TRACKS } = require('./config');
const { SpotifyError, UserError, toUserError } = require('./errors');

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

async function weekTracks(weekKey) {
  const snap = await store.db.collection(`weeks/${weekKey}/tracks`).get();
  return rank(snap.docs.map((d) => d.data()).filter((t) => t.uri));
}

async function preview(weekKey = weekKeyAt(Date.now())) {
  const tracks = await weekTracks(weekKey);
  return {
    weekKey,
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

async function createPlaylist(ownerId) {
  const p = await spotify.createPlaylist(
    FAVOURITES_PLAYLIST_NAME,
    'Rebuilt every Sunday night from the songs queued and liked on the warehouse iPads.',
  );
  return {
    playlistId: p.id,
    uri: p.uri,
    url: (p.external_urls && p.external_urls.spotify) || `https://open.spotify.com/playlist/${p.id}`,
    ownerId,
  };
}

async function build({ weekKey = weekKeyAt(Date.now()) } = {}) {
  const tracks = await weekTracks(weekKey);
  if (!tracks.length) {
    logger.info('No songs queued or liked this week; favourites left as they were', { weekKey });
    return { skipped: true, weekKey, message: 'No songs were queued or liked this week, so the playlist was left as it was.' };
  }
  const uris = tracks.slice(0, FAVOURITES_MAX_TRACKS).map((t) => t.uri);
  const login = await spotify.loginStatus();
  if (!login.connected) throw new UserError('spotify_disconnected', 'Connect Spotify first.', 503);

  const settings = await store.getSettings({ fresh: true });
  let fav = settings.favourites && settings.favourites.ownerId === login.userId ? settings.favourites : null;
  try {
    if (!fav) fav = await createPlaylist(login.userId);
    try {
      await spotify.replacePlaylistItems(fav.playlistId, uris);
    } catch (err) {
      // Someone deleted the playlist in Spotify: make a new one.
      if (!(err instanceof SpotifyError) || (err.status !== 404 && err.status !== 403)) throw err;
      fav = await createPlaylist(login.userId);
      await spotify.replacePlaylistItems(fav.playlistId, uris);
    }
  } catch (err) {
    throw toUserError(err);
  }

  playlists.forget(fav.playlistId);
  const favourites = { ...fav, weekKey, builtAt: Date.now(), trackCount: uris.length };
  await store.patchSettings({ favourites });
  logger.info('Favourites rebuilt', { weekKey, tracks: uris.length });
  return { skipped: false, ...favourites };
}

module.exports = { rank, preview, build };
