// One-time website → Telegram bind. The page never asks for a username: it stores a
// short-lived token, the button opens t.me/<bot>?start=<token>, and /start redeems it.
// Tokens are 32 hex characters (Telegram's start payload allows at most 64).

export const BIND_TTL_MS = 30 * 60 * 1000;
export const BOT_USERNAME = 'fabx_miner_desk_bot';
export const DEFAULT_THRESHOLD = 20;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TOKEN_RE = /^[0-9a-f]{32}$/;

export function normalizeThreshold(value) {
  if (typeof value === 'string') value = value.trim();
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 90) return null;
  return n;
}

export function createBindToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function bindStartUrl(token) {
  return `https://t.me/${BOT_USERNAME}?start=${token}`;
}

export function parseBindBody(body) {
  if (!body || body.bind !== true) return { error: 'bad_json' };
  const lang = body.lang === 'zh' ? 'zh' : 'en';
  const chain = body.chain === 'bsc' ? 'bsc' : 'xlayer';
  let address = null;
  if (body.address != null && body.address !== '') {
    if (typeof body.address !== 'string' || !ADDRESS.test(body.address.trim())) return { error: 'bad_address' };
    address = body.address.trim().toLowerCase();
  }
  const threshold = body.threshold == null || body.threshold === '' ? DEFAULT_THRESHOLD : normalizeThreshold(body.threshold);
  if (threshold == null) return { error: 'bad_threshold' };
  // Cheap listings are an X Layer FabX market. BSC address alerts do not turn them on.
  const cheap = chain === 'bsc' || body.cheap === false ? 0 : 1;
  return { lang, chain, address, threshold, cheap };
}

export async function saveBindToken(db, parsed, { token = createBindToken(), now = new Date(), ttlMs = BIND_TTL_MS } = {}) {
  if (!TOKEN_RE.test(token)) throw new Error('bad bind token');
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  await db.prepare(`INSERT INTO alert_bind_tokens
    (token, lang, chain, address, threshold_pct, cheap, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(token, parsed.lang, parsed.chain, parsed.address, parsed.threshold, parsed.cheap, createdAt, expiresAt).run();
  return { token, url: bindStartUrl(token), expiresAt };
}

// Claim is single-use. Chat, optional address watch, and the cheap-listing subscription
// commit only after the token row is marked used.
export async function redeemBindToken(db, rawToken, { telegram, chatId, now = new Date(), maxAddresses = 20 } = {}) {
  const token = String(rawToken || '').trim().toLowerCase();
  if (!TOKEN_RE.test(token)) return { error: 'missing' };
  const row = await db.prepare('SELECT * FROM alert_bind_tokens WHERE token = ?').bind(token).first();
  if (!row) return { error: 'missing' };
  const lang = row.lang === 'zh' ? 'zh' : 'en';
  const stamp = now.toISOString();
  if (row.used_at || String(row.expires_at) <= stamp) return { error: row.used_at ? 'used' : 'expired', lang };
  const claim = await db.prepare(`UPDATE alert_bind_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL AND expires_at > ?`)
    .bind(stamp, token, stamp).run();
  if (!claim.meta?.changes) return { error: 'used', lang };
  const statements = [
    db.prepare(`INSERT INTO alert_chats (telegram, chat_id, lang, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(telegram) DO UPDATE SET chat_id = excluded.chat_id, lang = excluded.lang, updated_at = excluded.updated_at`)
      .bind(telegram, chatId, lang, stamp, stamp),
  ];
  let addressLimited = false;
  let watched = false;
  if (row.address) {
    const existing = await db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN address = ? AND chain = ? THEN 1 ELSE 0 END) AS same
      FROM alert_signups WHERE telegram = ?`).bind(row.address, row.chain, telegram).first();
    if (!Number(existing?.same) && Number(existing?.n) >= maxAddresses) addressLimited = true;
    else {
      watched = true;
      statements.push(db.prepare(`INSERT INTO alert_signups (address, telegram, lang, chain, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(address, telegram, chain) DO UPDATE SET lang = excluded.lang, updated_at = excluded.updated_at`)
        .bind(row.address, telegram, lang, row.chain, stamp, stamp));
    }
  }
  const cheap = Number(row.cheap) === 1;
  if (cheap) {
    const existing = await db.prepare('SELECT threshold_pct FROM alert_cheap_subs WHERE telegram = ?').bind(telegram).first();
    const previous = existing ? Number(existing.threshold_pct) : null;
    const next = Number(row.threshold_pct);
    statements.push(db.prepare(`INSERT INTO alert_cheap_subs (telegram, threshold_pct, enabled, lang, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(telegram) DO UPDATE SET threshold_pct = excluded.threshold_pct, enabled = 1, lang = excluded.lang, updated_at = excluded.updated_at`)
      .bind(telegram, next, lang, stamp, stamp));
    if (previous != null && next > previous) {
      statements.push(db.prepare(`UPDATE alert_deliveries SET status = 'cancelled', updated_at = ?, last_error = 'threshold raised'
        WHERE scope = 'cheap' AND subscriber = ? AND status IN ('pending', 'failed')`).bind(stamp, telegram));
    }
  }
  await db.batch(statements);
  return {
    ok: true, lang, cheap, threshold: Number(row.threshold_pct), chain: row.chain,
    address: row.address || null, watched, addressLimited,
  };
}
