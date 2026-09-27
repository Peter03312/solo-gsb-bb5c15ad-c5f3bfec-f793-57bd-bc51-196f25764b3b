'use strict';

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
  buildV3Snapshot,
  snapshotDigestForGroups,
  commitmentForVersion,
  secretHash,
  computeGroupOrder,
  computeGroupedResult,
} = require('../src/lottery');

function makeApp() {
  const db = openDatabase(':memory:');
  const app = buildApp(db, { logger: false });
  return { db, app };
}

const GROUPS = [
  { name: 'red', quota: 2, candidates: ['alice', 'bob', 'carol'] },
  { name: 'blue', quota: 1, candidates: ['dave', 'erin'] },
  { name: 'observers', quota: 0, candidates: ['frank', 'grace'] },
];
const groupsOnly = () => GROUPS.map((g) => ({ name: g.name, quota: g.quota, candidates: [...g.candidates] }));

test('v3 snapshot: "v3\\n" + group count, then per group length-prefixed name, quota, count and candidates', () => {
  // 'é' is 2 UTF-8 bytes, '🎲' is 4 — the name/candidate prefixes count bytes.
  const groups = [
    { name: '红组', quota: 1, candidates: ['ab', 'é'] },
    { name: 'b', quota: 0, candidates: ['🎲'] },
  ];
  const snapshot = buildV3Snapshot(groups);
  assert.equal(
    snapshot,
    'v3\n2\n'
      + '6:红组1\n2\n' + '2:ab2:é'
      + '1:b0\n1\n' + '4:🎲'
  );
  assert.equal(snapshotDigestForGroups(groups), sha256Hex(snapshot));

  // Each group field is part of the snapshot.
  assert.notEqual(snapshotDigestForGroups([{ ...groups[0], quota: 0 }, groups[1]]), snapshotDigestForGroups(groups));
  assert.notEqual(snapshotDigestForGroups([{ ...groups[0], name: '蓝组' }, groups[1]]), snapshotDigestForGroups(groups));
  assert.notEqual(snapshotDigestForGroups([{ ...groups[0], candidates: ['ab', 'é', 'x'] }, groups[1]]), snapshotDigestForGroups(groups));
  assert.notEqual(snapshotDigestForGroups([groups[1], groups[0]]), snapshotDigestForGroups(groups), 'group order is bound');
  assert.notEqual(snapshotDigestForGroups([{ ...groups[0], candidates: ['é', 'ab'] }, groups[1]]), snapshotDigestForGroups(groups), 'candidate order is bound');
});

test('v3 create publishes the grouped commitment; seed stays hidden until reveal', async () => {
  const { db, app } = makeApp();
  const res = await app.inject({ method: 'POST', url: '/draws', payload: { groups: groupsOnly() } });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.version, 'v3');
  assert.equal(body.mode, 'single');
  assert.equal(body.groupCount, 3);
  assert.equal(body.totalQuota, 3);
  assert.equal(body.candidateCount, 7);
  const expectedDigest = snapshotDigestForGroups(GROUPS);
  assert.equal(body.snapshotDigest, expectedDigest);
  assert.match(body.commitment, /^[0-9a-f]{64}$/);
  assert.equal(body.seed, undefined, 'seed must stay hidden');
  assert.deepEqual(body.groups.map((g) => g.name), ['red', 'blue', 'observers']);
  assert.equal(body.groups[2].candidateCount, 2);

  const row = db.prepare('SELECT protocol_version, snapshot_digest, groups, draw_count, candidates FROM draws WHERE id = ?').get(body.drawId);
  assert.equal(row.protocol_version, 'v3');
  assert.equal(row.snapshot_digest, expectedDigest);
  assert.deepEqual(JSON.parse(row.groups), GROUPS);

  const shown = (await app.inject({ method: 'GET', url: `/draws/${body.drawId}` })).json();
  assert.equal(shown.version, 'v3');
  assert.equal(shown.seed, undefined);
  assert.equal(shown.results, undefined);
  assert.equal(shown.groups[0].order, undefined, 'no per-group order before reveal');
});

test('v3 single-nonce reveal returns per-group order and winners with independent group streams', async () => {
  const { app } = makeApp();
  const created = (await app.inject({
    method: 'POST', url: '/draws', payload: { groups: groupsOnly() },
  })).json();
  const reveal = await app.inject({
    method: 'POST', url: `/draws/${created.drawId}/reveal`, payload: { nonce: 'nonce-1' },
  });
  assert.equal(reveal.statusCode, 200);
  const r = reveal.json();
  assert.equal(r.status, 'revealed');
  assert.equal(r.version, 'v3');
  assert.equal(r.commitment, sha256Hex(`v3:${r.seed}:${created.snapshotDigest}`));
  assert.equal(r.nonce, 'nonce-1');

  assert.equal(r.results.length, 3);
  assert.deepEqual(r.results.map((g) => g.name), ['red', 'blue', 'observers']);
  assert.deepEqual(r.results.map((g) => g.quota), [2, 1, 0]);
  // Each group: full shuffled order, first quota entries are winners.
  const expectedAll = computeGroupedResult(r.seed, 'nonce-1', GROUPS);
  for (let gi = 0; gi < GROUPS.length; gi += 1) {
    const expected = computeGroupOrder(r.seed, 'nonce-1', gi, GROUPS[gi].candidates);
    assert.deepEqual(r.results[gi].order, expected);
    assert.deepEqual(r.results[gi].winners, expected.slice(0, GROUPS[gi].quota));
    assert.deepEqual(r.results[gi].candidates, GROUPS[gi].candidates);
    // The order is a permutation of exactly that group's candidates.
    assert.deepEqual([...r.results[gi].order].sort(), [...GROUPS[gi].candidates].sort());
  }
  assert.deepEqual(r.results[2].winners, [], 'quota 0 yields no winners');

  // Whole-result helper agrees (on the fields the helper produces).
  r.results.forEach((g, i) => {
    assert.equal(g.name, expectedAll[i].name);
    assert.deepEqual(g.order, expectedAll[i].order);
    assert.deepEqual(g.winners, expectedAll[i].winners);
  });

  // Group streams are independent: SHA-256(seed:nonce:<groupIndex>:<blockIndex>),
  // block index restarts at 0 per group (group 2 does not continue group 1).
  assert.deepEqual(
    computeGroupOrder(r.seed, 'nonce-1', 0, ['a', 'b', 'c']),
    computeGroupOrder(r.seed, 'nonce-1', 0, ['a', 'b', 'c']),
    'deterministic'
  );

  // Second reveal rejected.
  const again = await app.inject({
    method: 'POST', url: `/draws/${created.drawId}/reveal`, payload: { nonce: 'nonce-2' },
  });
  assert.equal(again.statusCode, 409);
});

test('v3 create validation: group names unique, candidates non-empty/globally unique, quota bounded, total quota >= 1', async () => {
  const { app } = makeApp();
  const cases = [
    { groups: [] },
    { groups: [{ name: 'a', candidates: ['x'], quota: 0 }] }, // total quota 0
    { groups: [{ name: 'a', candidates: ['x'], quota: 2 }] }, // quota > group size
    { groups: [{ name: 'a', candidates: ['x'], quota: 1 }, { name: 'a', candidates: ['y'], quota: 1 }] }, // dup name
    { groups: [{ name: 'a', candidates: ['x'], quota: 1 }, { name: 'b', candidates: ['x'], quota: 1 }] }, // global dup candidate
    { groups: [{ name: 'a', candidates: ['x', 'x'], quota: 1 }] }, // dup within group
    { groups: [{ name: '', candidates: ['x'], quota: 1 }] }, // empty group name
  ];
  for (const payload of cases) {
    const res = await app.inject({ method: 'POST', url: '/draws', payload });
    assert.equal(res.statusCode, 400, `rejected ${JSON.stringify(payload)}: ${res.body}`);
  }

  // quota may equal group size; zero-quota groups are allowed as long as the
  // total quota is positive.
  const ok = await app.inject({
    method: 'POST', url: '/draws',
    payload: { groups: [{ name: 'a', candidates: ['x', 'y'], quota: 2 }, { name: 'b', candidates: ['z'], quota: 0 }] },
  });
  assert.equal(ok.statusCode, 201);

  // The legacy flat payload is rejected (groups is required). Unknown top
  // level fields alongside a valid groups payload are ignored by Fastify's
  // additional-properties removal; groups stays the single source of truth.
  const noGroups = await app.inject({
    method: 'POST', url: '/draws', payload: { candidates: ['a'], count: 1 },
  });
  assert.equal(noGroups.statusCode, 400);
});

test('stored v3 verify recomputes grouped commitment, per-group orders and winners', async () => {
  const { app } = makeApp();
  const created = (await app.inject({ method: 'POST', url: '/draws', payload: { groups: groupsOnly() } })).json();
  const early = await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` });
  assert.equal(early.statusCode, 409);
  await app.inject({ method: 'POST', url: `/draws/${created.drawId}/reveal`, payload: { nonce: 'n' } });

  const report = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` })).json();
  assert.equal(report.valid, true);
  assert.equal(report.version, 'v3');
  assert.equal(report.snapshotDigest, created.snapshotDigest);
  for (const key of [
    'groupsValid', 'snapshotDigestMatch', 'commitmentMatch',
    'resultsCountMatch', 'groupNamesMatch', 'membershipMatch',
    'quotasMatch', 'ordersMatch', 'winnersMatch',
  ]) {
    assert.equal(report.checks[key], true, key);
  }
  assert.equal(report.expected.results.length, 3);
});

test('independent v3 verify accepts honest grouped records', async () => {
  const { app } = makeApp();
  const created = (await app.inject({ method: 'POST', url: '/draws', payload: { groups: groupsOnly() } })).json();
  const r = (await app.inject({
    method: 'POST', url: `/draws/${created.drawId}/reveal`, payload: { nonce: 'n-xyz' },
  })).json();

  const res = await app.inject({
    method: 'POST', url: '/verify',
    payload: {
      version: 'v3',
      snapshotDigest: r.snapshotDigest,
      commitment: r.commitment,
      seed: r.seed,
      nonce: 'n-xyz',
      groups: groupsOnly(),
      results: r.results,
    },
  });
  const body = res.json();
  assert.equal(body.valid, true);
  assert.equal(body.version, 'v3');
  assert.equal(body.snapshotDigest, created.snapshotDigest);
  assert.equal(body.checks.commitmentMatch, true);
  assert.equal(body.checks.ordersMatch, true);
  assert.equal(body.checks.winnersMatch, true);
  // results are optional: without them only the snapshot/commitment are checked.
  const noResults = await app.inject({
    method: 'POST', url: '/verify',
    payload: { version: 'v3', commitment: r.commitment, seed: r.seed, nonce: 'n-xyz', groups: groupsOnly() },
  });
  assert.equal(noResults.json().valid, true);
});

test('v3 verify flags group-name, membership and quota tampering via the snapshot-bound commitment', async () => {
  const { app } = makeApp();
  const created = (await app.inject({ method: 'POST', url: '/draws', payload: { groups: groupsOnly() } })).json();
  const r = (await app.inject({
    method: 'POST', url: `/draws/${created.drawId}/reveal`, payload: { nonce: 'n' },
  })).json();
  const base = {
    version: 'v3', snapshotDigest: r.snapshotDigest, commitment: r.commitment,
    seed: r.seed, nonce: 'n', groups: groupsOnly(),
  };

  // Rename a group.
  const renamed = { ...base, groups: base.groups.map((g) => (g.name === 'red' ? { ...g, name: 'crimson' } : g)) };
  const rep1 = (await app.inject({ method: 'POST', url: '/verify', payload: renamed })).json();
  assert.equal(rep1.valid, false);
  assert.equal(rep1.checks.commitmentMatch, false);
  assert.equal(rep1.checks.snapshotDigestMatch, false);
  assert.ok(rep1.problems.some((p) => p.includes('组名')));

  // Move a candidate between groups (membership tampering, counts preserved).
  const moved = {
    ...base,
    groups: [
      { name: 'red', quota: 2, candidates: ['bob', 'carol'] },
      { name: 'blue', quota: 1, candidates: ['alice', 'dave', 'erin'] },
      GROUPS[2],
    ],
  };
  const rep2 = (await app.inject({ method: 'POST', url: '/verify', payload: moved })).json();
  assert.equal(rep2.valid, false);
  assert.equal(rep2.checks.commitmentMatch, false);
  assert.equal(rep2.checks.snapshotDigestMatch, false);

  // Change a quota (still within group size).
  const requota = { ...base, groups: base.groups.map((g) => (g.name === 'red' ? { ...g, quota: 3 } : g)) };
  const rep3 = (await app.inject({ method: 'POST', url: '/verify', payload: requota })).json();
  assert.equal(rep3.valid, false);
  assert.equal(rep3.checks.commitmentMatch, false);

  // A supplied snapshotDigest that disagrees with the snapshot is flagged.
  const rep4 = (await app.inject({
    method: 'POST', url: '/verify',
    payload: { ...base, snapshotDigest: '0'.repeat(64) },
  })).json();
  assert.equal(rep4.valid, false);
  assert.equal(rep4.checks.snapshotDigestMatch, false);
  assert.equal(rep4.checks.commitmentMatch, true, 'commitment still checks out; the digest mismatch is reported on its own');

  // Bad seed breaks the commitment on its own.
  const rep5 = (await app.inject({
    method: 'POST', url: '/verify',
    payload: { ...base, seed: '0'.repeat(64) },
  })).json();
  assert.equal(rep5.valid, false);
  assert.equal(rep5.checks.commitmentMatch, false);
});

test('v3 verify flags result tampering against an honest snapshot', async () => {
  const { app } = makeApp();
  const created = (await app.inject({ method: 'POST', url: '/draws', payload: { groups: groupsOnly() } })).json();
  const r = (await app.inject({
    method: 'POST', url: `/draws/${created.drawId}/reveal`, payload: { nonce: 'n' },
  })).json();
  const base = {
    version: 'v3', commitment: r.commitment, seed: r.seed, nonce: 'n',
    groups: groupsOnly(), results: r.results,
  };

  // Forge the winners of one group.
  const forgeWinners = {
    ...base,
    results: base.results.map((g) => (g.name === 'red' ? { ...g, winners: [...g.winners].reverse() } : g)),
  };
  const rep1 = (await app.inject({ method: 'POST', url: '/verify', payload: forgeWinners })).json();
  assert.equal(rep1.valid, false);
  assert.equal(rep1.checks.winnersMatch, false);
  assert.equal(rep1.checks.ordersMatch, true, 'the order is untouched');
  assert.ok(rep1.problems.some((p) => p.includes('winners mismatch')));

  // Forge an order while keeping it a permutation of the group's candidates.
  const forgeOrder = {
    ...base,
    results: base.results.map((g) => (g.name === 'blue'
      ? { ...g, order: [...g.order].reverse(), winners: [...g.order].reverse().slice(0, g.quota) }
      : g)),
  };
  const rep2 = (await app.inject({ method: 'POST', url: '/verify', payload: forgeOrder })).json();
  assert.equal(rep2.valid, false);
  assert.equal(rep2.checks.ordersMatch, false);
  assert.equal(rep2.checks.membershipMatch, true, 'still a permutation of the right candidates');

  // Inject a candidate from another group (membership tampering in results).
  const forgeMembership = {
    ...base,
    results: base.results.map((g) => (g.name === 'blue'
      ? { ...g, order: ['alice', 'erin'], winners: ['alice'] }
      : g)),
  };
  const rep3 = (await app.inject({ method: 'POST', url: '/verify', payload: forgeMembership })).json();
  assert.equal(rep3.valid, false);
  assert.equal(rep3.checks.membershipMatch, false);
  assert.equal(rep3.checks.ordersMatch, false);

  // Result group renamed / quota changed / count mismatch.
  const renameResult = {
    ...base,
    results: base.results.map((g, i) => (i === 0 ? { ...g, name: 'crimson' } : g)),
  };
  const rep4 = (await app.inject({ method: 'POST', url: '/verify', payload: renameResult })).json();
  assert.equal(rep4.checks.groupNamesMatch, false);

  const quotaResult = {
    ...base,
    results: base.results.map((g, i) => (i === 0 ? { ...g, quota: 1 } : g)),
  };
  const rep5 = (await app.inject({ method: 'POST', url: '/verify', payload: quotaResult })).json();
  assert.equal(rep5.checks.quotasMatch, false);

  const missingGroup = { ...base, results: base.results.slice(0, 2) };
  const rep6 = (await app.inject({ method: 'POST', url: '/verify', payload: missingGroup })).json();
  assert.equal(rep6.checks.resultsCountMatch, false);
});

test('v3 verify requires a groups array; malformed groups are reported as tampering', async () => {
  const { app } = makeApp();
  const missing = await app.inject({
    method: 'POST', url: '/verify',
    payload: { version: 'v3', commitment: 'x', seed: 'y', nonce: 'z' },
  });
  assert.equal(missing.statusCode, 400);

  const broken = await app.inject({
    method: 'POST', url: '/verify',
    payload: {
      version: 'v3', commitment: 'x', seed: 'y', nonce: 'z',
      groups: [{ name: 'a', candidates: ['x'], quota: 0 }], // total quota 0 -> invalid snapshot
    },
  });
  const body = broken.json();
  assert.equal(body.valid, false);
  assert.equal(body.checks.groupsValid, false);
  assert.equal(body.checks.commitmentMatch, false);
});

test('per-group shuffle stays unbiased (rejection sampling sanity)', () => {
  const trials = 120000;
  const first = new Map();
  for (let k = 0; k < trials; k += 1) {
    const order = computeGroupOrder('f'.repeat(64), `n-${k}`, 7, ['x', 'y', 'z']);
    first.set(order[0], (first.get(order[0]) || 0) + 1);
  }
  for (const name of ['x', 'y', 'z']) {
    const p = first.get(name) / trials;
    assert.ok(Math.abs(p - 1 / 3) < 0.01, `${name} first-place probability ${p} within 1% of 1/3`);
  }
});

test('startup migrates a v2 database file to v3 and keeps v1/v2 rows verifiable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draws-migration3-'));
  const dbPath = path.join(dir, 'draws.db');

  // Build a v2 database exactly as the previous release would, with one
  // revealed v2 row and one legacy v1 row.
  const seed = 'c'.repeat(64);
  const candidates = ['alice', 'bob', 'carol', 'dave', 'erin'];
  const { snapshotDigestFor, commitmentFor, computeOrder } = require('../src/lottery');
  const order = computeOrder(seed, 'pre-migration', candidates);
  const now = new Date().toISOString();
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
      revealed_at TEXT,
      protocol_version TEXT,
      snapshot_digest  TEXT
    )`);
    db.exec('PRAGMA user_version = 2');
    db.prepare(
      `INSERT INTO draws (id, mode, status, commitment, seed, nonce, candidates, draw_count,
                          result, created_at, revealed_at, protocol_version, snapshot_digest)
       VALUES ('pre-v3-v2', 'single', 'revealed', ?, ?, ?, ?, ?, ?, ?, ?, 'v2', ?)`
    ).run(
      commitmentForVersion('v2', seed, snapshotDigestFor(candidates, 2)),
      seed, 'pre-migration', JSON.stringify(candidates), 2,
      JSON.stringify({ order, winners: order.slice(0, 2) }), now, now,
      snapshotDigestFor(candidates, 2)
    );
    db.prepare(
      `INSERT INTO draws (id, mode, status, commitment, seed, nonce, candidates, draw_count,
                          result, created_at, revealed_at)
       VALUES ('pre-v3-v1', 'single', 'revealed', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      commitmentFor(seed), seed, 'pre-migration', JSON.stringify(candidates), 2,
      JSON.stringify({ order, winners: order.slice(0, 2) }), now, now
    );
    db.close();
  }

  const db = openDatabase(dbPath);
  const app = buildApp(db, { logger: false });
  try {
    const columns = db.prepare('PRAGMA table_info(draws)').all().map((c) => c.name);
    assert.ok(columns.includes('groups'), 'migration adds groups');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'forfeit_events'").get(),
      'v4 migration adds the forfeit event log'
    );

    const v2report = (await app.inject({ method: 'GET', url: '/draws/pre-v3-v2/verify' })).json();
    assert.equal(v2report.valid, true);
    assert.equal(v2report.version, 'v2');

    const v1report = (await app.inject({ method: 'GET', url: '/draws/pre-v3-v1/verify' })).json();
    assert.equal(v1report.valid, true);
    assert.equal(v1report.version, 'v1');

    // New draws on the migrated database use the v3 grouped commitment.
    const created = (await app.inject({
      method: 'POST', url: '/draws', payload: { groups: groupsOnly() },
    })).json();
    assert.equal(created.version, 'v3');
    assert.equal(created.snapshotDigest, snapshotDigestForGroups(GROUPS));
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
