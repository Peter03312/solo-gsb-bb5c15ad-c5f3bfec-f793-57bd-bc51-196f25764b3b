'use strict';

// Forfeit/replacement coverage for revealed v3 grouped draws: the sequenced
// event log, current-winner-only forfeits, shuffle-order replacements,
// vacancy on exhausted standbys, and the stored/independent verification
// replay that flags non-winner forfeits, skipped standbys and duplicate
// replacements. v1/v2 records must stay on their original code paths.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { buildApp } = require('../src/app');
const { replayForfeits } = require('../src/forfeit');
const {
  commitmentFor,
  commitmentForVersion,
  snapshotDigestFor,
  computeOrder,
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

async function revealDraw(app, drawId, nonce = 'nonce-1') {
  const res = await app.inject({ method: 'POST', url: `/draws/${drawId}/reveal`, payload: { nonce } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

async function forfeit(app, drawId, group, candidate) {
  return app.inject({ method: 'POST', url: `/draws/${drawId}/forfeits`, payload: { group, candidate } });
}

test('forfeit appends a sequenced event and the standby takes the slot; query shows original + current + events', async () => {
  const { app } = makeApp();
  const created = await createDraw(app);
  const revealed = await revealDraw(app, created.drawId);
  const red = revealed.results.find((g) => g.name === 'red');

  // Freshly revealed: current winners equal the original winners, empty log.
  assert.deepEqual(red.currentWinners, red.winners);
  assert.equal(red.vacancies, 0);
  assert.deepEqual(red.forfeited, []);
  assert.deepEqual(revealed.forfeits, []);
  assert.equal(revealed.forfeitCount, 0);

  const res = await forfeit(app, created.drawId, 'red', red.winners[0]);
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.equal(body.forfeit.seq, 1);
  assert.equal(body.forfeit.group, 'red');
  assert.equal(body.forfeit.candidate, red.winners[0]);
  assert.equal(body.forfeit.replacement, red.order[2], 'first non-winner in the shuffle order replaces');
  assert.equal(typeof body.forfeit.forfeitedAt, 'string');
  assert.deepEqual([...body.group.currentWinners].sort(), [red.winners[1], red.order[2]].sort());
  assert.equal(body.group.vacancies, 0);
  assert.equal(body.forfeitCount, 1);

  // The draw query returns the original outcome, the current effective
  // winners and the forfeit/replacement events side by side.
  const shown = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}` })).json();
  const redView = shown.results.find((g) => g.name === 'red');
  assert.deepEqual(redView.winners, red.winners, 'original winners preserved');
  assert.deepEqual(redView.order, red.order, 'original order preserved');
  assert.deepEqual([...redView.currentWinners].sort(), [red.winners[1], red.order[2]].sort());
  assert.deepEqual(redView.forfeited, [red.winners[0]]);
  const blueView = shown.results.find((g) => g.name === 'blue');
  assert.deepEqual(blueView.currentWinners, blueView.winners, 'untouched group keeps its winners');
  assert.equal(shown.forfeitCount, 1);
  assert.equal(shown.forfeits.length, 1);
  assert.deepEqual(
    shown.forfeits.map((e) => [e.seq, e.group, e.candidate, e.replacement]),
    [[1, 'red', red.winners[0], red.order[2]]]
  );
});

test('replacements follow the original shuffle order; exhausted standbys leave the slot vacant', async () => {
  const { app } = makeApp();
  const created = await createDraw(app, [{ name: 'solo', quota: 1, candidates: ['a', 'b', 'c'] }]);
  const revealed = await revealDraw(app, created.drawId);
  const solo = revealed.results[0];
  const [w, s1, s2] = solo.order;

  const f1 = (await forfeit(app, created.drawId, 'solo', w)).json();
  assert.equal(f1.forfeit.seq, 1);
  assert.equal(f1.forfeit.replacement, s1);
  assert.deepEqual(f1.group.currentWinners, [s1]);

  const f2 = (await forfeit(app, created.drawId, 'solo', s1)).json();
  assert.equal(f2.forfeit.seq, 2);
  assert.equal(f2.forfeit.replacement, s2);
  assert.deepEqual(f2.group.currentWinners, [s2]);

  // No standby left: the slot becomes vacant (replacement null).
  const f3 = (await forfeit(app, created.drawId, 'solo', s2)).json();
  assert.equal(f3.forfeit.seq, 3);
  assert.equal(f3.forfeit.replacement, null);
  assert.deepEqual(f3.group.currentWinners, []);
  assert.equal(f3.group.vacancies, 1);

  const shown = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}` })).json();
  assert.deepEqual(shown.results[0].winners, [w], 'original winner preserved');
  assert.deepEqual(shown.results[0].currentWinners, []);
  assert.equal(shown.results[0].vacancies, 1);
  assert.deepEqual(shown.results[0].forfeited, [w, s1, s2]);
  assert.deepEqual(shown.forfeits.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(shown.forfeits.map((e) => e.replacement), [s1, s2, null]);

  // Nothing left to forfeit.
  const again = await forfeit(app, created.drawId, 'solo', w);
  assert.equal(again.statusCode, 409);
});

test('only current effective winners can forfeit', async () => {
  const { app } = makeApp();
  const created = await createDraw(app);
  const revealed = await revealDraw(app, created.drawId);
  const red = revealed.results.find((g) => g.name === 'red');
  const blue = revealed.results.find((g) => g.name === 'blue');

  // A standby who never won.
  const standby = await forfeit(app, created.drawId, 'red', red.order[2]);
  assert.equal(standby.statusCode, 409);
  assert.match(standby.json().message, /not a current winner/);
  assert.deepEqual(standby.json().currentWinners, red.winners);

  // A winner of another group.
  const wrongGroup = await forfeit(app, created.drawId, 'red', blue.winners[0]);
  assert.equal(wrongGroup.statusCode, 409);

  // An unknown candidate.
  const stranger = await forfeit(app, created.drawId, 'red', 'mallory');
  assert.equal(stranger.statusCode, 409);

  // Unknown group.
  const noGroup = await forfeit(app, created.drawId, 'green', red.winners[0]);
  assert.equal(noGroup.statusCode, 400);

  // Honest forfeit, then the same candidate cannot forfeit twice.
  assert.equal((await forfeit(app, created.drawId, 'red', red.winners[0])).statusCode, 201);
  const twice = await forfeit(app, created.drawId, 'red', red.winners[0]);
  assert.equal(twice.statusCode, 409);

  // Unknown draw / pending draw.
  assert.equal((await forfeit(app, 'no-such-draw', 'red', 'alice')).statusCode, 404);
  const pending = await createDraw(app);
  const early = await forfeit(app, pending.drawId, 'red', 'alice');
  assert.equal(early.statusCode, 409);
  assert.match(early.json().message, /only after the reveal/);
});

test('forfeits are rejected for v1/v2 legacy records; their query/verify stay untouched', async () => {
  const { db, app } = makeApp();
  const candidates = ['alice', 'bob', 'carol', 'dave', 'erin'];
  const now = new Date().toISOString();
  for (const [id, version] of [['legacy-v1', null], ['legacy-v2', 'v2']]) {
    const seed = id === 'legacy-v1' ? 'b'.repeat(64) : 'e'.repeat(64);
    const order = computeOrder(seed, 'legacy-nonce', candidates);
    const digest = version === 'v2' ? snapshotDigestFor(candidates, 2) : null;
    const commitment = version === 'v2' ? commitmentForVersion('v2', seed, digest) : commitmentFor(seed);
    db.prepare(
      `INSERT INTO draws (id, mode, status, commitment, seed, nonce, candidates, draw_count,
                          result, created_at, revealed_at, protocol_version, snapshot_digest)
       VALUES (?, 'single', 'revealed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, commitment, seed, 'legacy-nonce', JSON.stringify(candidates), 2,
      JSON.stringify({ order, winners: order.slice(0, 2) }), now, now, version, digest
    );
  }

  for (const id of ['legacy-v1', 'legacy-v2']) {
    const res = await forfeit(app, id, 'red', 'alice');
    assert.equal(res.statusCode, 409, `${id} rejects forfeits`);
    assert.match(res.json().message, /only supported for v3/);

    const shown = (await app.inject({ method: 'GET', url: `/draws/${id}` })).json();
    assert.equal(shown.forfeits, undefined, `${id} view unchanged`);
    assert.equal(shown.forfeitCount, undefined, `${id} view unchanged`);
    assert.ok(Array.isArray(shown.winners));

    const report = (await app.inject({ method: 'GET', url: `/draws/${id}/verify` })).json();
    assert.equal(report.valid, true, `${id} still verifies`);
    assert.equal(report.checks.forfeitsValid, undefined, `${id} has no forfeit checks`);
  }
});

test('stored verify replays the honest forfeit log and recomputes current winners', async () => {
  const { app } = makeApp();
  const created = await createDraw(app);
  const revealed = await revealDraw(app, created.drawId);
  const red = revealed.results.find((g) => g.name === 'red');
  const blue = revealed.results.find((g) => g.name === 'blue');

  await forfeit(app, created.drawId, 'red', red.winners[0]);
  await forfeit(app, created.drawId, 'blue', blue.winners[0]);

  const report = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` })).json();
  assert.equal(report.valid, true, JSON.stringify(report.problems));
  assert.equal(report.checks.forfeitsSequenceValid, true);
  assert.equal(report.checks.forfeitsValid, true);
  const current = Object.fromEntries(report.expected.currentWinners.map((g) => [g.name, g]));
  assert.deepEqual([...current.red.currentWinners].sort(), [red.winners[1], red.order[2]].sort());
  assert.deepEqual(current.red.forfeited, [red.winners[0]]);
  assert.deepEqual(current.blue.currentWinners, [blue.order[1]]);
  assert.equal(current.blue.vacancies, 0);
});

test('stored verify flags a forfeit by a non-current-winner in the event log', async () => {
  const { db, app } = makeApp();
  const created = await createDraw(app);
  const revealed = await revealDraw(app, created.drawId);
  const red = revealed.results.find((g) => g.name === 'red');
  await forfeit(app, created.drawId, 'red', red.winners[0]);

  // Tamper: the logged candidate never held a slot.
  db.prepare('UPDATE forfeit_events SET candidate = ? WHERE draw_id = ? AND seq = 1')
    .run(red.order[2], created.drawId);

  const report = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` })).json();
  assert.equal(report.valid, false);
  assert.equal(report.checks.forfeitsValid, false);
  assert.ok(report.problems.some((p) => p.includes('非当前中奖者放弃')), JSON.stringify(report.problems));
});

test('stored verify flags a replacement that skips an earlier standby', async () => {
  const { db, app } = makeApp();
  const created = await createDraw(app, [{ name: 'solo', quota: 1, candidates: ['a', 'b', 'c'] }]);
  const revealed = await revealDraw(app, created.drawId);
  const [w, s1, s2] = revealed.results[0].order;
  await forfeit(app, created.drawId, 'solo', w);

  // Tamper: the log claims s2 replaced w, skipping the earlier standby s1.
  db.prepare('UPDATE forfeit_events SET replacement = ? WHERE draw_id = ? AND seq = 1')
    .run(s2, created.drawId);

  const report = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` })).json();
  assert.equal(report.valid, false);
  assert.equal(report.checks.forfeitsValid, false);
  const problem = report.problems.find((p) => p.includes('跳过更靠前候补'));
  assert.ok(problem, JSON.stringify(report.problems));
  assert.ok(problem.includes(s1), 'names the skipped standby');
});

test('stored verify flags a duplicate replacement', async () => {
  const { db, app } = makeApp();
  const created = await createDraw(app);
  const revealed = await revealDraw(app, created.drawId);
  const red = revealed.results.find((g) => g.name === 'red');
  await forfeit(app, created.drawId, 'red', red.winners[0]);

  // Tamper: the replacement is someone who already holds a slot.
  db.prepare('UPDATE forfeit_events SET replacement = ? WHERE draw_id = ? AND seq = 1')
    .run(red.winners[1], created.drawId);

  const report = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` })).json();
  assert.equal(report.valid, false);
  assert.equal(report.checks.forfeitsValid, false);
  assert.ok(report.problems.some((p) => p.includes('重复递补')), JSON.stringify(report.problems));
});

test('stored verify flags gaps in the event sequence', async () => {
  const { db, app } = makeApp();
  const created = await createDraw(app);
  const revealed = await revealDraw(app, created.drawId);
  const red = revealed.results.find((g) => g.name === 'red');
  await forfeit(app, created.drawId, 'red', red.winners[0]);

  db.prepare('UPDATE forfeit_events SET seq = 7 WHERE draw_id = ? AND seq = 1').run(created.drawId);

  const report = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` })).json();
  assert.equal(report.valid, false);
  assert.equal(report.checks.forfeitsSequenceValid, false);
  assert.ok(report.problems.some((p) => p.includes('forfeit sequence mismatch')), JSON.stringify(report.problems));
});

test('independent /verify accepts an honest forfeit log and flags a tampered one', async () => {
  const { app } = makeApp();
  const created = await createDraw(app);
  const revealed = await revealDraw(app, created.drawId, 'independent-nonce');
  const red = revealed.results.find((g) => g.name === 'red');
  await forfeit(app, created.drawId, 'red', red.winners[0]);
  const shown = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}` })).json();

  const base = {
    version: 'v3',
    snapshotDigest: shown.snapshotDigest,
    commitment: shown.commitment,
    seed: shown.seed,
    nonce: 'independent-nonce',
    groups: groupsOnly(),
    results: shown.results,
    forfeits: shown.forfeits,
  };
  const honest = (await app.inject({ method: 'POST', url: '/verify', payload: base })).json();
  assert.equal(honest.valid, true, JSON.stringify(honest.problems));
  assert.equal(honest.checks.forfeitsValid, true);
  assert.equal(honest.expected.currentWinners.length, 2);

  const tampered = {
    ...base,
    forfeits: [{ ...base.forfeits[0], candidate: red.order[2] }],
  };
  const flagged = (await app.inject({ method: 'POST', url: '/verify', payload: tampered })).json();
  assert.equal(flagged.valid, false);
  assert.ok(flagged.problems.some((p) => p.includes('非当前中奖者放弃')));
});

test('forfeits work on revealed multi-party v3 draws', async () => {
  const { app } = makeApp();
  const names = ['p1', 'p2'];
  const secrets = { p1: 'p1-secret', p2: 'p2-secret' };
  const created = (await app.inject({
    method: 'POST', url: '/draws', payload: { groups: groupsOnly(), participants: names },
  })).json();
  const { secretHash } = require('../src/lottery');
  for (const name of names) {
    await app.inject({
      method: 'POST', url: `/draws/${created.drawId}/participants/${name}/commitment`,
      payload: { commitment: secretHash(secrets[name]) },
    });
  }
  for (const name of names) {
    await app.inject({
      method: 'POST', url: `/draws/${created.drawId}/participants/${name}/reveal`,
      payload: { secret: secrets[name] },
    });
  }

  const shown = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}` })).json();
  assert.equal(shown.status, 'revealed');
  const red = shown.results.find((g) => g.name === 'red');
  const res = await forfeit(app, created.drawId, 'red', red.winners[0]);
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().forfeit.replacement, red.order[2]);

  const report = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` })).json();
  assert.equal(report.valid, true, JSON.stringify(report.problems));
  assert.equal(report.checks.forfeitsValid, true);
});

test('replayForfeits derives current winners and next standby from the event log', () => {
  const results = [
    { name: 'g', quota: 2, order: ['w1', 'w2', 's1', 's2'], winners: ['w1', 'w2'] },
  ];
  const replay = replayForfeits(results, [
    { seq: 1, group: 'g', candidate: 'w1', replacement: 's1' },
    { seq: 2, group: 'g', candidate: 's1', replacement: 's2' },
    { seq: 3, group: 'g', candidate: 'w2', replacement: null },
  ]);
  assert.equal(replay.valid, true);
  assert.deepEqual(replay.groups[0].currentWinners, ['s2']);
  assert.equal(replay.groups[0].vacancies, 1);
  assert.deepEqual(replay.groups[0].forfeited, ['w1', 's1', 'w2']);
  assert.equal(replay.groups[0].nextReplacement, null);

  // A forfeited candidate can never come back as a replacement.
  const reinstate = replayForfeits(results, [
    { seq: 1, group: 'g', candidate: 'w1', replacement: 's1' },
    { seq: 2, group: 'g', candidate: 'w2', replacement: 'w1' },
  ]);
  assert.equal(reinstate.valid, false);
  assert.ok(reinstate.problems.some((p) => p.includes('重复递补') || p.includes('已经放弃过')));
});
