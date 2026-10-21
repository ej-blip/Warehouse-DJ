'use strict';

// Everything that both talks to Spotify and changes the shared queue state:
// syncing what's playing, queueing, play/pause/skip, likes, and break pauses.

const crypto = require('node:crypto');
const { logger } = require('firebase-functions');
const spotify = require('./spotify');
const store = require('./store');
const core = require('./core');
const rules = require('./rules');
const { localParts, parseClock, weekKeyAt } = require('./time');
const { UserError, SpotifyError, SpotifyAuthError, speakerOffline, toUserError } = require('./errors');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const SKIP_COOLDOWN_MS = 8000;

function deviceStatus(d) {
  if (d.is_restricted) return 'restricted';
  if (d.is_private_session) return 'private';
  return 'online';
}

// The speaker is matched by name: iPad device IDs can change when Spotify reinstalls.
async function findSpeaker(settings) {
  const devices = await spotify.devices();
  if (settings.speakerDeviceName) return devices.find((d) => sameName(d.name, settings.speakerDeviceName)) || null;
  return devices.find((d) => d.is_active) || null; // no speaker chosen yet: use whatever's active
}

function isOnSpeaker(pb, settings) {
  return Boolean(pb && pb.device && (!settings.speakerDeviceName || sameName(pb.device.name, settings.speakerDeviceName)));
}

async function observe(settings) {
  const pb = await spotify.playback();
  const at = Date.now();
  const onSpeaker = isOnSpeaker(pb, settings);
  let speaker;
  if (onSpeaker) {
    speaker = { status: deviceStatus(pb.device), name: pb.device.name, id: pb.device.id };
  } else {
    const d = await findSpeaker(settings);
    speaker = d
      ? { status: deviceStatus(d), name: d.name, id: d.id }
      : { status: 'offline', name: settings.speakerDeviceName || '', id: null };
  }
  return {
    at,
    onSpeaker,
    playing: Boolean(onSpeaker && pb.is_playing),
    // Only the speaker's playback is shown, so the host's own listening elsewhere stays private.
    item: onSpeaker ? spotify.normalizeTrack(pb.item) : null,
    progressMs: (pb && pb.progress_ms) || 0,
    contextUri: pb && pb.context ? pb.context.uri : null,
    repeat: pb ? pb.repeat_state : 'off',
    shuffle: pb ? Boolean(pb.shuffle_state) : false,
    speaker,
  };
}

async function markDisconnected(err) {
  await store.mutateCore((c) => {
    c.spotify = { connected: false, needsReauth: Boolean(err.needsReauth) };
  });
}

function musicOn(settings) {
  return rules.musicStatus(Date.now(), settings).on;
}

// Outside music hours: forget what was playing and publish the "music's off" state,
// without asking Spotify anything.
async function goOffHours(settings) {
  const now = Date.now();
  const c = await store.readCore();
  const pub = core.buildPublicState(c, settings, now);
  if (!c.current && !c.playback && !core.shouldPublish(c, pub, now).publish) return;
  await store.mutateCore((c2) => {
    c2.current = null;
    c2.playback = null;
  });
}

// Read Spotify's playback state into private/core and public/state.
async function sync({ deep = false } = {}) {
  const settings = await store.getSettings();
  if (!musicOn(settings)) {
    await goOffHours(settings);
    return { obs: null, offHours: true, trackChanged: false, resumedAfterLongPause: false };
  }
  let obs;
  try {
    obs = await observe(settings);
  } catch (err) {
    if (err instanceof SpotifyAuthError) await markDisconnected(err);
    throw err;
  }
  const res = await store.mutateCore((c) => {
    c.spotify = { connected: true, needsReauth: false };
    return core.applyObservation(c, obs);
  });
  if (deep || res.resumedAfterLongPause) {
    try {
      await reconcile({ allowReAdd: res.resumedAfterLongPause, speakerId: obs.speaker.id });
    } catch (err) {
      logger.warn('Queue reconcile failed', { err: err.message });
    }
  }
  return { obs, ...res };
}

async function reconcile({ allowReAdd, speakerId }) {
  const q = await spotify.queue();
  if (!q || !q.currently_playing) return { reAdd: [], dropped: [] };
  const uris = (q.queue || []).map((t) => t && t.uri).filter(Boolean);
  const plan = await store.mutateCore((c, { now }) => core.reconcileWithQueue(c, uris, now, { allowReAdd }));
  for (const p of plan.reAdd) {
    try {
      await spotify.addToQueue(p.uri, speakerId || undefined);
    } catch (err) {
      logger.warn('Could not re-add a lost song', { uri: p.uri, err: err.message });
      break;
    }
  }
  if (plan.reAdd.length || plan.dropped.length) {
    logger.info('Queue reconciled', { reAdded: plan.reAdd.length, dropped: plan.dropped.length });
  }
  return plan;
}

// Spotify answers 403 when asked to pause something already paused, and so on.
async function ignoreAlready(fn) {
  try {
    return await fn();
  } catch (err) {
    const harmless = ['ALREADY_PAUSED', 'NOT_PAUSED', 'ALREADY_PLAYING', 'UNKNOWN', null];
    if (err instanceof SpotifyError && err.status === 403 && harmless.includes(err.reason)) return null;
    throw err;
  }
}

async function startOrResume(settings, speaker) {
  const pb = await spotify.playback();
  if (pb && pb.item) {
    if (pb.is_playing && isOnSpeaker(pb, settings)) return;
    await ignoreAlready(() => spotify.play(speaker.id));
    return;
  }
  if (settings.basePlaylist && settings.basePlaylist.uri) {
    await spotify.play(speaker.id, { context_uri: settings.basePlaylist.uri });
    return;
  }
  await spotify.transfer(speaker.id, true);
}

async function control(action, { admin = false } = {}) {
  const settings = await store.getSettings();
  if (!admin && !musicOn(settings)) {
    throw new UserError('music_off', rules.musicStatus(Date.now(), settings).message, 409);
  }
  try {
    if (action === 'skip') {
      const allowed = await store.mutateCore((c, { now }) => {
        if (now - c.lastSkipAt < SKIP_COOLDOWN_MS) return false;
        c.lastSkipAt = now;
        return true;
      }, { publish: false });
      if (!allowed) throw new UserError('skip_cooldown', 'Just skipped. Give it a few seconds.', 429);
    }
    const speaker = await findSpeaker(settings);
    if (!speaker) throw speakerOffline();
    if (action === 'pause') await ignoreAlready(() => spotify.pause(speaker.id));
    else if (action === 'play') await startOrResume(settings, speaker);
    else if (action === 'skip') await spotify.next(speaker.id);
    else throw new UserError('bad_action', 'Unknown action.');
  } catch (err) {
    throw toUserError(err);
  }
  // Spotify takes a moment to report the new state.
  await sleep(800);
  return sync().catch((err) => logger.warn('Sync after control failed', { err: err.message }));
}

async function playPlaylist(playlist) {
  const settings = await store.getSettings();
  const speaker = await findSpeaker(settings);
  if (!speaker) throw speakerOffline();
  try {
    await spotify.play(speaker.id, { context_uri: playlist.uri });
  } catch (err) {
    if (err instanceof SpotifyError && (err.status === 403 || err.status === 400)) {
      throw new UserError('playlist_refused', "Spotify won't let the app start that playlist. Start it in the Spotify app on the speaker iPad instead.", 409);
    }
    throw toUserError(err);
  }
  await store.patchSettings({ basePlaylist: { uri: playlist.uri, name: playlist.name } });
  await sleep(800);
  return sync().catch(() => null);
}

async function setLoop(on) {
  const settings = await store.getSettings();
  const speaker = await findSpeaker(settings);
  if (!speaker) throw speakerOffline();
  await spotify.setRepeat(on ? 'context' : 'off', speaker.id).catch((err) => {
    throw toUserError(err);
  });
  await sleep(500);
  return sync().catch(() => null);
}

async function setShuffle(on) {
  const settings = await store.getSettings();
  const speaker = await findSpeaker(settings);
  if (!speaker) throw speakerOffline();
  await spotify.setShuffle(on, speaker.id).catch((err) => {
    throw toUserError(err);
  });
  await sleep(500);
  return sync().catch(() => null);
}

// ---- queueing ---------------------------------------------------------------

const TRACK_URI = /^spotify:track:([A-Za-z0-9]{22})$/;
const trackCache = new Map(); // filled by searches so queueing rarely needs another call

function rememberTracks(tracks) {
  const now = Date.now();
  for (const t of tracks) if (t) trackCache.set(t.id, { track: t, at: now });
  while (trackCache.size > 500) trackCache.delete(trackCache.keys().next().value);
}

async function trackMeta(id) {
  const hit = trackCache.get(id);
  if (hit && Date.now() - hit.at < 3600000) return hit.track;
  const track = spotify.normalizeTrack(await spotify.track(id));
  if (!track) throw new UserError('not_found', "Couldn't find that song on Spotify.", 404);
  rememberTracks([track]);
  return track;
}

async function addToSpotifyQueue(uri, settings) {
  try {
    await spotify.addToQueue(uri);
  } catch (err) {
    if (!(err instanceof SpotifyError) || (err.status !== 404 && err.reason !== 'NO_ACTIVE_DEVICE')) throw err;
    // Nothing active: wake the speaker without starting music, then try again.
    const speaker = await findSpeaker(settings);
    if (!speaker) throw err;
    await spotify.transfer(speaker.id, false);
    await sleep(600);
    await spotify.addToQueue(uri, speaker.id);
  }
}

async function queueTrack(device, uri) {
  const m = TRACK_URI.exec(String(uri || ''));
  if (!m) throw new UserError('not_track', 'Only songs can be queued.');
  let track;
  try {
    track = await trackMeta(m[1]);
  } catch (err) {
    throw toUserError(err);
  }
  if (!track.playable) throw new UserError('unplayable', "That song isn't available in Australia.");

  const entry = {
    id: crypto.randomUUID(),
    trackId: track.id,
    uri: track.uri,
    name: track.name,
    artists: track.artists,
    album: track.album,
    imageUrl: track.imageUrl,
    spotifyUrl: track.spotifyUrl,
    durationMs: track.durationMs,
    explicit: track.explicit,
    deviceId: device.id,
    deviceName: device.name,
    queuedAt: 0,
  };

  // 1. Check the rules and hold a place, atomically, so a double tap can't sneak past.
  const verdict = await store.mutateCore((c, { settings, now }) => {
    const check = rules.checkQueueRequest({ nowMs: now, settings, device, track, core: c });
    if (!check.ok) return check;
    entry.queuedAt = now;
    core.reserve(c, entry);
    return { ok: true };
  }, { publish: false });
  if (!verdict.ok) throw new UserError(verdict.code, verdict.message, 409, { retryAt: verdict.retryAt || null });

  // 2. Ask Spotify. If it refuses, the iPad gets its slot back.
  const settings = await store.getSettings();
  try {
    await addToSpotifyQueue(entry.uri, settings);
  } catch (err) {
    await store.mutateCore((c) => core.release(c, entry.id), { publish: false });
    throw toUserError(err);
  }

  // 3. Confirm and publish.
  const result = await store.mutateCore((c, { settings: s, now }) => {
    core.confirm(c, entry.id);
    const position = c.pending.filter((p) => p.state === 'queued').findIndex((p) => p.id === entry.id) + 1;
    return { position, quota: rules.deviceQuota(now, s, c, device.id) };
  });
  await store
    .weekTrackRef(weekKeyAt(entry.queuedAt), track.id)
    .set(store.weekStatUpdate(track, { now: entry.queuedAt, deviceId: device.id, queued: 1 }), { merge: true })
    .catch((err) => logger.warn('Could not record weekly stat', { err: err.message }));

  return { track, ...result };
}

async function like(device) {
  return store.mutateCore((c, { tx, now }) => {
    if (!c.current) throw new UserError('nothing_playing', "Nothing's playing to like.");
    const t = c.current;
    if (!core.addLike(c, t.id, device.id)) return { already: true, likes: c.weekLikes.by[t.id].length };
    tx.set(store.weekTrackRef(weekKeyAt(now), t.id), store.weekStatUpdate(t, { now, deviceId: device.id, likes: 1 }), { merge: true });
    return { already: false, likes: c.weekLikes.by[t.id].length };
  });
}

// ---- breaks -----------------------------------------------------------------

// Pause whatever the account is playing, wherever it is. Returns that device, or null
// if nothing was playing.
async function pauseActive() {
  const pb = await spotify.playback();
  if (!(pb && pb.is_playing && pb.device)) return null;
  await ignoreAlready(() => spotify.pause(pb.device.id));
  return { id: pb.device.id, name: pb.device.name };
}

// Start music again on the device that was paused (or the speaker, if that one's gone).
async function resumeOn(settings, device) {
  const devices = await spotify.devices();
  const target =
    devices.find((d) => device && d.id === device.id) ||
    devices.find((d) => device && sameName(d.name, device.name)) ||
    (await findSpeaker(settings));
  if (!target) return false;
  const pb = await spotify.playback();
  if (!(pb && pb.is_playing)) await ignoreAlready(() => spotify.play(target.id));
  return true;
}

// Pause when a break starts; resume when it ends, but only music we paused ourselves,
// so a deliberate stop before the break stays stopped.
async function handleBreaks(settings, nowMs) {
  const lp = localParts(nowMs);
  if (!settings.days.includes(lp.weekday)) return null;
  const state = (await store.readCore()).breakState;

  for (const b of settings.breaks) {
    const start = parseClock(b.start);
    const end = start + b.minutes;
    const key = `${lp.dateKey} ${b.start}`;
    const sinceStart = lp.minutesOfDay - start;
    const sinceEnd = lp.minutesOfDay - end;

    if (settings.autoPause && sinceStart >= 0 && sinceStart < 3 && sinceEnd < 0 && state.key !== key) {
      const paused = await pauseActive();
      await store.mutateCore((c) => {
        c.breakState = { key, paused: Boolean(paused), resumed: false, device: paused };
      }, { publish: false });
      logger.info('Break started', { key, paused: paused ? paused.name : null });
      return paused ? 'paused' : 'nothing_playing';
    }

    if (settings.autoResume && sinceEnd >= 0 && sinceEnd < 5 && state.key === key && state.paused && !state.resumed) {
      if (!(await resumeOn(settings, state.device))) {
        logger.info('Break over but the speaker is offline; will retry', { key });
        return 'speaker_offline';
      }
      await store.mutateCore((c) => {
        c.breakState = { ...c.breakState, resumed: true };
      }, { publish: false });
      logger.info('Break over, music resumed', { key });
      return 'resumed';
    }
  }
  return null;
}

// The admin page's "Test break" button: the same pause and resume a real break uses,
// with a short break in between.
async function testBreak(seconds) {
  const settings = await store.getSettings();
  let paused;
  try {
    paused = await pauseActive();
  } catch (err) {
    throw toUserError(err);
  }
  if (!paused) return { paused: false, resumed: false, message: 'Nothing was playing, so there was nothing to pause.' };
  await sync().catch(() => null);
  await sleep(seconds * 1000);
  let resumed;
  try {
    resumed = await resumeOn(settings, paused);
  } catch (err) {
    throw toUserError(err);
  }
  await sleep(800);
  await sync().catch(() => null);
  return {
    paused: true,
    resumed,
    message: resumed
      ? `Paused ${paused.name} for ${seconds} seconds, then started it again.`
      : `Paused ${paused.name}, but couldn't start it again because it isn't reachable.`,
  };
}

// Between the once-a-minute runs, check again every 15 seconds and just after each song
// ends, so changes made on the speaker itself reach the iPads quickly.
const POLL_MS = 15000;
const TICK_BUDGET_MS = 50000;

// Runs every minute. Outside music hours it only keeps the iPads' banners current.
async function tick({ pollMs = POLL_MS, budgetMs = TICK_BUDGET_MS } = {}) {
  const started = Date.now();
  const settings = await store.getSettings();
  if (!musicOn(settings)) {
    await goOffHours(settings);
    return;
  }
  const login = await spotify.loginStatus();
  if (!login.connected) {
    // Still publish, so the iPads' schedule banner stays current.
    await store.mutateCore((c) => {
      c.spotify = { connected: false, needsReauth: login.needsReauth };
    });
    return;
  }
  try {
    await handleBreaks(settings, Date.now());
  } catch (err) {
    logger.warn('Break handling failed', { err: err.message });
  }

  const deep = localParts(Date.now()).minute % 10 === 0;
  let res = await sync({ deep });
  let nextPoll = started + pollMs;
  for (;;) {
    while (nextPoll <= Date.now()) nextPoll += pollMs;
    let at = nextPoll;
    const o = res.obs;
    if (o && o.playing && o.item) {
      const endsAt = o.at + o.item.durationMs - o.progressMs + 1500;
      if (endsAt > Date.now() && endsAt < at) at = endsAt;
    }
    if (at - started > budgetMs) return;
    await sleep(at - Date.now());
    res = await sync();
    if (res.offHours) return;
  }
}

module.exports = {
  findSpeaker,
  sync,
  control,
  playPlaylist,
  setLoop,
  setShuffle,
  rememberTracks,
  queueTrack,
  like,
  handleBreaks,
  testBreak,
  tick,
};
