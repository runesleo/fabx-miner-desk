-- D1 schema for FabX Miner Desk usage stats and the rig income alert beta waitlist.
-- Apply: wrangler d1 execute fabx-miner-desk --remote --file=schema.sql
-- No IP addresses, user agents, wallet addresses (in hits), full URLs or query strings are stored.

CREATE TABLE IF NOT EXISTS hits (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  day  TEXT    NOT NULL,              -- UTC YYYY-MM-DD
  path TEXT    NOT NULL,              -- '/' or '/rigs'
  lang TEXT    NOT NULL,              -- 'zh' or 'en'
  ref  TEXT,                          -- referrer hostname only, or NULL
  cid  TEXT    NOT NULL,              -- random per-browser UUID from local storage
  ts   INTEGER NOT NULL               -- Unix milliseconds
);
CREATE INDEX IF NOT EXISTS hits_day_path ON hits (day, path);
CREATE INDEX IF NOT EXISTS hits_day_cid ON hits (day, cid);

CREATE TABLE IF NOT EXISTS alert_signups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  address    TEXT NOT NULL,           -- lowercase 0x address the alert watches
  telegram   TEXT NOT NULL,           -- lowercase username without '@'
  lang       TEXT NOT NULL,           -- 'zh' or 'en'
  chain      TEXT NOT NULL DEFAULT 'xlayer', -- 'xlayer' or 'bsc'; rows from before this column stay on X Layer
  created_at TEXT NOT NULL,           -- ISO 8601 UTC
  updated_at TEXT NOT NULL,
  UNIQUE (address, telegram, chain)
);
CREATE INDEX IF NOT EXISTS alert_signups_telegram ON alert_signups (telegram);

-- Growth 2026-10-25: per-chain stop alerts.
-- Fresh databases already have `chain` from the CREATE above (default xlayer).
-- Existing databases, apply once. Copy keeps every current signup on X Layer.
-- Ignore errors if alert_signups_chain already exists from a previous attempt.
--   CREATE TABLE alert_signups_chain (
--     id INTEGER PRIMARY KEY AUTOINCREMENT,
--     address TEXT NOT NULL,
--     telegram TEXT NOT NULL,
--     lang TEXT NOT NULL,
--     chain TEXT NOT NULL DEFAULT 'xlayer',
--     created_at TEXT NOT NULL,
--     updated_at TEXT NOT NULL,
--     UNIQUE (address, telegram, chain)
--   );
--   INSERT INTO alert_signups_chain (id, address, telegram, lang, chain, created_at, updated_at)
--     SELECT id, address, telegram, lang, 'xlayer', created_at, updated_at FROM alert_signups;
--   DROP TABLE alert_signups;
--   ALTER TABLE alert_signups_chain RENAME TO alert_signups;
--   CREATE INDEX IF NOT EXISTS alert_signups_telegram ON alert_signups (telegram);

-- Rig income alert delivery (alerts/worker.mjs). Telegram can only message chats that
-- opened the bot, so /start links a signup's username to a chat id. No names or phone numbers.
CREATE TABLE IF NOT EXISTS alert_chats (
  telegram   TEXT PRIMARY KEY,        -- lowercase username without '@', or 'chat:<id>' when the account has no username
  chat_id    INTEGER NOT NULL,
  lang       TEXT NOT NULL,           -- 'zh' or 'en'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Last known chain + measurement state per watched rig; alerts fire only on verified changes.
CREATE TABLE IF NOT EXISTS alert_rig_state (
  address       TEXT NOT NULL,
  rig_id        TEXT NOT NULL,
  chain_status  INTEGER,              -- getMiner.status (0–3); NULL until first confident read
  optimal       INTEGER,              -- 1 / 0 / NULL
  bonus         INTEGER,
  owner         TEXT,                 -- circuits.ownerOf at last observation
  status        TEXT,                 -- measurement: 'mining', 'stopped', or 'unknown'
  fab_per_day   REAL,
  head          INTEGER NOT NULL,
  observed_at   TEXT NOT NULL,
  PRIMARY KEY (address, rig_id)
);

CREATE TABLE IF NOT EXISTS alert_address_state (
  address         TEXT PRIMARY KEY,
  last_checked_at TEXT NOT NULL,
  last_error      TEXT,
  rigs            INTEGER,
  measured        INTEGER,
  head            INTEGER
);

CREATE TABLE IF NOT EXISTS alert_events (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  address              TEXT NOT NULL,
  rig_id               TEXT NOT NULL,
  kind                 TEXT NOT NULL,
  fab_per_day          REAL,
  previous_fab_per_day REAL,
  recipients           INTEGER NOT NULL,
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS alert_events_address ON alert_events (address, created_at);

-- Worker cursor and dedupe for global FabX PodMining governance logs.
CREATE TABLE IF NOT EXISTS alert_worker_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_governance_seen (
  tx_hash      TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

-- Feedback from the website's one-line box (no login) and the bot's /feedback command.
-- Stores the text, language, where it came from and, for the bot only, the chat key; never IPs or wallet addresses.
CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,              -- at most 500 characters
  lang       TEXT NOT NULL,              -- 'zh' or 'en'
  source     TEXT NOT NULL,              -- 'site' or 'bot'
  page       TEXT,                       -- '/' or '/rigs' for the site, NULL for the bot
  telegram   TEXT,                       -- bot: chat key (username or 'chat:<id>') so a fix can be answered; site: NULL
  created_at TEXT NOT NULL,              -- ISO 8601 UTC
  status     TEXT NOT NULL DEFAULT 'new' -- 'new', 'fixed', 'wontfix' (set by the maintainer)
);
CREATE INDEX IF NOT EXISTS feedback_created ON feedback (created_at);

-- Personal weekly digest (alerts/weekly.mjs): one message per subscribed address per ISO week (Beijing).
CREATE TABLE IF NOT EXISTS alert_weekly_sent (
  address    TEXT NOT NULL,
  week_key   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (address, week_key)
);

CREATE TABLE IF NOT EXISTS alert_weekly_snapshots (
  address       TEXT PRIMARY KEY,
  week_key      TEXT NOT NULL,
  mining_count  INTEGER NOT NULL,
  fab_total     REAL,
  updated_at    TEXT NOT NULL
);

-- One-time website → Telegram bind. 30 minutes, single use. No IP and no username until the bot redeems it.
-- Cheap official-listing alerts (X Layer). threshold_pct: notify when a listing is at least this percent cheaper than building.
-- alert_cheap_open / alert_cheap_closed: a listing that disappears from a complete scan is closed and never sent again.
CREATE TABLE IF NOT EXISTS alert_bind_tokens (
  token         TEXT PRIMARY KEY,
  lang          TEXT NOT NULL,
  chain         TEXT NOT NULL DEFAULT 'xlayer',
  address       TEXT,
  threshold_pct INTEGER NOT NULL DEFAULT 20,
  cheap         INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  used_at       TEXT
);

CREATE TABLE IF NOT EXISTS alert_cheap_subs (
  telegram      TEXT PRIMARY KEY,
  threshold_pct INTEGER NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  lang          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_cheap_open (
  listing_id TEXT PRIMARY KEY,
  circuit_id TEXT NOT NULL,
  seen_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_cheap_closed (
  listing_id TEXT PRIMARY KEY,
  closed_at  TEXT NOT NULL
);

-- DeWeb mirror surface for hosted /api/hit (apply before deploying hit.js that writes surface).
-- ALTER TABLE hits ADD COLUMN surface TEXT NOT NULL DEFAULT 'hosted'; -- 'hosted' | 'deweb'

-- Existing deployments (rig-stop alert era): apply once per database, ignore "duplicate column" errors.
-- ALTER TABLE alert_rig_state ADD COLUMN chain_status INTEGER;
-- ALTER TABLE alert_rig_state ADD COLUMN optimal INTEGER;
-- ALTER TABLE alert_rig_state ADD COLUMN bonus INTEGER;
-- ALTER TABLE alert_rig_state ADD COLUMN owner TEXT;

-- Apply the following Task K migration once, before deploying the reliability worker.
-- Existing weekly baselines are untrusted until replaced by a complete observation.
-- alert_weekly_sent remains a legacy table; new weekly dedupe uses alert_deliveries.
-- Task K reliability migration
-- CREATE TABLE IF NOT EXISTS alert_deliveries (delivery_key TEXT PRIMARY KEY, scope TEXT NOT NULL, recipient TEXT NOT NULL, address TEXT, subscriber TEXT, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','failed','unknown','sent','cancelled')), attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, receipt TEXT, last_error TEXT);
-- CREATE INDEX IF NOT EXISTS alert_deliveries_pending ON alert_deliveries(scope,status);
-- ALTER TABLE alert_rig_state ADD COLUMN field_observed_at TEXT;
-- ALTER TABLE alert_rig_state ADD COLUMN premium_active INTEGER;
-- ALTER TABLE alert_address_state ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE alert_weekly_snapshots ADD COLUMN complete INTEGER NOT NULL DEFAULT 0;
-- CREATE TABLE IF NOT EXISTS alert_weekly_reports (address TEXT NOT NULL, week_key TEXT NOT NULL, stats_json TEXT NOT NULL, prev_fab REAL, event_count INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(address, week_key));

-- Task Q server-side FAB 24h market stats (alerts/market.mjs + GET /api/market). Apply once before deploying worker/API.
-- CREATE TABLE IF NOT EXISTS market_swap_samples (block_number INTEGER NOT NULL, log_index INTEGER NOT NULL, bem_per_fab REAL NOT NULL, block_ts INTEGER NOT NULL, PRIMARY KEY (block_number, log_index));
-- CREATE INDEX IF NOT EXISTS market_swap_samples_ts ON market_swap_samples (block_ts);
-- CREATE TABLE IF NOT EXISTS market_fab_24h (id INTEGER PRIMARY KEY CHECK (id = 1), median_bem REAL NOT NULL, low_bem REAL NOT NULL, high_bem REAL NOT NULL, last_swap_bem REAL NOT NULL, swaps_24h INTEGER NOT NULL, head INTEGER NOT NULL, computed_at TEXT NOT NULL);

-- Task U BSC circuit NFT holder index (alerts/bsc-index.mjs + GET /api/bsc-rigs).
-- Apply once before deploying the alerts worker and /api/bsc-rigs.
-- Transfer logs are read in chunks of at most 1000 blocks, at most 15 chunks per 30-minute cron.
-- While complete = 0, GET /api/bsc-rigs returns message 索引建设中 and an empty rig list.
-- CREATE TABLE IF NOT EXISTS bsc_nft_holders (processor TEXT NOT NULL, token_id TEXT NOT NULL, owner TEXT NOT NULL, block_number INTEGER NOT NULL, log_index INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (processor, token_id));
-- CREATE INDEX IF NOT EXISTS bsc_nft_holders_owner ON bsc_nft_holders (owner);
-- CREATE TABLE IF NOT EXISTS bsc_index_state (id INTEGER PRIMARY KEY CHECK (id = 1), scanned_to INTEGER NOT NULL, head INTEGER, complete INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);

-- Daily board opt-in (/daily). Safe to run on a database that already has the other tables.
-- The day's send record is alert_deliveries (scope 'daily', key daily:YYYY-MM-DD:<chat_id>, Beijing date).
-- Failed rows retry on later runs the same day. Status unknown is never replayed.
CREATE TABLE IF NOT EXISTS alert_daily_subs (
  telegram   TEXT PRIMARY KEY,        -- same key as alert_chats
  enabled    INTEGER NOT NULL DEFAULT 1,
  lang       TEXT NOT NULL,           -- 'zh' or 'en'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
