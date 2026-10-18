'use strict';

// Everything that identifies this deployment lives here. Nothing in this file is secret:
// the Spotify client secret and the admin setup code are Firebase secrets (see secrets.js).

// Cloud Scheduler isn't offered in Melbourne, so the functions run in Sydney.
// Firestore itself lives in Melbourne (australia-southeast2); the hop is a few milliseconds.
const REGION = 'australia-southeast1';
const TIMEZONE = 'Australia/Melbourne';

const SITE_URL = process.env.SITE_URL || 'https://warehouse-dj-bd640.web.app';

const SPOTIFY_CLIENT_ID = 'ad0927173daa4589acebda57677db9f1';
const SPOTIFY_REDIRECT_URI = `${SITE_URL}/api/auth/callback`;
const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-modify-private',
];
const SPOTIFY_MARKET = 'AU';
// Overridable so the integration test can point at a fake Spotify.
const SPOTIFY_API_BASE = process.env.SPOTIFY_API_BASE || 'https://api.spotify.com/v1';
const SPOTIFY_ACCOUNTS_BASE = process.env.SPOTIFY_ACCOUNTS_BASE || 'https://accounts.spotify.com';
// Since mid-2026 Spotify refresh tokens die 6 months after the original login,
// no matter how often they're used.
const SPOTIFY_LOGIN_LIFETIME_DAYS = 182;
// Development Mode caps search at 10 results per request.
const SEARCH_PAGE_SIZE = 10;

const FAVOURITES_PLAYLIST_NAME = 'Warehouse Favourites';
const FAVOURITES_MAX_TRACKS = 100;

const DEFAULT_SETTINGS = Object.freeze({
  days: [1, 2, 3, 4, 5], // ISO weekdays, 1 = Monday
  open: '09:20',
  close: '16:00',
  breaks: [
    { start: '10:20', minutes: 20 },
    { start: '13:20', minutes: 40 },
  ],
  autoPause: true,
  autoResume: true,
  songsPerWindow: 3,
  windowMinutes: 30,
  queueCap: 20,
  maxTrackMinutes: 7,
  noRepeatHours: 2,
  allowExplicit: true,
  speakerDeviceName: '',
  basePlaylist: null, // { uri, name }
  favourites: null, // { playlistId, uri, url, ownerId, weekKey, builtAt, trackCount }
});

module.exports = {
  REGION,
  TIMEZONE,
  SITE_URL,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_REDIRECT_URI,
  SPOTIFY_SCOPES,
  SPOTIFY_MARKET,
  SPOTIFY_API_BASE,
  SPOTIFY_ACCOUNTS_BASE,
  SPOTIFY_LOGIN_LIFETIME_DAYS,
  SEARCH_PAGE_SIZE,
  FAVOURITES_PLAYLIST_NAME,
  FAVOURITES_MAX_TRACKS,
  DEFAULT_SETTINGS,
};
