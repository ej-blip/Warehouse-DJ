'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduleStatus, deviceQuota, checkQueueRequest, trackBlock, validateSettings } = require('../src/rules');
const { emptyCore } = require('../src/core');
const { DEFAULT_SETTINGS } = require('../src/config');

const settings = { ...DEFAULT_SETTINGS };
const MIN = 60000;
// Monday 19 Oct 2026, Melbourne (AEDT = UTC+11). Local h:m -> UTC ms.
const at = (h, m) => Date.UTC(2026, 9, 19, h, m) - 11 * 3600000;

const device = { id: 'ipad1', name: 'Packing 1', enabled: true };
const track = (id, extra = {}) => ({ id, uri: `spotify:track:${id}`, durationMs: 200000, explicit: false, ...extra });

test('schedule: before, open, breaks, after, weekend', () => {
  assert.equal(scheduleStatus(at(9, 0), settings).state, 'before');
  assert.equal(scheduleStatus(at(9, 0), settings).message, 'Queueing opens at 9:20am.');
  assert.equal(scheduleStatus(at(9, 20), settings).open, true);
  const brk = scheduleStatus(at(10, 25), settings);
  assert.equal(brk.state, 'break');
  assert.equal(brk.message, 'Break time. Queueing reopens at 10:40am.');
  assert.equal(brk.until, at(10, 40));
  assert.equal(scheduleStatus(at(10, 40), settings).open, true);
  assert.equal(scheduleStatus(at(13, 59), settings).state, 'break'); // 40 minute lunch
  assert.equal(scheduleStatus(at(14, 0), settings).open, true);
  assert.equal(scheduleStatus(at(16, 0), settings).state, 'after');
  const saturday = at(12, 0) + 5 * 86400000;
  assert.equal(scheduleStatus(saturday, settings).state, 'dayoff');
});

test('quota: 3 songs per 30 minutes per iPad', () => {
  const core = emptyCore();
  const t0 = at(11, 0);
  core.deviceRecent.ipad1 = [t0, t0 + MIN, t0 + 2 * MIN];
  const q = deviceQuota(t0 + 5 * MIN, settings, core, 'ipad1');
  assert.equal(q.remaining, 0);
  assert.equal(q.nextAt, t0 + 30 * MIN);
  assert.equal(deviceQuota(t0 + 30 * MIN, settings, core, 'ipad1').remaining, 1);
  assert.equal(deviceQuota(t0 + 5 * MIN, settings, core, 'other').remaining, 3);
});

test('queue request is rejected with a reason for each rule', () => {
  const now = at(11, 0);
  const core = emptyCore();
  const ok = (overrides = {}) => checkQueueRequest({ nowMs: now, settings, device, track: track('a'), core, ...overrides });

  assert.deepEqual(ok(), { ok: true });
  assert.equal(ok({ device: { ...device, enabled: false } }).code, 'device_off');
  assert.equal(ok({ nowMs: at(10, 30) }).code, 'closed');
  assert.equal(ok({ track: track('a', { durationMs: 7 * MIN + 1 }) }).code, 'too_long');
  assert.equal(ok({ track: track('a', { explicit: true }) }).ok, true);
  assert.equal(ok({ settings: { ...settings, allowExplicit: false }, track: track('a', { explicit: true }) }).code, 'explicit');

  core.recentTracks.a = now - 119 * MIN;
  assert.equal(ok().code, 'recent');
  core.recentTracks.a = now - 121 * MIN;
  assert.equal(ok().ok, true);

  core.pending.push({ id: 'p', trackId: 'a', state: 'queued' });
  assert.equal(ok().code, 'in_queue');
  core.pending = [];

  core.current = { id: 'a' };
  assert.equal(ok().code, 'playing');
  core.current = null;

  core.deviceRecent.ipad1 = [now - 10 * MIN, now - 5 * MIN, now - MIN];
  const q = ok();
  assert.equal(q.code, 'quota');
  assert.equal(q.message, 'This iPad has queued its 3 songs. Next one available at 11:20am.');
  core.deviceRecent = {};

  core.pending = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, trackId: `t${i}`, state: 'queued' }));
  assert.equal(ok().code, 'full');
});

test('trackBlock is used to grey out search results', () => {
  const core = emptyCore();
  assert.equal(trackBlock(at(11, 0), settings, core, track('x')), null);
  assert.equal(trackBlock(at(11, 0), settings, core, track('x', { durationMs: 8 * MIN })).code, 'too_long');
});

test('validateSettings accepts good input and rejects bad input', () => {
  const ok = validateSettings(settings, { open: '9:00', breaks: [{ start: '13:20', minutes: 40 }, { start: '10:20', minutes: 20 }] });
  assert.equal(ok.settings.open, '09:00');
  assert.deepEqual(ok.settings.breaks.map((b) => b.start), ['10:20', '13:20']);

  assert.ok(validateSettings(settings, { open: '17:00' }).errors.length);
  assert.ok(validateSettings(settings, { songsPerWindow: 0 }).errors.length);
  assert.ok(validateSettings(settings, { queueCap: 'lots' }).errors.length);
  assert.ok(validateSettings(settings, { favourites: {} }).errors.length);
  assert.ok(validateSettings(settings, { autoPause: 'yes' }).errors.length);
  assert.deepEqual(validateSettings(settings, { days: [5, 1, 1] }).settings.days, [1, 5]);
});
