'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const weekly = require('../src/weekly');

// Melbourne is UTC+11 in October.
const mel = (month, day, hour, minute = 0) => Date.UTC(2026, month - 1, day, hour - 11, minute);

test('date labels abbreviate the month and span months when needed', () => {
  const d = (month, day) => ({ year: 2026, month, day });
  assert.equal(weekly.rangeLabel(d(10, 21), d(10, 21)), '21 Oct');
  assert.equal(weekly.rangeLabel(d(10, 19), d(10, 25)), '19–25 Oct');
  assert.equal(weekly.rangeLabel(d(10, 26), d(11, 1)), '26 Oct – 1 Nov');
});

test('a playlist covers the days after the previous one, which counts its own day if made after the music stopped', () => {
  // Previous made Sunday 8pm, this one the next Sunday 8pm.
  assert.equal(weekly.labelFor(mel(10, 25, 20), mel(11, 1, 20), '16:00'), '26 Oct – 1 Nov');
  // Previous made Monday lunchtime: that Monday's afternoon counts.
  assert.equal(weekly.labelFor(mel(10, 19, 12), mel(10, 21, 21), '16:00'), '19–21 Oct');
  assert.equal(weekly.nameFor(2, '19–21 Oct'), 'Warehouse Favourites #2 · 19–21 Oct');
});

test('the old single favourites playlist becomes #1, and a chosen saved playlist stays the starting one', () => {
  const saved = { id: 'mix', uri: 'spotify:playlist:mix', name: 'Mix' };
  const out = weekly.migrate({
    favourites: { playlistId: 'fav', uri: 'spotify:playlist:fav', ownerId: 'me', builtAt: mel(10, 21, 10), trackCount: 11 },
    weeklyPlaylists: [],
    warehousePlaylists: [saved],
    basePlaylist: { uri: saved.uri, name: 'Mix' },
    defaultPlaylistId: null,
  });
  assert.equal(out.favourites, null);
  assert.equal(out.basePlaylist, null);
  assert.equal(out.defaultPlaylistId, 'mix');
  assert.equal(out.weeklyPlaylists.length, 1);
  const [one] = out.weeklyPlaylists;
  assert.equal(one.name, 'Warehouse Favourites #1 · 19–21 Oct'); // the week it was built in, up to that day
  assert.equal(one.renamed, false);
  assert.equal(one.trackCount, 11);
  // Already migrated settings pass through unchanged.
  assert.deepEqual(weekly.migrate(out), out);
});

const pl = (number, extra = {}) => ({ playlistId: `p${number}`, uri: `spotify:playlist:p${number}`, name: `#${number}`, number, archived: false, kept: false, trackCount: 10, ...extra });

test('only the newest four weekly playlists stay on the iPads', () => {
  const list = [1, 2, 3, 4, 5, 6].map((n) => pl(n));
  const out = weekly.autoArchive(list, null);
  assert.deepEqual(weekly.visible(out).map((p) => p.number), [6, 5, 4, 3]);
  assert.deepEqual(weekly.archived(out).map((p) => p.number), [2, 1]);
  // The starting playlist and restored ones aren't archived automatically.
  const kept = weekly.autoArchive([pl(1), pl(2, { kept: true }), pl(3), pl(4), pl(5), pl(6)], 'p1');
  assert.deepEqual(weekly.visible(kept).map((p) => p.number), [6, 5, 4, 3, 2, 1]);
});

test('music starts from the switched-on playlist, otherwise the newest weekly one', () => {
  const settings = { weeklyPlaylists: [pl(1), pl(2), pl(3, { archived: true })], warehousePlaylists: [{ id: 'mix', uri: 'spotify:playlist:mix', name: 'Mix' }], defaultPlaylistId: null };
  assert.equal(weekly.startingPlaylist(settings).id, 'p2');
  assert.equal(weekly.startingPlaylist(settings).chosen, false);
  assert.equal(weekly.startingPlaylist({ ...settings, defaultPlaylistId: 'p1' }).id, 'p1');
  assert.equal(weekly.startingPlaylist({ ...settings, defaultPlaylistId: 'mix' }).name, 'Mix');
  // An archived or missing choice falls back to the newest.
  assert.equal(weekly.startingPlaylist({ ...settings, defaultPlaylistId: 'p3' }).id, 'p2');
  assert.equal(weekly.startingPlaylist({ weeklyPlaylists: [], warehousePlaylists: [], defaultPlaylistId: null }), null);
  assert.equal(weekly.nameForUri({ ...settings, lastPlayed: { uri: 'spotify:playlist:x', name: 'X' } }, 'spotify:playlist:x'), 'X');
});
