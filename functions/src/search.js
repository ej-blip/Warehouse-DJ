'use strict';

// Search modes on the iPads: Song (default), Artist and Genre.

const MODES = ['song', 'artist', 'genre'];

// What was typed -> a Spotify search query. Quotes are stripped so nobody can break
// out of the artist/genre filters.
function buildSearchQuery(mode, text) {
  const cleaned = String(text || '').replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (mode === 'artist') return `artist:"${cleaned}"`;
  if (mode === 'genre') return `genre:"${cleaned}"`;
  return cleaned;
}

// Genre results come back most popular first, when Spotify still tells us popularity.
// Song and artist results keep Spotify's own order, which puts the closest match first.
function rankResults(mode, tracks) {
  if (mode !== 'genre' || !tracks.length || !tracks.every((t) => typeof t.popularity === 'number')) return tracks;
  return [...tracks].sort((a, b) => b.popularity - a.popularity);
}

module.exports = { MODES, buildSearchQuery, rankResults };
