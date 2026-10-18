'use strict';

// The shared queue state ("core") lives in one Firestore document, private/core, so every
// change to it can happen inside a single transaction. This module holds the pure
// transitions on that document and the projection the iPads see (public/state).

const { scheduleStatus } = require('./rules');
const { weekKeyAt } = require('./time');

const DAY = 86400000;
const MINUTE = 60000;
const RECENT_PLAYED_KEPT = 8;
const STALE_PENDING_MS = 4 * 3600000;
// Paused this long, then playing again, means we look for songs Spotify may have lost
// (for example if iOS closed the Spotify app during a break).
const LONG_PAUSE_MS = 3 * MINUTE;

function emptyCore() {
  return {
    pending: [], // requested songs not yet played, in queue order
    deviceRecent: {}, // deviceId -> [ms] when that iPad queued songs
    recentTracks: {}, // trackId -> ms it was last queued or started playing
    recent: [], // songs that finished, newest first
    current: null, // song on the speaker right now
    playback: null, // { isPlaying, progressMs, observedAt, contextUri, repeat, shuffle }
    speaker: { status: 'unknown', name: '', id: null, checkedAt: 0 },
    spotify: { connected: false, needsReauth: false },
    pausedSince: null,
    breakState: { key: null, paused: false, resumed: false },
    weekLikes: { weekKey: null, by: {} }, // trackId -> [deviceIds] for this week
    lastSkipAt: 0,
    observedAt: 0,
    publicSig: '',
    published: null,
  };
}

function normaliseCore(data) {
  return { ...emptyCore(), ...(data || {}) };
}

function prune(core, nowMs) {
  for (const [deviceId, times] of Object.entries(core.deviceRecent)) {
    const kept = times.filter((t) => nowMs - t < DAY);
    if (kept.length) core.deviceRecent[deviceId] = kept;
    else delete core.deviceRecent[deviceId];
  }
  for (const [trackId, t] of Object.entries(core.recentTracks)) {
    if (nowMs - t >= DAY) delete core.recentTracks[trackId];
  }
  core.pending = core.pending.filter((p) => nowMs - p.queuedAt < STALE_PENDING_MS);
  core.recent = core.recent.slice(0, RECENT_PLAYED_KEPT);
  const weekKey = weekKeyAt(nowMs);
  if (core.weekLikes.weekKey !== weekKey) core.weekLikes = { weekKey, by: {} };
}

// ---- queue requests --------------------------------------------------------

// A request holds its place (and the iPad's quota) while we ask Spotify.
function reserve(core, entry) {
  core.pending.push({ ...entry, state: 'reserved' });
  (core.deviceRecent[entry.deviceId] = core.deviceRecent[entry.deviceId] || []).push(entry.queuedAt);
}

function confirm(core, id) {
  const p = core.pending.find((x) => x.id === id);
  if (!p) return;
  core.recentTracks[p.trackId] = Math.max(core.recentTracks[p.trackId] || 0, p.queuedAt);
  if (core.current && core.current.uri === p.uri && core.current.startedAt >= p.queuedAt - 5000) {
    // Spotify started it before we got here; it's no longer "up next".
    core.pending = core.pending.filter((x) => x.id !== id);
    core.current.requestedBy = p.deviceName;
    return;
  }
  p.state = 'queued';
}

// Spotify refused: give the iPad its slot back.
function release(core, id) {
  const p = core.pending.find((x) => x.id === id);
  if (!p) return;
  core.pending = core.pending.filter((x) => x.id !== id);
  const times = core.deviceRecent[p.deviceId] || [];
  const i = times.indexOf(p.queuedAt);
  if (i >= 0) times.splice(i, 1);
}

// ---- playback observations -------------------------------------------------

// obs: { at, onSpeaker, playing, item, progressMs, contextUri, repeat, shuffle, speaker }
function applyObservation(core, obs) {
  if (obs.at < core.observedAt) return { stale: true, trackChanged: false, resumedAfterLongPause: false };
  core.observedAt = obs.at;
  core.speaker = { ...obs.speaker, checkedAt: obs.at };

  const result = { stale: false, trackChanged: false, resumedAfterLongPause: false };
  const item = obs.onSpeaker ? obs.item : null;
  const playing = Boolean(item && obs.playing);

  if (playing) {
    if (core.pausedSince && obs.at - core.pausedSince >= LONG_PAUSE_MS) result.resumedAfterLongPause = true;
    core.pausedSince = null;
  } else if (!core.pausedSince) {
    core.pausedSince = obs.at;
  }

  if (!item) {
    // Keep `current`: if the same song carries on after a break it keeps its
    // "requested by" and isn't listed as played twice.
    core.playback = null;
    return result;
  }

  if (!core.current || core.current.uri !== item.uri) {
    if (core.current) finishCurrent(core, obs.at);
    let requestedBy = null;
    const idx = core.pending.findIndex((p) => p.state === 'queued' && p.uri === item.uri);
    if (idx >= 0) {
      requestedBy = core.pending[idx].deviceName;
      // Spotify plays its queue in order, so anything queued ahead of this song has
      // already played.
      core.pending = core.pending.filter((p, i) => i > idx || p.state !== 'queued');
    }
    core.recentTracks[item.id] = obs.at;
    core.current = { ...item, requestedBy, startedAt: obs.at - (obs.progressMs || 0) };
    result.trackChanged = true;
  }

  core.playback = {
    isPlaying: playing,
    progressMs: obs.progressMs || 0,
    observedAt: obs.at,
    contextUri: obs.contextUri || null,
    repeat: obs.repeat || 'off',
    shuffle: Boolean(obs.shuffle),
  };
  return result;
}

function finishCurrent(core, at) {
  const c = core.current;
  core.recent.unshift({
    trackId: c.id,
    uri: c.uri,
    name: c.name,
    artists: c.artists,
    imageUrl: c.imageUrl,
    spotifyUrl: c.spotifyUrl,
    requestedBy: c.requestedBy || null,
    endedAt: at,
  });
  core.recent = core.recent.slice(0, RECENT_PLAYED_KEPT);
  core.current = null;
}

// Compare our list of requested songs with what Spotify says is queued.
// - Songs we think are pending that sit ahead of one Spotify still has: they've played.
// - None of ours in Spotify's queue after a long pause: Spotify lost the queue, so the
//   caller re-adds them (allowReAdd). Outside that case we leave things alone, because an
//   empty answer from Spotify isn't proof enough to throw requests away.
function reconcileWithQueue(core, queueUris, nowMs, { allowReAdd = false } = {}) {
  const settled = core.pending.filter((p) => p.state === 'queued' && nowMs - p.queuedAt > 15000);
  if (!settled.length) return { reAdd: [], dropped: [] };
  const inSpotify = new Set(queueUris);
  const firstPresent = settled.findIndex((p) => inSpotify.has(p.uri));

  if (firstPresent === -1) {
    return allowReAdd ? { reAdd: settled.map((p) => ({ ...p })), dropped: [] } : { reAdd: [], dropped: [] };
  }
  const dropped = settled.slice(0, firstPresent).filter((p) => !inSpotify.has(p.uri)).map((p) => p.id);
  if (dropped.length) core.pending = core.pending.filter((p) => !dropped.includes(p.id));
  return { reAdd: [], dropped };
}

// ---- likes -----------------------------------------------------------------

function addLike(core, trackId, deviceId) {
  const by = core.weekLikes.by;
  const list = by[trackId] || [];
  if (list.includes(deviceId)) return false;
  by[trackId] = [...list, deviceId];
  return true;
}

// ---- what the iPads see ----------------------------------------------------

function buildPublicState(core, settings, nowMs) {
  const c = core.current;
  const pb = core.playback;
  const likedBy = c ? core.weekLikes.by[c.id] || [] : [];
  const base = settings.basePlaylist;
  return {
    spotify: { connected: core.spotify.connected, needsReauth: core.spotify.needsReauth },
    speaker: { status: core.speaker.status, name: core.speaker.name || settings.speakerDeviceName || '' },
    nowPlaying: c && pb
      ? {
          trackId: c.id,
          uri: c.uri,
          name: c.name,
          artists: c.artists,
          album: c.album,
          imageUrl: c.imageUrl,
          spotifyUrl: c.spotifyUrl,
          explicit: c.explicit,
          durationMs: c.durationMs,
          requestedBy: c.requestedBy || null,
          likes: likedBy.length,
          likedBy,
          isPlaying: pb.isPlaying,
          progressMs: pb.progressMs,
          observedAt: pb.observedAt,
        }
      : null,
    context: pb
      ? {
          uri: pb.contextUri,
          name: base && base.uri === pb.contextUri ? base.name : null,
          repeat: pb.repeat,
          shuffle: pb.shuffle,
        }
      : null,
    upNext: core.pending
      .filter((p) => p.state === 'queued')
      .map((p) => ({
        id: p.id,
        trackId: p.trackId,
        uri: p.uri,
        name: p.name,
        artists: p.artists,
        imageUrl: p.imageUrl,
        spotifyUrl: p.spotifyUrl,
        durationMs: p.durationMs,
        deviceName: p.deviceName,
        queuedAt: p.queuedAt,
      })),
    recent: core.recent.slice(0, 5),
    schedule: scheduleStatus(nowMs, settings),
    updatedAt: nowMs,
  };
}

// Firestore listeners fire on every write, so only publish when something visible
// changed, or when our last published progress has drifted (someone seeked).
function shouldPublish(core, pub, nowMs) {
  const sig = JSON.stringify({ ...pub, updatedAt: 0, nowPlaying: pub.nowPlaying && { ...pub.nowPlaying, progressMs: 0, observedAt: 0 } });
  let drifted = false;
  if (pub.nowPlaying && core.published) {
    const was = core.published;
    const expected = was.progressMs + (was.isPlaying ? nowMs - was.observedAt : 0);
    const actual = pub.nowPlaying.progressMs + (pub.nowPlaying.isPlaying ? nowMs - pub.nowPlaying.observedAt : 0);
    drifted = Math.abs(expected - actual) > 4000;
  }
  return { sig, publish: sig !== core.publicSig || drifted };
}

function markPublished(core, pub, sig) {
  core.publicSig = sig;
  core.published = pub.nowPlaying
    ? { progressMs: pub.nowPlaying.progressMs, observedAt: pub.nowPlaying.observedAt, isPlaying: pub.nowPlaying.isPlaying }
    : null;
}

module.exports = {
  emptyCore,
  normaliseCore,
  prune,
  reserve,
  confirm,
  release,
  applyObservation,
  reconcileWithQueue,
  addLike,
  buildPublicState,
  shouldPublish,
  markPublished,
  LONG_PAUSE_MS,
};
