-- D1 schema for FabX Miner Desk usage stats and the rig-stop alert beta waitlist.
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
  created_at TEXT NOT NULL,           -- ISO 8601 UTC
  updated_at TEXT NOT NULL,
  UNIQUE (address, telegram)
);
CREATE INDEX IF NOT EXISTS alert_signups_telegram ON alert_signups (telegram);
