// One privacy-friendly page-load count per visit. No cookies; respects Do Not Track.
// Sends: a random per-browser id from local storage, '/' or '/rigs', zh|en, and the referrer hostname only.
// Never throws into the page; silently does nothing where /api/hit does not exist (e.g. the DeWeb copy).

const ENDPOINT = '/api/hit';
const CID_KEY = 'fmd.cid';

function randomId(crypto) {
  if (crypto?.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  if (crypto?.getRandomValues) crypto.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Returns the payload it sent, or null when skipped. Every browser API is injected so tests stay offline.
export function sendHit(env = globalThis) {
  try {
    const { navigator: nav, localStorage: store, location: loc, document: doc } = env;
    if (!nav || nav.doNotTrack === '1' || env.doNotTrack === '1') return null;
    let cid;
    try {
      cid = store.getItem(CID_KEY);
      if (!cid) { cid = randomId(env.crypto); store.setItem(CID_KEY, cid); }
    } catch { return null; }
    const path = /^\/rigs\/?$/.test(loc?.pathname || '') ? '/rigs' : '/';
    let saved = null;
    try { saved = store.getItem('fmd.lang'); } catch {}
    const lang = saved === 'zh' || saved === 'en' ? saved : (String(nav.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
    let ref = null;
    try {
      const host = doc?.referrer ? new URL(doc.referrer).hostname : '';
      if (host && host !== loc?.hostname) ref = host;
    } catch {}
    const payload = { cid, path, lang, ref };
    const body = JSON.stringify(payload);
    let sent = false;
    try { sent = typeof nav.sendBeacon === 'function' && nav.sendBeacon(ENDPOINT, new env.Blob([body], { type: 'application/json' })); } catch {}
    if (!sent && typeof env.fetch === 'function') {
      env.fetch(ENDPOINT, { method: 'POST', body, keepalive: true, credentials: 'omit', headers: { 'content-type': 'application/json' } }).catch(() => {});
    }
    return payload;
  } catch { return null; }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') sendHit(window);
