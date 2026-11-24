import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const dbPath = process.env.ODD_DB ?? '.data/join-check.sqlite';
export const catalogPath = process.env.ODD_CATALOG_DB ?? '.data/catalog.sqlite';

function open(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  return db;
}

export function openCatalog(path = catalogPath) {
  const db = open(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS imports (
      sha TEXT PRIMARY KEY,
      analyzed_at TEXT NOT NULL,
      pool_size INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS columns (
      sha TEXT NOT NULL REFERENCES imports(sha),
      id INTEGER NOT NULL,
      dataset TEXT NOT NULL,
      title TEXT NOT NULL,
      file TEXT NOT NULL,
      resource TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      name TEXT NOT NULL,
      PRIMARY KEY (sha, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pairs (
      sha TEXT NOT NULL REFERENCES imports(sha),
      pool TEXT NOT NULL CHECK (pool IN ('detected', 'random')),
      ordinal INTEGER NOT NULL,
      a INTEGER NOT NULL,
      b INTEGER NOT NULL CHECK (b > a),
      score REAL,
      PRIMARY KEY (sha, pool, ordinal),
      UNIQUE (sha, a, b),
      FOREIGN KEY (sha, a) REFERENCES columns(sha, id),
      FOREIGN KEY (sha, b) REFERENCES columns(sha, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS column_examples (
      sha TEXT NOT NULL,
      id INTEGER NOT NULL,
      samples TEXT NOT NULL,
      PRIMARY KEY (sha, id),
      FOREIGN KEY (sha, id) REFERENCES columns(sha, id)
    ) STRICT;
  `);
  return db;
}

export function openDb(path = dbPath) {
  const db = open(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY,
      player INTEGER NOT NULL REFERENCES players(id),
      expires_at INTEGER NOT NULL
    ) STRICT;
  `);
  return db;
}

export function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = run();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
