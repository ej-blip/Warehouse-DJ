'use strict';

const { defineSecret } = require('firebase-functions/params');

// Set with `firebase functions:secrets:set <NAME>`. Never commit these values.
const SPOTIFY_CLIENT_SECRET = defineSecret('SPOTIFY_CLIENT_SECRET');
// One-time code that lets the first admin create their PIN, and lets the owner reset a
// forgotten PIN later.
const ADMIN_SETUP_CODE = defineSecret('ADMIN_SETUP_CODE');

module.exports = { SPOTIFY_CLIENT_SECRET, ADMIN_SETUP_CODE };
