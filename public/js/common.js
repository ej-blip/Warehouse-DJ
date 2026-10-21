// Shared helpers for the iPad page and the admin page.

const FIREBASE_VERSION = '12.19.0';
const TIMEZONE = 'Australia/Melbourne';

// ---- DOM ----------------------------------------------------------------

// el('div', { class: 'row', onclick: fn }, 'text', otherNode)
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function art(url, cls = 'art') {
  if (!url) return el('div', { class: cls });
  // Patchy Wi-Fi: fall back to a plain tile rather than a broken-image icon.
  const img = el('img', { class: cls, src: url, alt: '', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(el('div', { class: cls })), { once: true });
  return img;
}

let toastTimer = null;
export function toast(message, kind = '') {
  let node = $('#toast');
  if (!node) {
    node = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(node);
  }
  node.className = `toast ${kind}`;
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, kind === 'bad' ? 6000 : 3500);
}

// ---- formatting ---------------------------------------------------------

export function duration(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const clockFormat = new Intl.DateTimeFormat('en-AU', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit', hour12: true });
export function clockAt(ms) {
  return clockFormat.format(new Date(ms)).replace(/\s/g, '').toLowerCase();
}

const dateFormat = new Intl.DateTimeFormat('en-AU', { timeZone: TIMEZONE, day: 'numeric', month: 'short', year: 'numeric' });
export function dateAt(ms) {
  return dateFormat.format(new Date(ms));
}

export function ago(ms) {
  if (!ms) return 'never';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return dateAt(ms);
}

export const artistLine = (artists) => (artists || []).join(', ');

// ---- theme ------------------------------------------------------------------

// Auto follows the device's Light/Dark setting; Teal or Dark pins one on this device.
const THEME_KEY = 'wdj.theme';
const THEMES = ['auto', 'teal', 'dark'];
const THEME_NAMES = { auto: 'Auto', teal: 'Teal', dark: 'Dark' };

export function wireThemeToggle(button) {
  if (!button) return;
  const current = () => (THEMES.includes(storage.get(THEME_KEY)) ? storage.get(THEME_KEY) : 'auto');
  const apply = (theme) => {
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    button.textContent = `Theme: ${THEME_NAMES[theme]}`;
  };
  apply(current());
  button.addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(current()) + 1) % THEMES.length];
    if (next === 'auto') storage.remove(THEME_KEY);
    else storage.set(THEME_KEY, next);
    apply(next);
  });
}

// ---- icons ------------------------------------------------------------------

const ICONS = {
  play: '<path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l10.8-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z"/>',
  pause: '<rect x="6" y="5" width="4.2" height="14" rx="1.3"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.3"/>',
  next: '<path d="M4.5 5.6v12.8a1 1 0 0 0 1.56.83l9.1-6.4a1 1 0 0 0 0-1.66l-9.1-6.4A1 1 0 0 0 4.5 5.6z"/><rect x="16.6" y="5" width="2.9" height="14" rx="1.4"/>',
  thumb: '<path d="M2 21h4V9H2v12zm20-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L13.17 1 6.59 7.59C6.22 7.95 6 8.45 6 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/>',
  note: '<path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/>',
};

export function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;
  return span;
}

// ---- API ----------------------------------------------------------------

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    const err = new Error("Can't reach the server. Check the Wi-Fi.");
    err.code = 'network';
    throw err;
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    const err = new Error(data.message || `Something went wrong (${res.status}).`);
    err.code = data.error;
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// localStorage can throw in private mode or when storage is blocked.
export const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* not fatal */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* not fatal */ }
  },
};

// ---- Firestore (read-only live updates) -----------------------------------

let firestorePromise = null;

function firestore() {
  if (!firestorePromise) {
    firestorePromise = (async () => {
      const [{ initializeApp }, fs, config] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-firestore.js`),
        // Firebase Hosting serves the project's web config here.
        fetch('/__/firebase/init.json').then((r) => r.json()),
      ]);
      const app = initializeApp(config);
      const db = fs.getFirestore(app);
      // `firebase emulators:start` serves the site on localhost; use the local Firestore too.
      if (['localhost', '127.0.0.1'].includes(location.hostname)) fs.connectFirestoreEmulator(db, '127.0.0.1', 8080);
      return { db, fs };
    })();
  }
  return firestorePromise;
}

// Calls onData with the document's data on every change, and onStatus with
// 'live' | 'reconnecting' | 'error'.
export async function watchDoc(path, onData, onStatus = () => {}) {
  try {
    const { db, fs } = await firestore();
    return fs.onSnapshot(
      fs.doc(db, path),
      { includeMetadataChanges: true },
      (snap) => {
        onStatus(snap.metadata.fromCache ? 'reconnecting' : 'live');
        onData(snap.exists() ? snap.data() : null);
      },
      (err) => {
        console.error('Live updates failed', err);
        onStatus('error');
      },
    );
  } catch (err) {
    console.error('Could not start live updates', err);
    onStatus('error');
    return () => {};
  }
}
