-- Sơ đồ bàn tiệc — D1 schema
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS layouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  tables_json TEXT NOT NULL DEFAULT '[]',
  has_bg INTEGER NOT NULL DEFAULT 0,
  deployed INTEGER NOT NULL DEFAULT 0,
  state_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS layout_bg (
  layout_id INTEGER PRIMARY KEY,
  mime TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS table_state (
  layout_id INTEGER NOT NULL,
  table_id TEXT NOT NULL,
  empty INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (layout_id, table_id)
);

CREATE TABLE IF NOT EXISTS update_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  layout_id INTEGER NOT NULL,
  table_id TEXT NOT NULL,
  label TEXT,
  empty INTEGER,
  by_name TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_layout ON update_log (layout_id, id DESC);
