'use strict';

// Runs the fake Spotify on port 8787 for local development with the emulators.
// Its "Spotify account" approves the login straight away and has a handful of songs.

const { createFakeSpotify } = require('./fake-spotify');

const port = Number(process.env.PORT) || 8787;
createFakeSpotify().server.listen(port, '127.0.0.1', () => {
  console.log(`Fake Spotify listening on http://127.0.0.1:${port}`);
});
