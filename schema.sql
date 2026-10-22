-- D1: tunnel_control (bereits eingespielt, hier zur Doku / Neuaufbau)

CREATE TABLE IF NOT EXISTS tunnel_state (
  tunnel_id        TEXT PRIMARY KEY,
  label            TEXT NOT NULL,
  desired          TEXT NOT NULL DEFAULT 'off' CHECK (desired IN ('on','off')),
  expires_at       TEXT,
  auto_off_minutes INTEGER NOT NULL DEFAULT 120,
  actual           TEXT NOT NULL DEFAULT 'unknown' CHECK (actual IN ('running','stopped','unknown')),
  last_heartbeat   TEXT,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_by       TEXT
);

CREATE TABLE IF NOT EXISTS tunnel_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  tunnel_id TEXT NOT NULL,
  event     TEXT NOT NULL,
  actor     TEXT,
  detail    TEXT
);

CREATE INDEX IF NOT EXISTS idx_tunnel_log_ts ON tunnel_log (tunnel_id, ts DESC);

-- Weiteren Tunnel anlegen:
-- INSERT INTO tunnel_state (tunnel_id, label) VALUES ('ha', 'Home Assistant');
INSERT OR IGNORE INTO tunnel_state (tunnel_id, label) VALUES ('erp', 'ERP');
