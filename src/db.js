'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DRAWS_TABLE = `
  CREATE TABLE IF NOT EXISTS draws (
    id               TEXT PRIMARY KEY,
    mode             TEXT NOT NULL DEFAULT 'single' CHECK (mode IN ('single', 'multiparty')),
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'committed', 'revealed')),
    commitment       TEXT NOT NULL,
    seed             TEXT NOT NULL,
    nonce            TEXT,
    candidates       TEXT NOT NULL,
    draw_count       INTEGER NOT NULL,
    result           TEXT,
    created_at       TEXT NOT NULL,
    revealed_at      TEXT,
    protocol_version TEXT,
    snapshot_digest  TEXT,
    groups           TEXT
  );
`;

const PARTICIPANTS_TABLE = `
  CREATE TABLE IF NOT EXISTS participants (
    draw_id      TEXT NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL,
    name         TEXT NOT NULL,
    commitment   TEXT,
    secret       TEXT,
    committed_at TEXT,
    revealed_at  TEXT,
    PRIMARY KEY (draw_id, name)
  );
`;

const PARTICIPANTS_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_participants_draw_position
    ON participants (draw_id, position);
`;

// v4: forfeit/replacement event log for revealed v3 grouped draws. Each row
// is one sequenced forfeit (seq is 1-based per draw); `replacement` is the
// standby who took the vacated slot, NULL when the slot stayed vacant.
const FORFEIT_EVENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS forfeit_events (
    draw_id     TEXT NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    group_name  TEXT NOT NULL,
    candidate   TEXT NOT NULL,
    replacement TEXT,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (draw_id, seq)
  );
`;

// v1 databases predate the 'committed' phase and the participants table.
// SQLite cannot alter a CHECK constraint in place, so the draws table has to
// be recreated; existing rows keep their (single-party) semantics.
function migrateV0ToV1(db) {
  const ddl = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'draws'"
  ).get();
  if (ddl && ddl.sql.includes("'committed'")) return;

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN;');
  db.exec('ALTER TABLE draws RENAME TO draws_legacy;');
  db.exec(DRAWS_TABLE);
  db.exec(`
    INSERT INTO draws (id, mode, status, commitment, seed, nonce, candidates,
                       draw_count, result, created_at, revealed_at)
    SELECT id, 'single', status, commitment, seed, nonce, candidates,
           draw_count, result, created_at, revealed_at
      FROM draws_legacy;
  `);
  db.exec('DROP TABLE draws_legacy;');
  db.exec('COMMIT;');
  db.exec('PRAGMA foreign_keys = ON;');
}

// v2 draws bind the candidate snapshot (order, content, count) into the
// commitment. The new columns stay NULL for pre-v2 rows, which keeps them on
// the legacy v1 verification path.
function migrateV1ToV2(db) {
  const columns = db.prepare('PRAGMA table_info(draws)').all().map((c) => c.name);
  if (!columns.includes('protocol_version')) {
    db.exec('ALTER TABLE draws ADD COLUMN protocol_version TEXT');
  }
  if (!columns.includes('snapshot_digest')) {
    db.exec('ALTER TABLE draws ADD COLUMN snapshot_digest TEXT');
  }
}

// v3 draws replace the flat candidates/count snapshot with ordered quota
// groups. The groups JSON (ordered [{name, candidates, quota}]) lives in the
// new column; it stays NULL for pre-v3 rows, which remain on their original
// (v1/v2) verification paths.
function migrateV2ToV3(db) {
  const columns = db.prepare('PRAGMA table_info(draws)').all().map((c) => c.name);
  if (!columns.includes('groups')) {
    db.exec('ALTER TABLE draws ADD COLUMN groups TEXT');
  }
}

// v4 adds the forfeit/replacement event log used by revealed v3 draws. The
// draws table itself is untouched, so v1/v2/v3 rows keep their original
// query/verify behaviour.
function migrateV3ToV4(db) {
  db.exec(FORFEIT_EVENTS_TABLE);
}

// Opens (creating if needed) the SQLite database and ensures the schema exists.
function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // Contending BEGIN IMMEDIATE transactions wait for the write lock instead
  // of failing immediately with SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000;');

  const version = db.prepare('PRAGMA user_version').get().user_version;
  db.exec(DRAWS_TABLE);
  if (version < 1) {
    migrateV0ToV1(db);
    db.exec('PRAGMA user_version = 1;');
  }
  if (version < 2) {
    migrateV1ToV2(db);
    db.exec('PRAGMA user_version = 2;');
  }
  if (version < 3) {
    migrateV2ToV3(db);
    db.exec('PRAGMA user_version = 3;');
  }
  if (version < 4) {
    migrateV3ToV4(db);
    db.exec('PRAGMA user_version = 4;');
  }
  db.exec(PARTICIPANTS_TABLE);
  db.exec(PARTICIPANTS_INDEX);
  db.exec(FORFEIT_EVENTS_TABLE);
  return db;
}

module.exports = { openDatabase };
