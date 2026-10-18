'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { localParts, parseClock, formatClock, msAtLocalMinute, isoWeekKey, weekKeyAt } = require('../src/time');

test('localParts uses Melbourne time, including daylight saving', () => {
  // 2026-10-19 is a Monday. AEDT (UTC+11) since 2026-10-04.
  const summer = localParts(Date.UTC(2026, 9, 18, 23, 20)); // 10:20am Mon 19 Oct AEDT
  assert.equal(summer.weekday, 1);
  assert.equal(summer.hour, 10);
  assert.equal(summer.minute, 20);
  assert.equal(summer.dateKey, '2026-10-19');

  // 2026-07-20 is a Monday in AEST (UTC+10).
  const winter = localParts(Date.UTC(2026, 6, 19, 23, 20)); // 9:20am Mon 20 Jul AEST
  assert.equal(winter.weekday, 1);
  assert.equal(winter.minutesOfDay, 9 * 60 + 20);
});

test('midnight is hour 0, not 24', () => {
  const lp = localParts(Date.UTC(2026, 9, 18, 13, 0)); // 00:00 Mon 19 Oct AEDT
  assert.equal(lp.hour, 0);
  assert.equal(lp.minutesOfDay, 0);
});

test('parseClock and formatClock', () => {
  assert.equal(parseClock('09:20'), 560);
  assert.equal(parseClock('9:20'), 560);
  assert.equal(parseClock('24:00'), null);
  assert.equal(parseClock('nope'), null);
  assert.equal(formatClock(560), '9:20am');
  assert.equal(formatClock(12 * 60), '12:00pm');
  assert.equal(formatClock(16 * 60), '4:00pm');
  assert.equal(formatClock(0), '12:00am');
});

test('msAtLocalMinute finds a later wall-clock minute today', () => {
  const now = Date.UTC(2026, 9, 18, 23, 20, 37, 500); // 10:20:37.5am AEDT
  const target = msAtLocalMinute(now, 10 * 60 + 40);
  assert.equal(target, Date.UTC(2026, 9, 18, 23, 40, 0, 0));
});

test('ISO week keys', () => {
  assert.equal(isoWeekKey(2026, 10, 19), '2026-W43');
  assert.equal(isoWeekKey(2026, 10, 25), '2026-W43'); // Sunday stays in the same week
  assert.equal(isoWeekKey(2026, 10, 26), '2026-W44');
  assert.equal(isoWeekKey(2021, 1, 3), '2020-W53'); // year boundary
  assert.equal(isoWeekKey(2024, 12, 30), '2025-W01');
  // Sunday 8pm in Melbourne is still Sunday locally even though UTC is also Sunday morning.
  assert.equal(weekKeyAt(Date.UTC(2026, 9, 25, 9, 0)), '2026-W43');
});
