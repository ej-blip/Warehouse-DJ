'use strict';

// The gatekeeper. Pure functions only: they take the current time, the settings and the
// shared queue state, and decide. Firestore and Spotify never appear here, which keeps
// every rule unit-testable.

const { localParts, parseClock, formatClock, msAtLocalMinute } = require('./time');

const HOUR = 3600000;
const MINUTE = 60000;

function scheduleStatus(nowMs, settings) {
  const lp = localParts(nowMs);
  const open = parseClock(settings.open);
  const close = parseClock(settings.close);
  const mins = lp.minutesOfDay;

  if (!settings.days.includes(lp.weekday)) {
    return { open: false, state: 'dayoff', message: "There's no queueing today.", until: null };
  }
  if (mins < open) {
    return {
      open: false,
      state: 'before',
      message: `Queueing opens at ${formatClock(open)}.`,
      until: msAtLocalMinute(nowMs, open),
    };
  }
  if (mins >= close) {
    return { open: false, state: 'after', message: 'Queueing has finished for today.', until: null };
  }
  for (const b of settings.breaks) {
    const start = parseClock(b.start);
    const end = start + b.minutes;
    if (mins >= start && mins < end) {
      return {
        open: false,
        state: 'break',
        message: `Break time. Queueing reopens at ${formatClock(end)}.`,
        until: msAtLocalMinute(nowMs, end),
      };
    }
  }
  return { open: true, state: 'open', message: '', until: msAtLocalMinute(nowMs, close) };
}

function recentQueueTimes(core, deviceId, nowMs, settings) {
  const windowMs = settings.windowMinutes * MINUTE;
  return (core.deviceRecent[deviceId] || []).filter((t) => nowMs - t < windowMs).sort((a, b) => a - b);
}

function deviceQuota(nowMs, settings, core, deviceId) {
  const times = recentQueueTimes(core, deviceId, nowMs, settings);
  const limit = settings.songsPerWindow;
  const remaining = Math.max(0, limit - times.length);
  // When the iPad is out of songs, the next one frees up when its oldest request
  // in the window ages out.
  const nextAt = remaining > 0 ? null : times[times.length - limit] + settings.windowMinutes * MINUTE;
  return { limit, used: times.length, remaining, nextAt, windowMinutes: settings.windowMinutes };
}

// Why a particular song can't be queued right now, ignoring whose iPad is asking.
// Also used to grey out search results.
function trackBlock(nowMs, settings, core, track) {
  if (track.durationMs > settings.maxTrackMinutes * MINUTE) {
    return { code: 'too_long', message: `That song is longer than ${settings.maxTrackMinutes} minutes.` };
  }
  if (track.explicit && !settings.allowExplicit) {
    return { code: 'explicit', message: 'Explicit songs are switched off.' };
  }
  if (core.current && core.current.id === track.id) {
    return { code: 'playing', message: "That song's playing right now." };
  }
  if (core.pending.some((p) => p.trackId === track.id)) {
    return { code: 'in_queue', message: "That song's already in the queue." };
  }
  const last = core.recentTracks[track.id];
  if (settings.noRepeatHours > 0 && last && nowMs - last < settings.noRepeatHours * HOUR) {
    const hours = settings.noRepeatHours === 1 ? 'hour' : `${settings.noRepeatHours} hours`;
    return { code: 'recent', message: `That song was played or queued in the last ${hours}.` };
  }
  return null;
}

function checkQueueRequest({ nowMs, settings, device, track, core }) {
  if (!device.enabled) {
    return { ok: false, code: 'device_off', message: 'This iPad has been switched off by an admin.' };
  }
  const schedule = scheduleStatus(nowMs, settings);
  if (!schedule.open) {
    return { ok: false, code: 'closed', message: schedule.message, retryAt: schedule.until };
  }
  const blocked = trackBlock(nowMs, settings, core, track);
  if (blocked) return { ok: false, ...blocked };

  const quota = deviceQuota(nowMs, settings, core, device.id);
  if (quota.remaining === 0) {
    const songs = quota.limit === 1 ? '1 song' : `${quota.limit} songs`;
    return {
      ok: false,
      code: 'quota',
      message: `This iPad has queued its ${songs}. Next one available at ${formatClock(localParts(quota.nextAt).minutesOfDay)}.`,
      retryAt: quota.nextAt,
    };
  }
  if (core.pending.length >= settings.queueCap) {
    return {
      ok: false,
      code: 'full',
      message: `The queue is full (${settings.queueCap} songs). Try again after the next song.`,
    };
  }
  return { ok: true };
}

// ---- settings validation -------------------------------------------------

const EDITABLE = [
  'days', 'open', 'close', 'breaks', 'autoPause', 'autoResume', 'songsPerWindow', 'windowMinutes',
  'queueCap', 'maxTrackMinutes', 'noRepeatHours', 'allowExplicit', 'speakerDeviceName',
];

function intInRange(value, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

// Returns the full settings object with `patch` applied, or the list of problems.
function validateSettings(current, patch) {
  const next = { ...current };
  const errors = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);

  for (const key of Object.keys(patch)) {
    if (!EDITABLE.includes(key)) errors.push(`${key} can't be changed here.`);
  }

  if (has('days')) {
    const days = Array.isArray(patch.days) ? [...new Set(patch.days.map(Number))].sort() : null;
    if (!days || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) errors.push('Pick valid days.');
    else next.days = days;
  }
  for (const key of ['open', 'close']) {
    if (has(key)) {
      if (parseClock(patch[key]) === null) errors.push(`${key === 'open' ? 'Opening' : 'Closing'} time must look like 09:20.`);
      else next[key] = normaliseClock(patch[key]);
    }
  }
  if (parseClock(next.open) >= parseClock(next.close)) errors.push('Queueing must open before it closes.');

  if (has('breaks')) {
    if (!Array.isArray(patch.breaks) || patch.breaks.length > 8) {
      errors.push('Breaks must be a list (8 at most).');
    } else {
      const breaks = [];
      for (const b of patch.breaks) {
        const start = parseClock(b && b.start);
        const minutes = intInRange(b && b.minutes, 1, 240);
        if (start === null || minutes === null) {
          errors.push('Each break needs a start time and a length between 1 and 240 minutes.');
          break;
        }
        breaks.push({ start: normaliseClock(b.start), minutes });
      }
      breaks.sort((a, b) => parseClock(a.start) - parseClock(b.start));
      next.breaks = breaks;
    }
  }

  for (const key of ['autoPause', 'autoResume', 'allowExplicit']) {
    if (has(key)) {
      if (typeof patch[key] !== 'boolean') errors.push(`${key} must be on or off.`);
      else next[key] = patch[key];
    }
  }

  const ranges = {
    songsPerWindow: [1, 20, 'Songs per iPad must be between 1 and 20.'],
    windowMinutes: [1, 240, 'The time window must be between 1 and 240 minutes.'],
    queueCap: [1, 50, 'The queue limit must be between 1 and 50.'],
    maxTrackMinutes: [1, 30, 'The longest song must be between 1 and 30 minutes.'],
    noRepeatHours: [0, 12, 'No-repeat time must be between 0 and 12 hours.'],
  };
  for (const [key, [min, max, message]] of Object.entries(ranges)) {
    if (has(key)) {
      const n = intInRange(patch[key], min, max);
      if (n === null) errors.push(message);
      else next[key] = n;
    }
  }

  if (has('speakerDeviceName')) {
    if (typeof patch.speakerDeviceName !== 'string' || patch.speakerDeviceName.length > 100) {
      errors.push('Speaker name is too long.');
    } else {
      next.speakerDeviceName = patch.speakerDeviceName.trim();
    }
  }

  return errors.length ? { errors } : { settings: next };
}

function normaliseClock(hhmm) {
  const mins = parseClock(hhmm);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

module.exports = {
  scheduleStatus,
  deviceQuota,
  trackBlock,
  checkQueueRequest,
  validateSettings,
};
