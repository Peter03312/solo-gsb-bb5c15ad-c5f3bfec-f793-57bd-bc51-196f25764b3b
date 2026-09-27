'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { buildApp } = require('../src/app');
const {
  sha256Hex,
  secretHash,
  aggregateNonce,
  computeGroupedResult,
  snapshotDigestForGroups,
} = require('../src/lottery');

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

async function createMultiparty(app, participants = NAMES, groups = groupsOnly()) {
  const res = await app.inject({
    method: 'POST',
    url: '/draws',
    payload: { groups, participants },
  });
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

test('create with participants fixes the participant order and starts in commitment phase', async () => {
  const { app } = makeApp();
  const created = await createMultiparty(app);
  assert.equal(created.mode, 'multiparty');
  assert.equal(created.version, 'v3');
  assert.equal(created.status, 'pending');
  assert.deepEqual(created.participants.map((p) => p.name), NAMES);
  assert.deepEqual(created.participants.map((p) => p.position), [0, 1, 2]);
  assert.ok(created.participants.every((p) => p.status === 'pending'));

  const shown = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}` })).json();
  assert.equal(shown.mode, 'multiparty');
  assert.equal(shown.committedCount, 0);
  assert.equal(shown.revealedCount, 0);
  assert.ok(shown.participants.every((p) => p.commitment === null));
  assert.equal(shown.nonce, undefined);
  assert.equal(shown.results, undefined);
});

test('full multi-party flow aggregates secret hashes in fixed order and draws per group', async () => {
  const { app } = makeApp();
  const created = await createMultiparty(app);

  // Commitments can land in arbitrary order.
  const c3 = await commit(app, created.drawId, 'carol');
  assert.equal(c3.statusCode, 201);
  assert.equal(c3.json().status, 'committed', 'first commitment opens the committed phase');
  assert.equal(c3.json().committedCount, 1);
  await commit(app, created.drawId, 'alice');
  await commit(app, created.drawId, 'bob');

  // Reveals can also be in arbitrary order; the last one finalizes.
  const r2 = await revealSecret(app, created.drawId, 'bob');
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().status, 'committed', 'draw is not finalized until everyone reveals');
  assert.equal(r2.json().revealedCount, 1);
  const r3 = await revealSecret(app, created.drawId, 'carol');
  assert.equal(r3.statusCode, 200);
  assert.equal(r3.json().status, 'committed');
  const r1 = await revealSecret(app, created.drawId, 'alice');
  assert.equal(r1.statusCode, 200, 'last reveal finalizes the draw');

  const final = r1.json();
  assert.equal(final.status, 'revealed');
  assert.equal(final.version, 'v3');
  assert.equal(
    sha256Hex(`v3:${final.seed}:${snapshotDigestForGroups(GROUPS)}`),
    created.commitment
  );

  // nonce = concat of SHA-256(secret) in the declared participant order.
  const expectedNonce = aggregateNonce(NAMES.map((n) => SECRETS[n]));
  assert.equal(final.nonce, expectedNonce);

  // The per-group shuffle is reused for every declared group.
  const expectedAll = computeGroupedResult(final.seed, expectedNonce, GROUPS);
  assert.equal(final.results.length, expectedAll.length);
  final.results.forEach((g, i) => {
    assert.equal(g.name, expectedAll[i].name);
    assert.deepEqual(g.order, expectedAll[i].order);
    assert.deepEqual(g.winners, expectedAll[i].winners);
  });
  assert.deepEqual(final.results.map((g) => g.winners.length), [2, 1]);

  // Auditable contribution list: positions, commitments, secrets and hashes.
  assert.equal(final.contributions.length, 3);
  assert.deepEqual(final.contributions.map((c) => c.position), [0, 1, 2]);
  assert.deepEqual(final.contributions.map((c) => c.name), NAMES);
  for (const c of final.contributions) {
    assert.equal(secretHash(c.secret), c.commitment, 'secret opens commitment');
    assert.equal(c.secretHash, secretHash(c.secret));
  }
});

test('rejects duplicate commitments and duplicate reveals', async () => {
  const { app } = makeApp();
  const created = await createMultiparty(app);
  await commit(app, created.drawId, 'alice');
  assert.equal((await commit(app, created.drawId, 'alice')).statusCode, 409);

  await commit(app, created.drawId, 'bob');
  await commit(app, created.drawId, 'carol');
  await revealSecret(app, created.drawId, 'alice');
  assert.equal((await revealSecret(app, created.drawId, 'alice')).statusCode, 409);
});

test('rejects out-of-order operations', async () => {
  const { app } = makeApp();
  const created = await createMultiparty(app);
  await commit(app, created.drawId, 'alice');

  // Cannot reveal while some participants still owe a commitment.
  const early = await revealSecret(app, created.drawId, 'alice');
  assert.equal(early.statusCode, 409, 'reveal before all commitments rejected');
  assert.deepEqual(early.json().waitingFor.sort(), ['bob', 'carol']);

  await commit(app, created.drawId, 'bob');
  await commit(app, created.drawId, 'carol');

  const wrong = await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/participants/carol/reveal`,
    payload: { secret: 'not-the-committed-secret' },
  });
  assert.equal(wrong.statusCode, 409, 'secret not matching commitment rejected');

  const strangerCommit = await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/participants/mallory/commitment`,
    payload: { commitment: secretHash('x') },
  });
  assert.equal(strangerCommit.statusCode, 400);
  const strangerReveal = await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/participants/mallory/reveal`,
    payload: { secret: 'x' },
  });
  assert.equal(strangerReveal.statusCode, 400);

  const r = await revealSecret(app, created.drawId, 'carol');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, 'committed');
});

test('commitments rejected after the draw is finalized', async () => {
  const { app } = makeApp();
  const created = await createMultiparty(app);
  for (const n of NAMES) await commit(app, created.drawId, n);
  for (const n of NAMES) await revealSecret(app, created.drawId, n);

  const lateCommit = await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/participants/alice/commitment`,
    payload: { commitment: secretHash('whatever') },
  });
  assert.equal(lateCommit.statusCode, 409);

  const lateReveal = await revealSecret(app, created.drawId, 'alice');
  assert.equal(lateReveal.statusCode, 409, 'post-finalization reveals return the final state');
  assert.equal(lateReveal.json().draw.status, 'revealed');
});

test('single-nonce and multi-party endpoints cannot be mixed', async () => {
  const { app } = makeApp();

  const multi = await createMultiparty(app);
  const singleOnMulti = await app.inject({
    method: 'POST',
    url: `/draws/${multi.drawId}/reveal`,
    payload: { nonce: 'nope' },
  });
  assert.equal(singleOnMulti.statusCode, 409);

  const single = (await app.inject({
    method: 'POST',
    url: '/draws',
    payload: { groups: [{ name: 'solo', quota: 1, candidates: ['a'] }] },
  })).json();
  assert.equal(single.mode, 'single');
  const multiOnSingle = await commit(app, single.drawId, 'alice');
  assert.equal(multiOnSingle.statusCode, 409);
});

test('stored verify checks the multi-party contribution chain plus grouped results', async () => {
  const { app } = makeApp();
  const created = await createMultiparty(app);
  for (const n of NAMES) await commit(app, created.drawId, n);
  for (const n of NAMES) await revealSecret(app, created.drawId, n);

  const report = (await app.inject({
    method: 'GET',
    url: `/draws/${created.drawId}/verify`,
  })).json();
  assert.equal(report.mode, 'multiparty');
  assert.equal(report.valid, true);
  assert.equal(report.checks.commitmentsOpen, true);
  assert.equal(report.checks.nonceDerived, true);
  assert.equal(report.checks.positionsComplete, true);
  assert.equal(report.checks.ordersMatch, true);
  assert.equal(report.checks.winnersMatch, true);
});

test('independent verify flags tampered multi-party contributions on a v3 draw', async () => {
  const { app } = makeApp();
  const created = await createMultiparty(app);
  for (const n of NAMES) await commit(app, created.drawId, n);
  await revealSecret(app, created.drawId, 'alice', SECRETS.alice);
  await revealSecret(app, created.drawId, 'bob', SECRETS.bob);
  const last = await revealSecret(app, created.drawId, 'carol', SECRETS.carol);
  const final = last.json();
  assert.equal(final.status, 'revealed');

  const base = {
    version: final.version,
    snapshotDigest: final.snapshotDigest,
    commitment: final.commitment,
    seed: final.seed,
    nonce: final.nonce,
    groups: groupsOnly(),
    results: final.results,
    contributions: final.contributions,
  };

  // Tamper one secret but keep the commitment.
  const tamperedSecret = {
    ...base,
    contributions: base.contributions.map((c) =>
      c.name === 'bob' ? { ...c, secret: 'forged' } : c
    ),
  };
  const rep1 = (await app.inject({ method: 'POST', url: '/verify', payload: tamperedSecret })).json();
  assert.equal(rep1.valid, false);
  assert.equal(rep1.checks.commitmentsOpen, false);

  // Reorder contributions (swap positions) but keep pairs consistent.
  const reordered = {
    ...base,
    contributions: base.contributions.map((c) => {
      if (c.name === 'alice') return { ...c, position: 1 };
      if (c.name === 'bob') return { ...c, position: 0 };
      return c;
    }),
  };
  const rep2 = (await app.inject({ method: 'POST', url: '/verify', payload: reordered })).json();
  assert.equal(rep2.valid, false);
  assert.equal(rep2.checks.nonceDerived, false);

  // Honest record: everything passes, including grouped result recomputation.
  const ok = (await app.inject({ method: 'POST', url: '/verify', payload: base })).json();
  assert.equal(ok.valid, true);
  assert.equal(ok.checks.commitmentsOpen, true);
  assert.equal(ok.checks.nonceDerived, true);
  assert.equal(ok.checks.ordersMatch, true);
  assert.equal(ok.checks.winnersMatch, true);
});

test('participant list validation at creation', async () => {
  const { app } = makeApp();

  const dupes = await app.inject({
    method: 'POST',
    url: '/draws',
    payload: { groups: groupsOnly(), participants: ['a', 'a'] },
  });
  assert.equal(dupes.statusCode, 400, 'duplicate participants rejected');

  const solo = await app.inject({
    method: 'POST',
    url: '/draws',
    payload: { groups: groupsOnly(), participants: ['alone'] },
  });
  assert.equal(solo.statusCode, 400, 'a multi-party draw needs at least 2 participants');

  const badCommitment = await app.inject({
    method: 'POST',
    url: '/draws/x/participants/alice/commitment',
    payload: { commitment: 'not-a-sha256-hex' },
  });
  assert.equal(badCommitment.statusCode, 400);
});
