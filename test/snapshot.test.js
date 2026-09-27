'use strict';

// Legacy protocol coverage: v1 (no version marker, SHA-256(seed)) and v2
// (flat candidates/count snapshot commitment). New draws are v3 grouped, but
// every pre-v3 record must stay queryable and verifiable after the upgrade.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('../src/db');
const { buildApp } = require('../src/app');
const {
  sha256Hex,
  commitmentFor,
  commitmentForVersion,
  snapshotDigestFor,
  snapshotDigestForGroups,
  computeOrder,
} = require('../src/lottery');

function makeApp() {
  const db = openDatabase(':memory:');
  const app = buildApp(db, { logger: false });
  return { db, app };
}

const CANDIDATES = ['alice', 'bob', 'carol', 'dave', 'erin'];

function insertLegacy(db, { id, version = null, seed, nonce, candidates = CANDIDATES, count = 2 }) {
  const order = computeOrder(seed, nonce, candidates);
  const snapshotDigest = version === 'v2' ? snapshotDigestFor(candidates, count) : null;
  const commitment = version === 'v2'
    ? commitmentForVersion('v2', seed, snapshotDigest)
    : commitmentFor(seed);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO draws (id, mode, status, commitment, seed, nonce, candidates, draw_count,
                        result, created_at, revealed_at, protocol_version, snapshot_digest)
     VALUES (?, 'single', 'revealed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, commitment, seed, nonce, JSON.stringify(candidates), count,
    JSON.stringify({ order, winners: order.slice(0, count) }), now, now, version, snapshotDigest
  );
  return { order, commitment, snapshotDigest };
}

test('legacy v2 snapshot digest is count + length-prefixed utf8 candidates in order', () => {
  const digest = snapshotDigestFor(['ab', 'é', '🎲'], 2);
  assert.equal(digest, sha256Hex('2\n2:ab2:é4:🎲'));
  assert.notEqual(snapshotDigestFor(['ab', 'é', '🎲'], 3), digest);
  assert.notEqual(snapshotDigestFor(['é', 'ab', '🎲'], 2), digest);
  assert.notEqual(snapshotDigestFor(['ab', 'é', '🎰'], 2), digest);
});

test('commitmentForVersion: v3/v2 use the prefixed snapshot formula, everything else falls back to v1', () => {
  const seed = 'd'.repeat(64);
  const digest = snapshotDigestFor(CANDIDATES, 2);
  assert.equal(commitmentForVersion('v2', seed, digest), sha256Hex(`v2:${seed}:${digest}`));
  assert.equal(commitmentForVersion('v3', seed, digest), sha256Hex(`v3:${seed}:${digest}`));
  assert.equal(commitmentForVersion('v1', seed, digest), commitmentFor(seed));
  assert.equal(commitmentForVersion(undefined, seed, undefined), commitmentFor(seed));
});

test('v2 records verify with the v2 formula and v1 records with the legacy formula', async () => {
  const { app } = makeApp();
  const seed = 'a'.repeat(64);
  const nonce = 'legacy-nonce';
  const order = computeOrder(seed, nonce, CANDIDATES);

  const v2 = {
    version: 'v2',
    snapshotDigest: snapshotDigestFor(CANDIDATES, 2),
    commitment: commitmentForVersion('v2', seed, snapshotDigestFor(CANDIDATES, 2)),
    seed,
    nonce,
    candidates: CANDIDATES,
    count: 2,
    order,
    winners: order.slice(0, 2),
  };
  const ok2 = (await app.inject({ method: 'POST', url: '/verify', payload: v2 })).json();
  assert.equal(ok2.valid, true);
  assert.equal(ok2.version, 'v2');
  assert.equal(ok2.checks.snapshotDigestMatch, true);

  const reordered = { ...v2, candidates: [...CANDIDATES].reverse(), order: undefined, winners: undefined };
  const rep = (await app.inject({ method: 'POST', url: '/verify', payload: reordered })).json();
  assert.equal(rep.valid, false);
  assert.equal(rep.checks.commitmentMatch, false);
  assert.equal(rep.checks.snapshotDigestMatch, false);

  // No version marker => legacy v1 algorithm, no digest involved.
  const v1 = {
    commitment: commitmentFor(seed),
    seed,
    nonce,
    candidates: CANDIDATES,
    count: 2,
    order,
    winners: order.slice(0, 2),
  };
  const ok1 = (await app.inject({ method: 'POST', url: '/verify', payload: v1 })).json();
  assert.equal(ok1.valid, true);
  assert.equal(ok1.version, 'v1');
  assert.equal(ok1.snapshotDigest, undefined);

  const bad = (await app.inject({
    method: 'POST', url: '/verify', payload: { ...v1, seed: 'b'.repeat(64) },
  })).json();
  assert.equal(bad.valid, false);
  assert.equal(bad.checks.commitmentMatch, false);
});

test('pre-v3 database rows (v1 and v2) stay queryable and verifiable', async () => {
  const { db, app } = makeApp();
  insertLegacy(db, { id: 'legacy-v1', seed: 'b'.repeat(64), nonce: 'legacy-row' });
  insertLegacy(db, { id: 'legacy-v2', version: 'v2', seed: 'e'.repeat(64), nonce: 'legacy-row-2' });

  const shown1 = (await app.inject({ method: 'GET', url: '/draws/legacy-v1' })).json();
  assert.equal(shown1.version, 'v1');
  assert.equal(shown1.snapshotDigest, null);
  assert.equal(shown1.groups, undefined, 'flat view for legacy rows');
  assert.ok(Array.isArray(shown1.order));

  const shown2 = (await app.inject({ method: 'GET', url: '/draws/legacy-v2' })).json();
  assert.equal(shown2.version, 'v2');
  assert.ok(Array.isArray(shown2.candidates));
  assert.equal(shown2.groups, undefined);

  const r1 = (await app.inject({ method: 'GET', url: '/draws/legacy-v1/verify' })).json();
  assert.equal(r1.valid, true);
  assert.equal(r1.version, 'v1');
  assert.equal(r1.checks.commitmentMatch, true);
  assert.equal(r1.checks.orderMatch, true);

  const r2 = (await app.inject({ method: 'GET', url: '/draws/legacy-v2/verify' })).json();
  assert.equal(r2.valid, true);
  assert.equal(r2.version, 'v2');
  assert.equal(r2.checks.snapshotDigestMatch, true);
  assert.equal(r2.checks.orderMatch, true);
});

test('stored verify flags tampering in a legacy v2 row', async () => {
  const { db, app } = makeApp();
  const seed = 'f'.repeat(64);
  insertLegacy(db, { id: 'legacy-tamper', version: 'v2', seed, nonce: 'n', count: 2 });

  // Forge the stored order directly; the recomputation must disagree.
  const storedOrder = computeOrder(seed, 'n', CANDIDATES);
  db.prepare('UPDATE draws SET result = ? WHERE id = ?').run(
    JSON.stringify({ order: [...storedOrder].reverse(), winners: [...storedOrder].reverse().slice(0, 2) }),
    'legacy-tamper'
  );
  const report = (await app.inject({ method: 'GET', url: '/draws/legacy-tamper/verify' })).json();
  assert.equal(report.valid, false);
  assert.equal(report.checks.orderMatch, false);
});

test('startup migrates a v1 database file through v2 to v3 and keeps its row verifiable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draws-migration-'));
  const dbPath = path.join(dir, 'draws.db');

  // Original v0/v1 schema (no snapshot columns, no committed-phase concerns
  // for this single row), user_version = 1.
  const seed = 'c'.repeat(64);
  const nonce = 'pre-migration';
  const order = computeOrder(seed, nonce, CANDIDATES);
  {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE draws (
      id          TEXT PRIMARY KEY,
      mode        TEXT NOT NULL DEFAULT 'single' CHECK (mode IN ('single', 'multiparty')),
      status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'committed', 'revealed')),
      commitment  TEXT NOT NULL,
      seed        TEXT NOT NULL,
      nonce       TEXT,
      candidates  TEXT NOT NULL,
      draw_count  INTEGER NOT NULL,
      result      TEXT,
      created_at  TEXT NOT NULL,
      revealed_at TEXT
    )`);
    db.exec('PRAGMA user_version = 1');
    db.prepare(
      `INSERT INTO draws (id, mode, status, commitment, seed, nonce, candidates, draw_count,
                          result, created_at, revealed_at)
       VALUES ('pre-v3-draw', 'single', 'revealed', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      commitmentFor(seed), seed, nonce, JSON.stringify(CANDIDATES), 2,
      JSON.stringify({ order, winners: order.slice(0, 2) }),
      new Date().toISOString(), new Date().toISOString()
    );
    db.close();
  }

  const db = openDatabase(dbPath);
  const app = buildApp(db, { logger: false });
  try {
    const columns = db.prepare('PRAGMA table_info(draws)').all().map((c) => c.name);
    assert.ok(columns.includes('protocol_version'));
    assert.ok(columns.includes('snapshot_digest'));
    assert.ok(columns.includes('groups'), 'v3 migration adds groups');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'forfeit_events'").get(),
      'v4 migration adds the forfeit event log'
    );

    const report = (await app.inject({ method: 'GET', url: '/draws/pre-v3-draw/verify' })).json();
    assert.equal(report.valid, true);
    assert.equal(report.version, 'v1');

    // New draws on the migrated database use the v3 grouped commitment.
    const created = (await app.inject({
      method: 'POST',
      url: '/draws',
      payload: { groups: [{ name: 'only', quota: 1, candidates: CANDIDATES }] },
    })).json();
    assert.equal(created.version, 'v3');
    assert.equal(
      created.snapshotDigest,
      snapshotDigestForGroups([{ name: 'only', quota: 1, candidates: CANDIDATES }])
    );
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
