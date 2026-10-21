'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');
const { DEFAULT_SETTINGS } = require('../src/config');

const MIN = 60000;
const T0 = Date.UTC(2026, 9, 19, 0, 0); // 11:00am Melbourne, Monday

const item = (id) => ({
  id,
  uri: `spotify:track:${id}`,
  name: `Song ${id}`,
  artists: ['Artist'],
  album: 'Album',
  imageUrl: null,
  spotifyUrl: null,
  durationMs: 200000,
  explicit: false,
});
const entry = (id, trackId, deviceId = 'ipad1', queuedAt = T0) => ({
  id,
  trackId,
  uri: `spotify:track:${trackId}`,
  name: `Song ${trackId}`,
  artists: ['Artist'],
  deviceId,
  deviceName: deviceId === 'ipad1' ? 'Packing 1' : 'Dispatch',
  queuedAt,
});
const observe = (at, current, extra = {}) => ({
  at,
  onSpeaker: true,
  playing: true,
  item: current && item(current),
  progressMs: 0,
  contextUri: 'spotify:playlist:base',
  speaker: { status: 'online', name: 'Clock-in iPad', id: 'dev1' },
  ...extra,
});

test('reserve, confirm and release keep the quota honest', () => {
  const c = core.emptyCore();
  core.reserve(c, entry('r1', 'a'));
  assert.equal(c.pending[0].state, 'reserved');
  assert.deepEqual(c.deviceRecent.ipad1, [T0]);

  core.release(c, 'r1');
  assert.equal(c.pending.length, 0);
  assert.deepEqual(c.deviceRecent.ipad1, []);

  core.reserve(c, entry('r2', 'b'));
  core.confirm(c, 'r2');
  assert.equal(c.pending[0].state, 'queued');
  assert.equal(c.recentTracks.b, T0);
});

test('a requested song starting playback leaves the queue and is credited to its iPad', () => {
  const c = core.emptyCore();
  core.applyObservation(c, observe(T0, 'base1'));
  for (const [id, track, dev] of [['r1', 'a', 'ipad1'], ['r2', 'b', 'ipad2']]) {
    core.reserve(c, entry(id, track, dev));
    core.confirm(c, id);
  }
  const res = core.applyObservation(c, observe(T0 + 3 * MIN, 'a'));
  assert.equal(res.trackChanged, true);
  assert.equal(c.current.requestedBy, 'Packing 1');
  assert.deepEqual(c.pending.map((p) => p.id), ['r2']);
  assert.equal(c.recent[0].trackId, 'base1');

  // If 'a' was skipped and we never saw it, 'b' playing still clears both.
  core.reserve(c, entry('r3', 'c'));
  core.confirm(c, 'r3');
  core.applyObservation(c, observe(T0 + 4 * MIN, 'c'));
  assert.equal(c.pending.length, 0);
});

test('reserved (in-flight) requests are not consumed by playback', () => {
  const c = core.emptyCore();
  core.reserve(c, entry('r1', 'a'));
  core.applyObservation(c, observe(T0, 'a'));
  assert.equal(c.pending.length, 1);
  core.confirm(c, 'r1'); // confirm notices it's already playing
  assert.equal(c.pending.length, 0);
  assert.equal(c.current.requestedBy, 'Packing 1');
});

test('long pause then playing is flagged so lost songs can be re-added', () => {
  const c = core.emptyCore();
  core.applyObservation(c, observe(T0, 'a'));
  core.applyObservation(c, observe(T0 + MIN, 'a', { playing: false }));
  const short = core.applyObservation(c, observe(T0 + 2 * MIN, 'a'));
  assert.equal(short.resumedAfterLongPause, false);
  core.applyObservation(c, observe(T0 + 3 * MIN, 'a', { playing: false }));
  // Speaker gone entirely (iOS closed Spotify) during a 20 minute break.
  core.applyObservation(c, observe(T0 + 10 * MIN, null, { onSpeaker: false, playing: false }));
  const back = core.applyObservation(c, observe(T0 + 24 * MIN, 'a'));
  assert.equal(back.resumedAfterLongPause, true);
  assert.equal(back.trackChanged, false); // same song carries on, not a new play
  assert.equal(c.recent.length, 0);
});

test('older observations never overwrite newer ones', () => {
  const c = core.emptyCore();
  core.applyObservation(c, observe(T0 + MIN, 'b'));
  const res = core.applyObservation(c, observe(T0, 'a'));
  assert.equal(res.stale, true);
  assert.equal(c.current.id, 'b');
});

test('reconcile drops songs Spotify already played and re-adds a lost queue', () => {
  const c = core.emptyCore();
  for (const [id, track] of [['r1', 'a'], ['r2', 'b'], ['r3', 'c']]) {
    core.reserve(c, entry(id, track));
    core.confirm(c, id);
  }
  const later = T0 + 5 * MIN;
  const res = core.reconcileWithQueue(c, ['spotify:track:b', 'spotify:track:c', 'spotify:track:base9'], later);
  assert.deepEqual(res.dropped, ['r1']);
  assert.deepEqual(c.pending.map((p) => p.id), ['r2', 'r3']);

  // Spotify shows none of ours: without a long pause, leave them alone.
  assert.deepEqual(core.reconcileWithQueue(c, ['spotify:track:base9'], later), { reAdd: [], dropped: [] });
  // After a long pause, re-add them in order.
  const lost = core.reconcileWithQueue(c, [], later, { allowReAdd: true });
  assert.deepEqual(lost.reAdd.map((p) => p.id), ['r2', 'r3']);
});

test('likes are one per iPad per song per week', () => {
  const c = core.emptyCore();
  core.prune(c, T0);
  assert.equal(core.addLike(c, 'a', 'ipad1'), true);
  assert.equal(core.addLike(c, 'a', 'ipad1'), false);
  assert.equal(core.addLike(c, 'a', 'ipad2'), true);
  core.prune(c, T0 + 7 * 86400000);
  assert.deepEqual(c.weekLikes.by, {});
});

test('public state shows queued songs only and publishes only on visible change', () => {
  const c = core.emptyCore();
  const settings = { ...DEFAULT_SETTINGS, warehousePlaylists: [{ id: 'base', uri: 'spotify:playlist:base', name: 'Warehouse Mix' }] };
  core.applyObservation(c, observe(T0, 'a', { progressMs: 1000 }));
  core.reserve(c, entry('r1', 'b'));
  let pub = core.buildPublicState(c, settings, T0);
  assert.equal(pub.upNext.length, 0);
  assert.equal(pub.context.name, 'Warehouse Mix');
  assert.equal(pub.schedule.open, true);
  core.confirm(c, 'r1');
  pub = core.buildPublicState(c, settings, T0);
  assert.equal(pub.upNext[0].deviceName, 'Packing 1');

  const first = core.shouldPublish(c, pub, T0);
  assert.equal(first.publish, true);
  core.markPublished(c, pub, first.sig);

  // Ten seconds later, progress has moved on as expected: nothing to publish.
  core.applyObservation(c, observe(T0 + 10000, 'a', { progressMs: 11000 }));
  pub = core.buildPublicState(c, settings, T0 + 10000);
  assert.equal(core.shouldPublish(c, pub, T0 + 10000).publish, false);

  // Someone seeked 30 seconds ahead: publish.
  core.applyObservation(c, observe(T0 + 20000, 'a', { progressMs: 51000 }));
  pub = core.buildPublicState(c, settings, T0 + 20000);
  assert.equal(core.shouldPublish(c, pub, T0 + 20000).publish, true);
});

test('outside music hours the iPads see nothing about what is or was playing', () => {
  const c = core.emptyCore();
  core.applyObservation(c, observe(T0, 'a'));
  core.applyObservation(c, observe(T0 + 3 * MIN, 'b'));
  core.reserve(c, entry('r1', 'c'));
  core.confirm(c, 'r1');
  const settings = { ...DEFAULT_SETTINGS };
  const during = core.buildPublicState(c, settings, T0 + 4 * MIN);
  assert.equal(during.music.on, true);
  assert.equal(during.nowPlaying.name, 'Song b');
  assert.equal(during.recent.length, 1);
  assert.equal(during.upNext.length, 1);

  const evening = Date.UTC(2026, 9, 19, 7, 0); // 6pm Melbourne
  const after = core.buildPublicState(c, settings, evening);
  assert.equal(after.music.on, false);
  assert.equal(after.nowPlaying, null);
  assert.deepEqual(after.recent, []);
  assert.deepEqual(after.upNext, []);
  assert.equal(after.speaker.status, 'unknown');
});

test('up next fills with the playlist songs Spotify says come next, up to five in all', () => {
  const c = core.emptyCore();
  const settings = { ...DEFAULT_SETTINGS };
  core.applyObservation(c, observe(T0, 'a', { progressMs: 1000 }));
  core.reserve(c, entry('r1', 'b'));
  core.confirm(c, 'r1');
  const t = (id) => ({ id, uri: `spotify:track:${id}`, name: id, artists: [], imageUrl: null, durationMs: 1 });
  // Spotify's list starts with the requested song, can repeat the current one, and repeats songs.
  core.setUpcoming(c, ['b', 'a', 'p1', 'p2', 'p1', 'p3', 'p4', 'p5', 'p6'].map(t), T0);
  const pub = core.buildPublicState(c, settings, T0);
  assert.deepEqual(pub.upNext.map((p) => p.trackId), ['b']);
  assert.deepEqual(pub.thenFromPlaylist.map((p) => p.trackId), ['p1', 'p2', 'p3', 'p4']);
});

test('recently played starts empty each day', () => {
  const c = core.emptyCore();
  core.applyObservation(c, observe(T0, 'a'));
  core.applyObservation(c, observe(T0 + 3 * MIN, 'b'));
  core.prune(c, T0 + 4 * MIN);
  assert.equal(c.recent.length, 1);
  core.prune(c, T0 + 86400000); // same time tomorrow
  assert.equal(c.recent.length, 0);
});
