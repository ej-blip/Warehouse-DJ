'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSearchQuery, rankResults } = require('../src/search');

test('each search mode builds the right Spotify query', () => {
  assert.equal(buildSearchQuery('song', '  Mr  Brightside '), 'Mr Brightside');
  assert.equal(buildSearchQuery('artist', 'The Killers'), 'artist:"The Killers"');
  assert.equal(buildSearchQuery('genre', 'jazz hip hop'), 'genre:"jazz hip hop"');
  // Typed quotes can't break out of the filter.
  assert.equal(buildSearchQuery('genre', 'jazz" year:1990 "x'), 'genre:"jazz year:1990 x"');
  assert.equal(buildSearchQuery('song', '""'), '');
});

test('genre results are most popular first; other modes keep Spotify order', () => {
  const tracks = [{ id: 'a', popularity: 20 }, { id: 'b', popularity: 90 }, { id: 'c', popularity: 55 }];
  assert.deepEqual(rankResults('genre', tracks).map((t) => t.id), ['b', 'c', 'a']);
  assert.deepEqual(rankResults('song', tracks).map((t) => t.id), ['a', 'b', 'c']);
  // No popularity from Spotify: leave the order alone.
  const unknown = [{ id: 'a', popularity: null }, { id: 'b', popularity: 90 }];
  assert.deepEqual(rankResults('genre', unknown).map((t) => t.id), ['a', 'b']);
});
