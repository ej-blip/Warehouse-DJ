'use strict';

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { DEFAULT_SETTINGS } = require('./config');
const core = require('./core');
const weekly = require('./weekly');

if (!getApps().length) initializeApp();
const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

// public/state is the only document the iPads can read (see firestore.rules).
// Everything else is backend only.
const refs = {
  settings: db.doc('private/settings'),
  state: db.doc('public/state'),
  core: db.doc('private/core'),
  spotify: db.doc('private/spotify'),
};

const SETTINGS_CACHE_MS = 10000;
let settingsCache = null;

async function getSettings({ fresh = false } = {}) {
  if (!fresh && settingsCache && Date.now() - settingsCache.at < SETTINGS_CACHE_MS) return settingsCache.value;
  const snap = await refs.settings.get();
  const value = weekly.migrate({ ...DEFAULT_SETTINGS, ...(snap.exists ? snap.data() : {}) });
  settingsCache = { value, at: Date.now() };
  return value;
}

async function saveSettings(next) {
  await refs.settings.set(next);
  settingsCache = { value: next, at: Date.now() };
  // Hours or breaks may have changed what the iPads should show.
  await mutateCore(() => {});
}

async function patchSettings(patch) {
  const current = await getSettings({ fresh: true });
  await saveSettings({ ...current, ...patch });
}

async function readCore() {
  const snap = await refs.core.get();
  return core.normaliseCore(snap.exists ? snap.data() : null);
}

// Every change to the shared queue state goes through here: one transaction reads
// private/core, lets `mutator` change it, and writes it back along with a fresh
// public/state when anything the iPads show has changed. The mutator may run more than
// once if two requests collide, so it must not call Spotify.
async function mutateCore(mutator, { publish = true } = {}) {
  const settings = await getSettings();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(refs.core);
    const c = core.normaliseCore(snap.exists ? snap.data() : null);
    const now = Date.now();
    core.prune(c, now);
    const result = await mutator(c, { tx, settings, now });
    if (publish) {
      const pub = core.buildPublicState(c, settings, now);
      const { sig, publish: changed } = core.shouldPublish(c, pub, now);
      if (changed) {
        tx.set(refs.state, pub);
        core.markPublished(c, pub, sig);
      }
    }
    tx.set(refs.core, c);
    return result;
  });
}

// Weekly tallies the favourites playlist is built from.
function weekTrackRef(weekKey, trackId) {
  return db.doc(`weeks/${weekKey}/tracks/${trackId}`);
}

function weekStatUpdate(track, { now, deviceId, queued = 0, likes = 0 }) {
  return {
    trackId: track.id,
    uri: track.uri,
    name: track.name,
    artists: track.artists,
    imageUrl: track.imageUrl || null,
    lastAt: now,
    devices: FieldValue.arrayUnion(deviceId),
    ...(queued ? { queued: FieldValue.increment(queued) } : {}),
    ...(likes ? { likes: FieldValue.increment(likes) } : {}),
  };
}

module.exports = {
  db,
  refs,
  FieldValue,
  getSettings,
  saveSettings,
  patchSettings,
  readCore,
  mutateCore,
  weekTrackRef,
  weekStatUpdate,
};
