'use strict';

// Numbered weekly favourites playlists ("Warehouse Favourites #2 · 20–21 Oct"): naming,
// which ones the iPads see, and which playlist music starts from. No Spotify calls here.

const { localParts, parseClock } = require('./time');
const { FAVOURITES_PLAYLIST_NAME, WEEKLY_VISIBLE } = require('./config');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 86400000;

// Calendar-date arithmetic on { year, month, day }, free of time zones.
function addDays(d, n) {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}
const dayNumber = (d) => Date.UTC(d.year, d.month - 1, d.day) / DAY;

// "21 Oct", "19–25 Oct", "26 Oct – 1 Nov"
function rangeLabel(from, to) {
  if (dayNumber(from) >= dayNumber(to)) return `${to.day} ${MONTHS[to.month - 1]}`;
  if (from.month === to.month) return `${from.day}–${to.day} ${MONTHS[to.month - 1]}`;
  return `${from.day} ${MONTHS[from.month - 1]} – ${to.day} ${MONTHS[to.month - 1]}`;
}

// The days a playlist made at madeMs covers, starting after the previous one was made.
// A playlist made after the music stopped for the day covers that day, so the next one
// starts the day after.
function labelFor(sinceMs, madeMs, musicEnd) {
  const s = localParts(sinceMs);
  const end = parseClock(musicEnd) ?? 16 * 60;
  const from = s.minutesOfDay >= end ? addDays(s, 1) : s;
  return rangeLabel(from, localParts(madeMs));
}

const nameFor = (number, label) => `${FAVOURITES_PLAYLIST_NAME} #${number} · ${label}`;

// Before numbered playlists there was one "Warehouse Favourites", rebuilt every week, and
// Play on the admin page chose the starting playlist. Both carry over: the old playlist
// becomes #1 (covering the week it was built in) and a chosen saved playlist stays the
// one music starts from.
function migrate(settings) {
  let out = settings;
  const fav = out.favourites;
  if (fav && fav.playlistId && !(out.weeklyPlaylists || []).length) {
    const made = localParts(fav.builtAt || Date.now());
    const monday = addDays(made, 1 - made.weekday);
    const label = rangeLabel(monday, made);
    out = {
      ...out,
      weeklyPlaylists: [{
        playlistId: fav.playlistId,
        uri: fav.uri,
        url: fav.url,
        ownerId: fav.ownerId,
        number: 1,
        name: nameFor(1, label),
        label,
        madeAt: fav.builtAt || Date.now(),
        trackCount: fav.trackCount || 0,
        archived: false,
        kept: false,
        renamed: false, // its name in Spotify is still the old one
      }],
      favourites: null,
    };
  }
  const base = out.basePlaylist;
  if (base) {
    const saved = (out.warehousePlaylists || []).find((p) => p.uri === base.uri);
    out = { ...out, basePlaylist: null, defaultPlaylistId: out.defaultPlaylistId || (saved ? saved.id : null) };
  }
  return out;
}

const byNewest = (list) => [...(list || [])].sort((a, b) => b.number - a.number);
const visible = (list) => byNewest(list).filter((p) => !p.archived);
const archived = (list) => byNewest(list).filter((p) => p.archived);
const latest = (list) => byNewest(list)[0] || null;

// After a new playlist is made: the newest few stay on the iPads, older ones are archived
// (kept in Spotify). Restored playlists and the one music starts from stay put.
function autoArchive(list, defaultId) {
  const rotating = visible(list).filter((p) => !p.kept && p.playlistId !== defaultId);
  const old = new Set(rotating.slice(WEEKLY_VISIBLE).map((p) => p.playlistId));
  return list.map((p) => (old.has(p.playlistId) ? { ...p, archived: true } : p));
}

// The playlist music starts from: the one an admin switched on, otherwise the newest
// weekly favourites.
function startingPlaylist(settings) {
  const id = settings.defaultPlaylistId;
  const pick = (p) => ({ id: p.playlistId || p.id, uri: p.uri, name: p.name, trackCount: p.trackCount || null });
  if (id) {
    const weekly = visible(settings.weeklyPlaylists).find((p) => p.playlistId === id);
    if (weekly) return { ...pick(weekly), chosen: true };
    const saved = (settings.warehousePlaylists || []).find((p) => p.id === id);
    if (saved) return { ...pick(saved), chosen: true };
  }
  const newest = visible(settings.weeklyPlaylists)[0];
  return newest ? { ...pick(newest), chosen: false } : null;
}

// For "From …" on the iPads.
function nameForUri(settings, uri) {
  if (!uri) return null;
  const all = [...(settings.weeklyPlaylists || []), ...(settings.warehousePlaylists || []), settings.lastPlayed].filter(Boolean);
  const hit = all.find((p) => p.uri === uri);
  return hit ? hit.name : null;
}

module.exports = { rangeLabel, labelFor, nameFor, migrate, visible, archived, latest, autoArchive, startingPlaylist, nameForUri };
