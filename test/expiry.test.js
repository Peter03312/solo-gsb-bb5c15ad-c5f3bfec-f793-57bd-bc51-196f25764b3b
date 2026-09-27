'use strict';

// Multiparty commitment deadlines (v5 schema): an optional future UTC
// expiresAt at creation, lazy atomic termination on the first state-changing
// request after the deadline, active termination via POST /draws/:id/expire,
// conflict on late commitments/secrets, a single terminal state under
// concurrent reveal/expire, and unchanged legacy behaviour.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { buildApp } = require('../src/app');
const { secretHash } = require('../src/lottery');

function makeApp() {
  const db = openDatabase(':memory:');
  const app = buildApp(db, { logger: false });
  return { db, app };
}

const GROUPS = [
  { name: 'red', quota: 2, candidates: ['alice', 'bob', 'carol'] },
  { name: 'blue', quota: 1, candidates: ['dave', 'erin'] },
];
const groupsOnly = () => GROUPS.map((g) => ({ name: g.name, quota: g.quota, candidates: [...g.candidates] }));
const NAMES = ['alice', 'bob', 'carol'];
const SECRETS = {
  alice: 'alice-secret-entropy-01',
  bob: 'bob-secret-entropy-02',
  carol: 'carol-secret-entropy-03',
};

const FUTURE = new Date(Date.now() + 60_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

async function createMultiparty(app, { expiresAt, participants = NAMES } = {}) {
  const payload = { groups: groupsOnly(), participants };
  if (expiresAt !== undefined) payload.expiresAt = expiresAt;
  const res = await app.inject({ method: 'POST', url: '/draws', payload });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

async function commit(app, drawId, name, secret = SECRETS[name]) {
  return app.inject({
    method: 'POST',
    url: `/draws/${drawId}/participants/${name}/commitment`,
    payload: { commitment: secretHash(secret) },
  });
}

async function revealSecret(app, drawId, name, secret = SECRETS[name]) {
  return app.inject({
    method: 'POST',
    url: `/draws/${drawId}/participants/${name}/reveal`,
    payload: { secret },
  });
}

function forcePast(db, drawId, at = PAST) {
  db.prepare('UPDATE draws SET expires_at = ? WHERE id = ?').run(at, drawId);
}

test('expiresAt accepted for multiparty draws and omitted means no deadline', async () => {
  const { app } = makeApp();

  const withDeadline = await createMultiparty(app, { expiresAt: FUTURE });
  assert.equal(withDeadline.expiresAt, FUTURE);
  assert.equal(withDeadline.status, 'pending');

  const shown = (await app.inject({ method: 'GET', url: `/draws/${withDeadline.drawId}` })).json();
  assert.equal(shown.expiresAt, FUTURE);
  assert.equal(shown.expiredAt, undefined);

  const without = await createMultiparty(app);
  assert.equal(without.expiresAt, null);
  const shownWithout = (await app.inject({ method: 'GET', url: `/draws/${without.drawId}` })).json();
  assert.equal(shownWithout.expiresAt, null);
});

test('expiresAt validation: future UTC ISO only, multiparty only', async () => {
  const { app } = makeApp();

  const badCases = [
    PAST,                                        // in the past
    '2026-09-27T12:00:00',                       // no Z
    '2026-09-27T12:00:00+00:00',                 // offset form, not the canonical Z form
    '2026-09-27 12:00:00Z',                      // space instead of T
    'not-a-date',
  ];
  for (const expiresAt of badCases) {
    const res = await app.inject({
      method: 'POST',
      url: '/draws',
      payload: { groups: groupsOnly(), participants: NAMES, expiresAt },
    });
    assert.equal(res.statusCode, 400, `rejected: ${expiresAt}`);
  }

  // Fractional seconds are fine as long as it is future UTC.
  const frac = (await app.inject({
    method: 'POST',
    url: '/draws',
    payload: {
      groups: groupsOnly(),
      participants: NAMES,
      expiresAt: new Date(Date.now() + 10_000).toISOString().replace(/\.\d{3}Z$/, '.500Z'),
    },
  }));
  assert.equal(frac.statusCode, 201, frac.body);

  // Single-nonce draws cannot carry a deadline.
  const onSingle = await app.inject({
    method: 'POST',
    url: '/draws',
    payload: { groups: groupsOnly(), expiresAt: FUTURE },
  });
  assert.equal(onSingle.statusCode, 400);
});

test('commitments and reveals before the deadline follow the normal flow', async () => {
  const { app } = makeApp();
  const created = await createMultiparty(app, { expiresAt: FUTURE });

  for (const name of NAMES) {
    const r = await commit(app, created.drawId, name);
    assert.equal(r.statusCode, 201, r.body);
  }
  const r = await revealSecret(app, created.drawId, 'alice');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, 'committed');

  const shown = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}` })).json();
  assert.equal(shown.status, 'committed');
  assert.equal(shown.expiresAt, FUTURE);
  assert.equal(shown.expiredAt, undefined);
});

test('POST /draws/:id/expire actively terminates and records outstanding participants', async () => {
  const { db, app } = makeApp();
  const created = await createMultiparty(app, { expiresAt: FUTURE });

  // Final state when the deadline hits: alice revealed, bob committed only,
  // carol still pending. All three commit first (a reveal is only stored once
  // commitments are complete), then carol's commitment is removed to simulate
  // her never having committed.
  await commit(app, created.drawId, 'alice');
  await commit(app, created.drawId, 'bob');
  await commit(app, created.drawId, 'carol');
  await revealSecret(app, created.drawId, 'alice');
  db.prepare('UPDATE participants SET commitment = NULL, committed_at = NULL WHERE draw_id = ? AND name = ?')
    .run(created.drawId, 'carol');

  const expired = (await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/expire`,
  }));
  assert.equal(expired.statusCode, 200, expired.body);
  const body = expired.json();
  assert.equal(body.status, 'expired');
  assert.ok(typeof body.expiredAt === 'string');
  assert.ok(Date.parse(body.expiredAt) >= Date.parse(created.createdAt));
  assert.deepEqual(body.expiredParticipants.map((p) => p.name), ['bob', 'carol']);
  assert.deepEqual(body.expiredParticipants.map((p) => p.status), ['committed', 'pending']);
  assert.equal(body.expiredParticipants[0].commitment, secretHash(SECRETS.bob));
  assert.equal(body.expiredParticipants[1].commitment, null);

  // GET shows the deadline and termination info; per-participant rows survive.
  const shown = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}` })).json();
  assert.equal(shown.status, 'expired');
  assert.equal(shown.expiresAt, FUTURE);
  assert.equal(shown.expiredAt, body.expiredAt);
  assert.deepEqual(shown.expiredParticipants.map((p) => p.name), ['bob', 'carol']);
  assert.deepEqual(shown.participants.map((p) => p.status), ['revealed', 'committed', 'pending']);
});

test('expire is idempotent: repeated calls return the same terminal state', async () => {
  const { app } = makeApp();
  const created = await createMultiparty(app, { expiresAt: FUTURE });
  await commit(app, created.drawId, 'alice');

  const first = (await app.inject({ method: 'POST', url: `/draws/${created.drawId}/expire` })).json();
  assert.equal(first.status, 'expired');

  const second = await app.inject({ method: 'POST', url: `/draws/${created.drawId}/expire` });
  assert.equal(second.statusCode, 200);
  const again = second.json();
  assert.equal(again.status, 'expired');
  assert.equal(again.expiredAt, first.expiredAt, 'same termination timestamp');
  assert.deepEqual(again.expiredParticipants, first.expiredParticipants);
});

test('expire works without a deadline and on a 404/unsupported draw', async () => {
  const { app } = makeApp();

  const noDeadline = await createMultiparty(app);
  const r = await app.inject({ method: 'POST', url: `/draws/${noDeadline.drawId}/expire` });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, 'expired');
  assert.equal(r.json().expiresAt, null);
  assert.equal(r.json().expiredParticipants.length, 3);

  const missing = await app.inject({ method: 'POST', url: '/draws/nope/expire' });
  assert.equal(missing.statusCode, 404);

  const single = (await app.inject({
    method: 'POST',
    url: '/draws',
    payload: { groups: [{ name: 'solo', quota: 1, candidates: ['a'] }] },
  })).json();
  const onSingle = await app.inject({ method: 'POST', url: `/draws/${single.drawId}/expire` });
  assert.equal(onSingle.statusCode, 409);
});

test('revealed draws cannot be expired', async () => {
  const { app } = makeApp();
  const created = await createMultiparty(app, { expiresAt: FUTURE });
  for (const name of NAMES) await commit(app, created.drawId, name);
  for (const name of NAMES) await revealSecret(app, created.drawId, name);

  const r = await app.inject({ method: 'POST', url: `/draws/${created.drawId}/expire` });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().draw.status, 'revealed');

  // Still revealed, no termination timestamp.
  const shown = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}` })).json();
  assert.equal(shown.status, 'revealed');
  assert.equal(shown.expiredAt, undefined);
});

test('after the deadline the first state-changing request terminates the draw lazily', async () => {
  const { db, app } = makeApp();
  const created = await createMultiparty(app, { expiresAt: FUTURE });
  // alice and bob commit; carol does not. No one reveals.
  await commit(app, created.drawId, 'alice');
  await commit(app, created.drawId, 'bob');
  forcePast(db, created.drawId);

  // A late commitment atomically expires the draw inside its own transaction.
  const lateCommit = await commit(app, created.drawId, 'carol');
  assert.equal(lateCommit.statusCode, 409);
  assert.equal(lateCommit.json().draw.status, 'expired');
  assert.deepEqual(
    lateCommit.json().draw.expiredParticipants.map((p) => p.name),
    ['alice', 'bob', 'carol'],
    'committed but not revealed participants are also outstanding'
  );

  // Stored state is terminal.
  const shown = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}` })).json();
  assert.equal(shown.status, 'expired');
  assert.ok(Number.isFinite(Date.parse(shown.expiredAt)));
});

test('lazy expiry also triggers on a late reveal, and commits/secrets then conflict', async () => {
  const { db, app } = makeApp();
  const created = await createMultiparty(app, { expiresAt: FUTURE });
  for (const name of NAMES) await commit(app, created.drawId, name);
  await revealSecret(app, created.drawId, 'alice');
  forcePast(db, created.drawId);

  const lateReveal = await revealSecret(app, created.drawId, 'bob');
  assert.equal(lateReveal.statusCode, 409);
  assert.equal(lateReveal.json().draw.status, 'expired');
  assert.deepEqual(
    lateReveal.json().draw.expiredParticipants.map((p) => p.name),
    ['bob', 'carol'],
    'committed but never revealed'
  );

  // Every later write keeps returning the conflict with the same terminal
  // state; bob's secret must not have been stored.
  const afterCommit = await commit(app, created.drawId, 'bob');
  assert.equal(afterCommit.statusCode, 409);
  assert.equal(afterCommit.json().draw.status, 'expired');
  const afterReveal = await revealSecret(app, created.drawId, 'bob');
  assert.equal(afterReveal.statusCode, 409);
  assert.equal(afterReveal.json().draw.status, 'expired');

  const shown = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}` })).json();
  assert.deepEqual(shown.participants.map((p) => p.status), ['revealed', 'committed', 'committed']);
  assert.equal(shown.results, undefined, 'no draw outcome was ever produced');
  assert.equal(shown.nonce, undefined);
});

test('last reveal and expire are mutually exclusive: only one terminal state', async () => {
  // Order A: the last reveal lands before expire -> revealed wins.
  {
    const { app } = makeApp();
    const created = await createMultiparty(app, { expiresAt: FUTURE });
    for (const name of NAMES) await commit(app, created.drawId, name);
    await revealSecret(app, created.drawId, 'alice');
    await revealSecret(app, created.drawId, 'bob');
    const last = await revealSecret(app, created.drawId, 'carol');
    assert.equal(last.statusCode, 200);
    assert.equal(last.json().status, 'revealed');

    const expire = await app.inject({ method: 'POST', url: `/draws/${created.drawId}/expire` });
    assert.equal(expire.statusCode, 409, 'a revealed record cannot be terminated');

    const shown = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}` })).json();
    assert.equal(shown.status, 'revealed');
    assert.equal(shown.expiredAt, undefined);
    assert.ok(Array.isArray(shown.results));
  }

  // Order B: expire lands before the last reveal -> expired wins, and the
  // last reveal is rejected without producing an outcome.
  {
    const { app } = makeApp();
    const created = await createMultiparty(app, { expiresAt: FUTURE });
    for (const name of NAMES) await commit(app, created.drawId, name);
    await revealSecret(app, created.drawId, 'alice');
    await revealSecret(app, created.drawId, 'bob');

    const expire = await app.inject({ method: 'POST', url: `/draws/${created.drawId}/expire` });
    assert.equal(expire.statusCode, 200);
    assert.equal(expire.json().status, 'expired');
    assert.deepEqual(expire.json().expiredParticipants.map((p) => p.name), ['carol']);

    const last = await revealSecret(app, created.drawId, 'carol');
    assert.equal(last.statusCode, 409);
    assert.equal(last.json().draw.status, 'expired');

    const shown = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}` })).json();
    assert.equal(shown.status, 'expired');
    assert.equal(shown.results, undefined);
  }
});

test('pending draw expiring before any commitment records everyone as pending', async () => {
  const { db, app } = makeApp();
  const created = await createMultiparty(app, { expiresAt: FUTURE });
  forcePast(db, created.drawId);

  const r = await commit(app, created.drawId, 'alice');
  assert.equal(r.statusCode, 409);
  const { draw } = r.json();
  assert.equal(draw.status, 'expired');
  assert.deepEqual(draw.expiredParticipants.map((p) => p.name), NAMES);
  assert.ok(draw.expiredParticipants.every((p) => p.status === 'pending'));
});

test('stored verify and forfeit endpoints refuse expired draws', async () => {
  const { db, app } = makeApp();
  const created = await createMultiparty(app, { expiresAt: FUTURE });
  await commit(app, created.drawId, 'alice');
  forcePast(db, created.drawId);
  await commit(app, created.drawId, 'bob'); // triggers lazy expiry

  const verify = await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` });
  assert.equal(verify.statusCode, 409);

  const forfeit = await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/forfeits`,
    payload: { group: 'red', candidate: 'alice' },
  });
  assert.equal(forfeit.statusCode, 409);
});

test('SQL terminal-transition guards accept exactly one winner', () => {
  // The concurrency guarantee reduces to two conditional UPDATEs:
  //   reveal: status='committed' -> 'revealed'
  //   expire: status IN ('pending','committed') -> 'expired'
  // Whichever guarded UPDATE runs first changes the matching row away, so the
  // other statement matches zero rows. (Under real concurrency both run in
  // BEGIN IMMEDIATE transactions and the second one simply waits for the
  // write lock, then sees the committed terminal status.)
  const { db } = makeApp();
  db.prepare(
    `INSERT INTO draws (id, mode, status, commitment, seed, candidates, draw_count, created_at)
     VALUES ('race', 'multiparty', 'committed', 'c', 's', '[]', 0, ?)`
  ).run(new Date().toISOString());

  const revealSql = db.prepare(
    "UPDATE draws SET status='revealed' WHERE id='race' AND status='committed'"
  );
  const expireSql = db.prepare(
    "UPDATE draws SET status='expired' WHERE id='race' AND status IN ('pending','committed')"
  );

  // reveal first: expire afterwards is a no-op.
  assert.equal(revealSql.run().changes, 1);
  assert.equal(expireSql.run().changes, 0);
  assert.equal(db.prepare("SELECT status FROM draws WHERE id='race'").get().status, 'revealed');

  // Reset: expire first, reveal afterwards is a no-op.
  db.prepare("UPDATE draws SET status='committed' WHERE id='race'").run();
  assert.equal(expireSql.run().changes, 1);
  assert.equal(revealSql.run().changes, 0);
  assert.equal(db.prepare("SELECT status FROM draws WHERE id='race'").get().status, 'expired');

  // Neither guarded transition can run twice on the same row.
  assert.equal(expireSql.run().changes, 0);
});

test('legacy v1/v2 views stay unchanged (no expiry fields)', async () => {
  const { db, app } = makeApp();
  const {
    commitmentFor,
    commitmentForVersion,
    snapshotDigestFor,
    computeOrder,
  } = require('../src/lottery');
  const candidates = ['alice', 'bob', 'carol'];
  const seed = 'a'.repeat(64);
  const nonce = 'legacy';
  const order = computeOrder(seed, nonce, candidates);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO draws (id, mode, status, commitment, seed, nonce, candidates, draw_count,
                        result, created_at, revealed_at, protocol_version, snapshot_digest)
     VALUES ('legacy-v2', 'single', 'revealed', ?, ?, ?, ?, ?, ?, ?, ?, 'v2', ?)`
  ).run(
    commitmentForVersion('v2', seed, snapshotDigestFor(candidates, 2)),
    seed, nonce, JSON.stringify(candidates), 2,
    JSON.stringify({ order, winners: order.slice(0, 2) }), now, now,
    snapshotDigestFor(candidates, 2)
  );
  db.prepare(
    `INSERT INTO draws (id, mode, status, commitment, seed, nonce, candidates, draw_count,
                        result, created_at, revealed_at)
     VALUES ('legacy-v1', 'single', 'revealed', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    commitmentFor(seed), seed, nonce, JSON.stringify(candidates), 2,
    JSON.stringify({ order, winners: order.slice(0, 2) }), now, now
  );

  for (const id of ['legacy-v1', 'legacy-v2']) {
    const shown = (await app.inject({ method: 'GET', url: `/draws/${id}` })).json();
    assert.equal(shown.status, 'revealed');
    assert.equal(shown.expiresAt, undefined, `${id} keeps its original view`);
    assert.equal(shown.expiredAt, undefined);
    const report = (await app.inject({ method: 'GET', url: `/draws/${id}/verify` })).json();
    assert.equal(report.valid, true);
  }
});
