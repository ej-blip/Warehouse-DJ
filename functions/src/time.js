'use strict';

const { TIMEZONE } = require('./config');

// Cloud Functions run on UTC, so every wall-clock rule goes through these helpers.
// Intl handles Melbourne's daylight saving changes for us.
const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  hourCycle: 'h23',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function localParts(ms) {
  const p = {};
  for (const part of partsFormat.formatToParts(new Date(ms))) p[part.type] = part.value;
  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);
  const hour = Number(p.hour) % 24;
  const minute = Number(p.minute);
  const second = Number(p.second);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: WEEKDAYS[p.weekday],
    minutesOfDay: hour * 60 + minute,
    dateKey: `${p.year}-${p.month}-${p.day}`,
  };
}

function parseClock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// 560 -> "9:20am"
function formatClock(minutesOfDay) {
  const total = ((minutesOfDay % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

function formatClockAt(ms) {
  return formatClock(localParts(ms).minutesOfDay);
}

// The UTC instant of a wall-clock minute later the same local day. Daylight saving
// switches at 2–3am, outside any window this app cares about.
function msAtLocalMinute(nowMs, minutesOfDay) {
  const lp = localParts(nowMs);
  const startOfMinute = nowMs - (lp.second * 1000 + (nowMs % 1000));
  return startOfMinute + (minutesOfDay - lp.minutesOfDay) * 60000;
}

// ISO 8601 week, e.g. "2026-W43". Weeks run Monday to Sunday.
function isoWeekKey(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayIndex = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - dayIndex + 3); // Thursday of this week
  const isoYear = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Index = (jan4.getUTCDay() + 6) % 7;
  const week1Thursday = new Date(Date.UTC(isoYear, 0, 4 - jan4Index + 3));
  const week = 1 + Math.round((date - week1Thursday) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function weekKeyAt(ms) {
  const lp = localParts(ms);
  return isoWeekKey(lp.year, lp.month, lp.day);
}

module.exports = {
  localParts,
  parseClock,
  formatClock,
  formatClockAt,
  msAtLocalMinute,
  isoWeekKey,
  weekKeyAt,
};
