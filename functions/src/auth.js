'use strict';

// Who is allowed to do what:
// - each iPad has its own secret token ("<id>.<secret>"); only a hash is stored. It's
//   either created on the iPad itself by an admin entering their PIN there (kept in that
//   iPad's storage, never shown), or handed out as a link for testing.
// - admins sign in with a personal PIN and get a 12-hour session.
// - the setup code (a Firebase secret) creates the first admin and can reset the owner's PIN.

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { db } = require('./store');
const { ADMIN_SETUP_CODE } = require('./secrets');
const { UserError } = require('./errors');

const scrypt = promisify(crypto.scrypt);
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (bytes) => crypto.randomBytes(bytes).toString('base64url');

function sameHex(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function cleanName(name, what) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (!n || n.length > 40) throw new UserError('bad_name', `Give the ${what} a name (up to 40 characters).`);
  return n;
}

// ---- iPads -----------------------------------------------------------------

const DEVICE_TOKEN = /^([a-f0-9]{10})\.([A-Za-z0-9_-]{32})$/;
const DEVICE_CACHE_MS = 30000;
const LAST_SEEN_EVERY_MS = 5 * 60000;
const deviceCache = new Map();

// via: 'setup' (set up on the device itself) or 'link' (a link, for testing)
async function createDevice(name, { via = 'link' } = {}) {
  const id = crypto.randomBytes(5).toString('hex');
  const secret = randomToken(24);
  const device = { name: cleanName(name, 'iPad'), secretHash: sha256(secret), via, enabled: true, createdAt: Date.now(), lastSeenAt: null };
  await db.doc(`devices/${id}`).set(device);
  return { id, name: device.name, token: `${id}.${secret}` };
}

async function newDeviceLink(id) {
  const ref = db.doc(`devices/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new UserError('not_found', 'That iPad no longer exists.', 404);
  const secret = randomToken(24);
  await ref.update({ secretHash: sha256(secret), via: 'link' });
  deviceCache.delete(id);
  return { id, name: snap.data().name, token: `${id}.${secret}` };
}

async function updateDevice(id, patch) {
  const ref = db.doc(`devices/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new UserError('not_found', 'That iPad no longer exists.', 404);
  const update = {};
  if (patch.name !== undefined) update.name = cleanName(patch.name, 'iPad');
  if (patch.enabled !== undefined) update.enabled = Boolean(patch.enabled);
  await ref.update(update);
  deviceCache.delete(id);
}

async function deleteDevice(id) {
  await db.doc(`devices/${id}`).delete();
  deviceCache.delete(id);
}

async function listDevices() {
  const snap = await db.collection('devices').orderBy('createdAt').get();
  return snap.docs.map((d) => {
    const { name, enabled, createdAt, lastSeenAt, via } = d.data();
    return { id: d.id, name, via: via || 'link', enabled: enabled !== false, createdAt, lastSeenAt: lastSeenAt || null };
  });
}

async function verifyDevice(token) {
  const m = DEVICE_TOKEN.exec(String(token || ''));
  if (!m) return null;
  const [, id, secret] = m;
  let entry = deviceCache.get(id);
  if (!entry || Date.now() - entry.at > DEVICE_CACHE_MS) {
    const snap = await db.doc(`devices/${id}`).get();
    entry = { at: Date.now(), data: snap.exists ? snap.data() : null };
    deviceCache.set(id, entry);
  }
  if (!entry.data || !sameHex(entry.data.secretHash, sha256(secret))) return null;
  if (!entry.data.lastSeenAt || Date.now() - entry.data.lastSeenAt > LAST_SEEN_EVERY_MS) {
    entry.data.lastSeenAt = Date.now();
    await db.doc(`devices/${id}`).update({ lastSeenAt: entry.data.lastSeenAt }).catch(() => {});
  }
  return { id, name: entry.data.name, enabled: entry.data.enabled !== false };
}

// ---- admins ----------------------------------------------------------------

const PIN = /^\d{6,8}$/;
const SESSION_MS = 12 * 3600000;

function checkPinFormat(pin) {
  if (!PIN.test(String(pin || ''))) throw new UserError('bad_pin', 'PINs are 6 to 8 digits.');
}

async function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(String(pin), salt, 32)).toString('hex');
  return { pinSalt: salt, pinHash: hash };
}

async function pinMatches(pin, admin) {
  const hash = (await scrypt(String(pin), admin.pinSalt, 32)).toString('hex');
  return sameHex(hash, admin.pinHash);
}

async function listAdmins() {
  const snap = await db.collection('admins').get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function findAdminByPin(pin, admins) {
  for (const a of admins) if (await pinMatches(pin, a)) return a;
  return null;
}

async function hasAdmins() {
  const snap = await db.collection('admins').limit(1).get();
  return !snap.empty;
}

async function createAdmin({ name, pin, owner = false }) {
  const cleanedName = cleanName(name, 'admin');
  checkPinFormat(pin);
  const admins = await listAdmins();
  if (await findAdminByPin(pin, admins)) throw new UserError('pin_taken', 'That PIN is already taken. Pick another.');
  const ref = db.collection('admins').doc();
  await ref.set({ name: cleanedName, ...(await hashPin(pin)), owner: Boolean(owner), createdAt: Date.now() });
  return { id: ref.id, name: cleanedName, owner: Boolean(owner) };
}

async function changePin(adminId, pin) {
  checkPinFormat(pin);
  const others = (await listAdmins()).filter((a) => a.id !== adminId);
  if (await findAdminByPin(pin, others)) throw new UserError('pin_taken', 'That PIN is already taken. Pick another.');
  await db.doc(`admins/${adminId}`).update(await hashPin(pin));
}

async function deleteAdmin(id, byAdmin) {
  if (id === byAdmin.id) throw new UserError('self', "You can't remove yourself.");
  const snap = await db.doc(`admins/${id}`).get();
  if (!snap.exists) return;
  if (snap.data().owner) throw new UserError('owner', "The owner can't be removed.");
  await snap.ref.delete();
}

async function createSession(admin) {
  const token = randomToken(32);
  await db.doc(`adminSessions/${sha256(token)}`).set({ adminId: admin.id, expiresAt: Date.now() + SESSION_MS });
  return token;
}

async function verifySession(token) {
  if (!token) return null;
  const snap = await db.doc(`adminSessions/${sha256(token)}`).get();
  if (!snap.exists) return null;
  const s = snap.data();
  if (s.expiresAt < Date.now()) {
    await snap.ref.delete().catch(() => {});
    return null;
  }
  const admin = await db.doc(`admins/${s.adminId}`).get();
  if (!admin.exists) return null; // removed admins lose access immediately
  return { id: admin.id, name: admin.data().name, owner: Boolean(admin.data().owner) };
}

async function endSession(token) {
  if (token) await db.doc(`adminSessions/${sha256(token)}`).delete().catch(() => {});
}

// ---- wrong-PIN lockout -----------------------------------------------------

// Per network address, plus a global ceiling in case addresses are spoofed.
const GUARD = db.doc('private/loginGuard');
const GUARD_WINDOW_MS = 15 * 60000;
const FAILS_PER_ADDRESS = 5;
const FAILS_GLOBAL = 20;

function lockedError() {
  return new UserError('locked', 'Too many wrong attempts. Try again in 15 minutes.', 429);
}

async function guardCheck(ip) {
  const snap = await GUARD.get();
  const g = snap.exists ? snap.data() : {};
  const now = Date.now();
  const key = sha256(ip).slice(0, 16);
  if ((g.global && g.global.lockedUntil > now) || (g[key] && g[key].lockedUntil > now)) throw lockedError();
}

async function guardFail(ip) {
  const key = sha256(ip).slice(0, 16);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(GUARD);
    const g = snap.exists ? snap.data() : {};
    const now = Date.now();
    for (const k of [key, 'global']) {
      const e = g[k] && now - g[k].firstAt < GUARD_WINDOW_MS ? g[k] : { fails: 0, firstAt: now, lockedUntil: 0 };
      e.fails += 1;
      if (e.fails >= (k === 'global' ? FAILS_GLOBAL : FAILS_PER_ADDRESS)) e.lockedUntil = now + GUARD_WINDOW_MS;
      g[k] = e;
    }
    for (const [k, e] of Object.entries(g)) {
      if (now - e.firstAt > GUARD_WINDOW_MS && e.lockedUntil < now) delete g[k];
    }
    tx.set(GUARD, g);
  });
}

// ---- setup code and OAuth state --------------------------------------------

function setupCodeMatches(code) {
  const expected = ADMIN_SETUP_CODE.value();
  if (!expected) throw new UserError('no_setup_code', 'The setup code has not been configured. See the README.', 500);
  return sameHex(sha256(String(code || '').trim()), sha256(expected.trim()));
}

async function createOAuthState(adminId) {
  const state = randomToken(24);
  await db.doc(`oauthStates/${state}`).set({ adminId, createdAt: Date.now() });
  return state;
}

async function consumeOAuthState(state) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(String(state || ''))) return false;
  const ref = db.doc(`oauthStates/${state}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    tx.delete(ref);
    return Date.now() - snap.data().createdAt < 10 * 60000;
  });
}

module.exports = {
  createDevice,
  newDeviceLink,
  updateDevice,
  deleteDevice,
  listDevices,
  verifyDevice,
  hasAdmins,
  listAdmins,
  findAdminByPin,
  createAdmin,
  changePin,
  deleteAdmin,
  createSession,
  verifySession,
  endSession,
  guardCheck,
  guardFail,
  setupCodeMatches,
  createOAuthState,
  consumeOAuthState,
};
