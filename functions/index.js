'use strict';

const { setGlobalOptions } = require('firebase-functions/v2');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { REGION, TIMEZONE } = require('./src/config');
const { SPOTIFY_CLIENT_SECRET, ADMIN_SETUP_CODE } = require('./src/secrets');
const app = require('./src/api');
const playback = require('./src/playback');
const favourites = require('./src/favourites');

setGlobalOptions({ region: REGION, memory: '256MiB' });

// The API behind https://<site>/api/* (see the rewrite in firebase.json).
exports.api = onRequest(
  { secrets: [SPOTIFY_CLIENT_SECRET, ADMIN_SETUP_CODE], maxInstances: 3, timeoutSeconds: 60 },
  app,
);

// Every minute, 6:00am–7:59pm Melbourne time: sync what's playing and handle break
// pauses. Sometimes waits up to ~50 seconds for a song to end, so it runs on a small
// CPU share to stay inside the free allowance.
exports.tick = onSchedule(
  {
    schedule: '* 6-19 * * *',
    timeZone: TIMEZONE,
    secrets: [SPOTIFY_CLIENT_SECRET],
    cpu: 'gcf_gen1',
    concurrency: 1,
    maxInstances: 1,
    timeoutSeconds: 120,
    retryCount: 0,
  },
  () => playback.tick(),
);

// Sunday 8pm Melbourne time: rebuild "Warehouse Favourites" from this week's songs.
exports.weeklyFavourites = onSchedule(
  {
    schedule: '0 20 * * 0',
    timeZone: TIMEZONE,
    secrets: [SPOTIFY_CLIENT_SECRET],
    timeoutSeconds: 120,
    retryCount: 1,
  },
  () => favourites.build(),
);
