'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { buildApp, validateGroups } = require('../src/app');
const {
  sha256Hex,
  commitmentForVersion,
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
];
const groupsOnly = () => GROUPS.map((g) => ({ name: g.name, quota: g.quota, candidates: [...g.candidates] }));

async function createDraw(app, groups = groupsOnly()) {
  const res = await app.inject({ method: 'POST', url: '/draws', payload: { groups } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

test('create returns only the commitment, never the seed', async () => {
  const { app } = makeApp();
  const body = await createDraw(app);
  assert.match(body.commitment, /^[0-9a-f]{64}$/);
  assert.equal(body.seed, undefined);
  assert.equal(body.status, 'pending');

  const shown = await app.inject({ method: 'GET', url: `/draws/${body.drawId}` });
  assert.equal(shown.json().seed, undefined, 'seed must stay hidden while pending');
});

test('reveal is single-shot and reproducible', async () => {
  const { app } = makeApp();
  const created = await createDraw(app);

  const reveal = await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/reveal`,
    payload: { nonce: 'nonce-1' },
  });
  assert.equal(reveal.statusCode, 200);
  const r = reveal.json();
  assert.equal(
    commitmentForVersion(r.version, r.seed, r.snapshotDigest),
    created.commitment
  );
  const expected = computeGroupedResult(r.seed, 'nonce-1', GROUPS);
  assert.equal(r.results.length, expected.length);
  r.results.forEach((g, i) => {
    assert.equal(g.name, expected[i].name);
    assert.equal(g.quota, expected[i].quota);
    assert.deepEqual(g.order, expected[i].order);
    assert.deepEqual(g.winners, expected[i].winners);
    assert.deepEqual(g.candidates, GROUPS[i].candidates, 'group membership is echoed');
  });
  assert.deepEqual(r.results.map((g) => g.winners.length), [2, 1]);

  const again = await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/reveal`,
    payload: { nonce: 'nonce-2' },
  });
  assert.equal(again.statusCode, 409, 'second nonce submission must be rejected');
});

test('independent verify accepts honest v3 records and flags a forged seed/nonce/result', async () => {
  const { app } = makeApp();
  const created = await createDraw(app);
  const revealed = (await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/reveal`,
    payload: { nonce: 'nonce-1' },
  })).json();

  const record = {
    version: 'v3',
    snapshotDigest: revealed.snapshotDigest,
    commitment: revealed.commitment,
    seed: revealed.seed,
    nonce: 'nonce-1',
    groups: groupsOnly(),
    results: revealed.results,
  };
  assert.equal((await app.inject({ method: 'POST', url: '/verify', payload: record })).json().valid, true);

  const badSeed = await app.inject({
    method: 'POST', url: '/verify', payload: { ...record, seed: '0'.repeat(64) },
  });
  assert.equal(badSeed.json().valid, false);
  assert.ok(badSeed.json().problems.some((p) => p.includes('commitment')));

  // A forged nonce does not move the commitment (it only feeds the shuffle),
  // so supplying it alongside the honest results exposes an order mismatch.
  const badNonce = await app.inject({
    method: 'POST', url: '/verify', payload: { ...record, nonce: 'forged' },
  });
  const badNonceBody = badNonce.json();
  assert.equal(badNonceBody.valid, false);
  assert.equal(badNonceBody.checks.ordersMatch, false);
  assert.ok(badNonceBody.problems.some((p) => p.includes('order mismatch')));

  const badOrder = {
    ...record,
    results: record.results.map((g) => (g.name === 'red' ? { ...g, order: [...g.order].reverse(), winners: [...g.order].reverse().slice(0, g.quota) } : g)),
  };
  assert.equal((await app.inject({ method: 'POST', url: '/verify', payload: badOrder })).json().valid, false);
});

test('stored verify endpoint recomputes grouped results from the snapshot', async () => {
  const { app } = makeApp();
  const created = await createDraw(app);

  const early = await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` });
  assert.equal(early.statusCode, 409, 'cannot verify a pending draw');

  await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/reveal`,
    payload: { nonce: 'abc' },
  });
  const verified = await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` });
  assert.equal(verified.json().valid, true);
});

test('input validation', async () => {
  const { app } = makeApp();

  // duplicate group name
  assert.equal((await app.inject({
    method: 'POST', url: '/draws',
    payload: { groups: [{ name: 'a', candidates: ['x'], quota: 1 }, { name: 'a', candidates: ['y'], quota: 1 }] },
  })).statusCode, 400);

  // quota larger than the group
  assert.equal((await app.inject({
    method: 'POST', url: '/draws',
    payload: { groups: [{ name: 'a', candidates: ['x', 'y'], quota: 3 }] },
  })).statusCode, 400);

  // globally duplicate candidate
  assert.equal((await app.inject({
    method: 'POST', url: '/draws',
    payload: { groups: [{ name: 'a', candidates: ['x'], quota: 1 }, { name: 'b', candidates: ['x'], quota: 1 }] },
  })).statusCode, 400);

  // total quota zero
  assert.equal((await app.inject({
    method: 'POST', url: '/draws',
    payload: { groups: [{ name: 'a', candidates: ['x'], quota: 0 }] },
  })).statusCode, 400);

  const emptyNonce = await app.inject({
    method: 'POST',
    url: '/draws/whatever/reveal',
    payload: { nonce: '' },
  });
  assert.equal(emptyNonce.statusCode, 400);

  const missing = await app.inject({ method: 'GET', url: '/draws/nope' });
  assert.equal(missing.statusCode, 404);
});

test('validateGroups covers every creation invariant', () => {
  assert.equal(validateGroups([{ name: 'a', candidates: ['x'], quota: 0 }, { name: 'b', candidates: ['y'], quota: 1 }]), null);
  assert.equal(validateGroups([{ name: 'a', candidates: ['x'], quota: 1 }]), null);
  assert.ok(validateGroups([]));
  assert.ok(validateGroups([{ name: 'a', candidates: [], quota: 0 }]));
  assert.ok(validateGroups([{ name: 'a', candidates: ['x'], quota: -1 }]));
  assert.ok(validateGroups([{ name: 'a', candidates: ['x', 'x'], quota: 1 }]));
  assert.ok(validateGroups([{ name: 'a', candidates: ['x'] }, { name: 'a', candidates: ['y'], quota: 1 }]));
  assert.ok(validateGroups([{ name: 'a', candidates: ['x'], quota: 1 }, { name: 'b', candidates: ['x'], quota: 1 }]));
  assert.ok(validateGroups([{ name: 'a', candidates: ['x'], quota: 0 }]));
});

test('per-group shuffle is unbiased (rejection sampling sanity)', () => {
  const { computeGroupOrder } = require('../src/lottery');
  const trials = 120000;
  const first = new Map();
  for (let k = 0; k < trials; k += 1) {
    const order = computeGroupOrder('f'.repeat(64), `n-${k}`, 0, ['x', 'y', 'z']);
    first.set(order[0], (first.get(order[0]) || 0) + 1);
  }
  for (const name of ['x', 'y', 'z']) {
    const p = first.get(name) / trials;
    assert.ok(Math.abs(p - 1 / 3) < 0.01, `${name} first-place probability ${p} within 1% of 1/3`);
  }
});

test('commitment formula for a revealed draw matches sha256(v3:seed:digest)', async () => {
  const { app } = makeApp();
  const created = await createDraw(app);
  const r = (await app.inject({
    method: 'POST', url: `/draws/${created.drawId}/reveal`, payload: { nonce: 'n' },
  })).json();
  assert.equal(r.commitment, sha256Hex(`v3:${r.seed}:${created.snapshotDigest}`));
});
