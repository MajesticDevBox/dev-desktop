// SQLite persistence (node:sqlite, built into Node 22.13+). Lives on the Docker volume at DATA_DIR.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'dev-desktop.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,          -- folder name under the repos dir (or custom slug)
  name        TEXT NOT NULL,
  path        TEXT,                          -- path inside the container, null for manual entries
  description TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '',      -- comma separated
  active      INTEGER NOT NULL DEFAULT 0,
  pinned      INTEGER NOT NULL DEFAULT 0,
  github_repo TEXT,                          -- owner/name override (auto-detected from origin otherwise)
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Links and tools. project_id NULL = global (shown in the top bar).
CREATE TABLE IF NOT EXISTS links (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  url          TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'link',  -- link | tool | env
  check_health INTEGER NOT NULL DEFAULT 0,
  sort         INTEGER NOT NULL DEFAULT 0
);

-- Copy-able commands per project (npm run dev, docker compose up, ...).
CREATE TABLE IF NOT EXISTS commands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  command    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS health_checks (
  link_id    INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  ts         INTEGER NOT NULL,
  ok         INTEGER NOT NULL,
  status     INTEGER,
  latency_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_health_link_ts ON health_checks(link_id, ts);
`);

export const q = {
  all: (sql, ...args) => db.prepare(sql).all(...args),
  get: (sql, ...args) => db.prepare(sql).get(...args),
  run: (sql, ...args) => db.prepare(sql).run(...args),
};

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
