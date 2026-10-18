'use strict';

// Errors that are safe to show on an iPad: a short code for the frontend and a sentence
// for the worker.
class UserError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'UserError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

class SpotifyError extends Error {
  constructor({ status, reason = null, message, retryAfter = null }) {
    super(message || `Spotify returned ${status}`);
    this.name = 'SpotifyError';
    this.status = status;
    this.reason = reason;
    this.retryAfter = retryAfter;
  }
}

class SpotifyAuthError extends Error {
  constructor(message, { needsReauth = false } = {}) {
    super(message);
    this.name = 'SpotifyAuthError';
    this.needsReauth = needsReauth;
  }
}

const SPEAKER_OFFLINE_MESSAGE = "The speaker isn't reachable. Open Spotify on the clock-in iPad and press play.";

function speakerOffline() {
  return new UserError('speaker_offline', SPEAKER_OFFLINE_MESSAGE, 409);
}

function toUserError(err) {
  if (err instanceof UserError) return err;
  if (err instanceof SpotifyAuthError) {
    return new UserError('spotify_disconnected', 'Spotify needs reconnecting. Ask an admin to open the admin page.', 503);
  }
  if (err instanceof SpotifyError) {
    if (err.reason === 'NO_ACTIVE_DEVICE' || err.status === 404) return speakerOffline();
    if (err.reason === 'PREMIUM_REQUIRED' || err.reason === 'NO_PREMIUM') {
      return new UserError('premium', 'Spotify says this account needs Premium.', 502);
    }
    if (err.status === 429) {
      return new UserError('busy', "Spotify's busy. Try again in a few seconds.", 503, { retryAfter: err.retryAfter });
    }
    if (err.status === 403) return new UserError('refused', "Spotify didn't allow that right now.", 502);
    return new UserError('spotify_error', "Spotify didn't respond properly. Try again.", 502);
  }
  return new UserError('server_error', 'Something went wrong. Try again.', 500);
}

module.exports = { UserError, SpotifyError, SpotifyAuthError, speakerOffline, toUserError };
