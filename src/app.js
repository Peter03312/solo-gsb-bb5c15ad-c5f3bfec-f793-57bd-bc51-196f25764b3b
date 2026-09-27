'use strict';

const crypto = require('node:crypto');
const {
  generateSeed,
  commitmentForVersion,
  snapshotDigestFor,
  snapshotDigestForGroups,
  secretHash,
  aggregateNonce,
  computeOrder,
  computeGroupedResult,
  PROTOCOL_V1,
  PROTOCOL_V2,
  PROTOCOL_V3,
  LATEST_PROTOCOL_VERSION,
} = require('./lottery');
const { replayForfeits } = require('./forfeit');

const MAX_CANDIDATES = 10000;
const MAX_CANDIDATE_LENGTH = 128;
const MAX_NONCE_LENGTH = 256;
const MAX_PARTICIPANTS = 100;
const MAX_PARTICIPANT_NAME_LENGTH = 128;
const MAX_SECRET_LENGTH = 1024;
const MAX_GROUPS = 100;
const MAX_GROUP_NAME_LENGTH = 128;

const candidateListSchema = {
  type: 'array',
  minItems: 1,
  maxItems: MAX_CANDIDATES,
  uniqueItems: true,
  items: { type: 'string', minLength: 1, maxLength: MAX_CANDIDATE_LENGTH },
};

const participantListSchema = {
  type: 'array',
  minItems: 2,
  maxItems: MAX_PARTICIPANTS,
  uniqueItems: true,
  items: { type: 'string', minLength: 1, maxLength: MAX_PARTICIPANT_NAME_LENGTH },
};

const secretSchema = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_SECRET_LENGTH,
};

// Ordered quota groups, as supplied at creation:
//   groups: [{ name: <unique>, candidates: <non-empty, globally unique>, quota: <0..n> }]
const groupSchema = {
  type: 'array',
  minItems: 1,
  maxItems: MAX_GROUPS,
  items: {
    type: 'object',
    required: ['name', 'candidates', 'quota'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: MAX_GROUP_NAME_LENGTH },
      candidates: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_CANDIDATES,
        items: { type: 'string', minLength: 1, maxLength: MAX_CANDIDATE_LENGTH },
      },
      quota: { type: 'integer', minimum: 0 },
    },
  },
};

// Structural checks that JSON Schema cannot express (cross-field/global):
// unique group names, quota within each group's size, candidates globally
// unique and non-empty, and at least one quota in total. Returns an error
// message, or null when the groups are valid.
function validateGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    return 'groups must be a non-empty array';
  }
  const groupNames = new Set();
  const globalCandidates = new Set();
  let totalQuota = 0;
  let totalCandidates = 0;

  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    const label = `groups[${i}]`;
    // Tolerate non-object entries (they reach here via the lenient verify
    // schema) and report them instead of throwing.
    if (group === null || typeof group !== 'object' || Array.isArray(group)) {
      return `${label} must be an object with name/candidates/quota`;
    }
    if (typeof group.name !== 'string' || group.name.length === 0) {
      return `${label}.name must be a non-empty string`;
    }
    if (groupNames.has(group.name)) {
      return `duplicate group name '${group.name}': 组名必须唯一`;
    }
    groupNames.add(group.name);

    if (!Array.isArray(group.candidates) || group.candidates.length === 0) {
      return `${label} ('${group.name}') candidates must be a non-empty array: 候选列表不能为空`;
    }
    if (!Number.isInteger(group.quota) || group.quota < 0) {
      return `${label} ('${group.name}') quota must be a non-negative integer`;
    }
    if (group.quota > group.candidates.length) {
      return `${label} ('${group.name}') quota ${group.quota} 不能超过该组候选人数 ${group.candidates.length}`;
    }

    const inside = new Set();
    for (const candidate of group.candidates) {
      if (typeof candidate !== 'string' || candidate.length === 0) {
        return `${label} ('${group.name}') candidates must all be non-empty strings`;
      }
      if (inside.has(candidate)) {
        return `${label} ('${group.name}') has duplicate candidate '${candidate}'`;
      }
      inside.add(candidate);
      if (globalCandidates.has(candidate)) {
        return `candidate '${candidate}' appears in more than one group: 候选必须全局不重复`;
      }
      globalCandidates.add(candidate);
    }
    totalQuota += group.quota;
    totalCandidates += group.candidates.length;
  }

  if (totalCandidates > MAX_CANDIDATES) {
    return `total candidate count must not exceed ${MAX_CANDIDATES}`;
  }
  if (totalQuota < 1) {
    return 'total quota must be at least 1: 总名额至少为 1';
  }
  return null;
}

// Raised by verification when the request body is missing fields the selected
// protocol requires; mapped to HTTP 400 by the route.
class VerifyBadRequest extends Error {}

function badRequest(reply, message) {
  return reply.code(400).send({
    statusCode: 400,
    error: 'Bad Request',
    message,
  });
}

function notFound(reply, id) {
  return reply.code(404).send({
    statusCode: 404,
    error: 'Not Found',
    message: `draw ${id} not found`,
  });
}

function conflict(reply, message, extra = {}) {
  return reply.code(409).send({
    statusCode: 409,
    error: 'Conflict',
    message,
    ...extra,
  });
}

// Participant rows -> ordered audit list. Secrets stay hidden until the draw
// is fully revealed; afterwards the whole trail is public.
function participantViews(rows, { revealSecrets = false } = {}) {
  return rows
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((p) => {
      const view = {
        name: p.name,
        position: p.position,
        status: p.commitment === null ? 'pending'
          : p.secret === null ? 'committed'
          : 'revealed',
        commitment: p.commitment,
        committedAt: p.committed_at,
      };
      if (revealSecrets && p.secret !== null) {
        view.secret = p.secret;
        view.secretHash = secretHash(p.secret);
        view.revealedAt = p.revealed_at;
      }
      return view;
    });
}

// Multi-party entropy-trail fields shared by status and reveal responses.
// Before the reveal secrets stay hidden; afterwards they are public.
function multipartyViews(row, participantRows) {
  const revealed = row.status === 'revealed';
  const list = participantViews(participantRows, { revealSecrets: revealed });
  return {
    participants: list,
    participantCount: list.length,
    committedCount: list.filter((p) => p.status !== 'pending').length,
    revealedCount: list.filter((p) => p.status === 'revealed').length,
    ...(revealed ? {
      // Fixed participant order + per-party secret hashes: anyone can rebuild
      // the nonce as concat(sha256(secret_i)) and independently re-run verify.
      contributions: list.map((p) => ({
        name: p.name,
        position: p.position,
        commitment: p.commitment,
        secret: p.secret,
        secretHash: p.secretHash,
        committedAt: p.committedAt,
        revealedAt: p.revealedAt,
      })),
    } : {}),
  };
}

// v3 public view of one declared group. Before the reveal only the setup is
// shown (name, quota, candidates); afterwards the shuffled order and winners
// join in, aligned with the stored result by group position.
function groupViews(groups, resultGroup) {
  const view = {
    name: groups.name,
    quota: groups.quota,
    candidates: groups.candidates,
    candidateCount: groups.candidates.length,
  };
  if (resultGroup) {
    view.order = resultGroup.order;
    view.winners = resultGroup.winners;
  }
  return view;
}

// forfeit_events row -> public event view. `replacement` is null when the
// vacated slot was left empty (standby pool exhausted).
function forfeitEventView(row) {
  return {
    seq: row.seq,
    group: row.group_name,
    candidate: row.candidate,
    replacement: row.replacement,
    forfeitedAt: row.created_at,
  };
}

function publicView(row, participantRows, forfeitRows = []) {
  const version = row.protocol_version || PROTOCOL_V1;

  // v3: grouped quota draw.
  if (version === PROTOCOL_V3) {
    const groups = JSON.parse(row.groups);
    const view = {
      drawId: row.id,
      mode: row.mode,
      status: row.status,
      version,
      commitment: row.commitment,
      snapshotDigest: row.snapshot_digest,
      groups: groups.map((g) => ({
        name: g.name,
        quota: g.quota,
        candidates: g.candidates,
        candidateCount: g.candidates.length,
      })),
      groupCount: groups.length,
      totalQuota: groups.reduce((sum, g) => sum + g.quota, 0),
      candidateCount: groups.reduce((sum, g) => sum + g.candidates.length, 0),
      createdAt: row.created_at,
    };

    if (row.mode === 'multiparty') {
      Object.assign(view, multipartyViews(row, participantRows));
    }

    if (row.status === 'revealed') {
      const result = JSON.parse(row.result);
      // Replay the forfeit log over the original outcome to derive the
      // current effective winners per group (originals stay in `winners`).
      const replay = replayForfeits(result.results, forfeitRows.map(forfeitEventView));
      view.seed = row.seed;
      view.nonce = row.nonce;
      view.results = groups.map((g, i) => {
        const groupView = groupViews(g, result.results[i]);
        groupView.currentWinners = replay.groups[i].currentWinners;
        groupView.vacancies = replay.groups[i].vacancies;
        groupView.forfeited = replay.groups[i].forfeited;
        return groupView;
      });
      view.forfeits = forfeitRows.map(forfeitEventView);
      view.forfeitCount = forfeitRows.length;
      view.revealedAt = row.revealed_at;
    }
    return view;
  }

  // v1/v2: flat candidates/count draw (legacy records stay exactly as before).
  const view = {
    drawId: row.id,
    mode: row.mode,
    status: row.status,
    version,
    commitment: row.commitment,
    snapshotDigest: row.snapshot_digest,
    candidates: JSON.parse(row.candidates),
    count: row.draw_count,
    createdAt: row.created_at,
  };

  if (row.mode === 'multiparty') {
    Object.assign(view, multipartyViews(row, participantRows));
  }

  if (row.status === 'revealed') {
    const result = JSON.parse(row.result);
    view.seed = row.seed;
    view.nonce = row.nonce;
    view.order = result.order;
    view.winners = result.winners;
    view.revealedAt = row.revealed_at;
  }
  return view;
}

function buildApp(db, opts = {}) {
  const app = require('fastify')({ logger: opts.logger !== undefined ? opts.logger : true });

  const insertDraw = db.prepare(
    `INSERT INTO draws (id, mode, status, commitment, seed, candidates, draw_count, created_at,
                        protocol_version, snapshot_digest, groups)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertParticipant = db.prepare(
    `INSERT INTO participants (draw_id, position, name) VALUES (?, ?, ?)`
  );
  const getDraw = db.prepare('SELECT * FROM draws WHERE id = ?');
  const getParticipants = db.prepare('SELECT * FROM participants WHERE draw_id = ?');
  const getParticipant = db.prepare(
    'SELECT * FROM participants WHERE draw_id = ? AND name = ?'
  );
  const markCommitted = db.prepare(
    `UPDATE draws SET status = 'committed' WHERE id = ? AND status = 'pending'`
  );
  const putCommitment = db.prepare(
    `UPDATE participants
        SET commitment = ?, committed_at = ?
      WHERE draw_id = ? AND name = ? AND commitment IS NULL`
  );
  const putSecret = db.prepare(
    `UPDATE participants
        SET secret = ?, revealed_at = ?
      WHERE draw_id = ? AND name = ? AND commitment IS NOT NULL AND secret IS NULL`
  );
  const finalizeSingle = db.prepare(
    `UPDATE draws
        SET status = 'revealed', nonce = ?, result = ?, revealed_at = ?
      WHERE id = ? AND mode = 'single' AND status = 'pending'`
  );
  const finalizeMultiparty = db.prepare(
    `UPDATE draws
        SET status = 'revealed', nonce = ?, result = ?, revealed_at = ?
      WHERE id = ? AND mode = 'multiparty' AND status = 'committed'`
  );
  const insertForfeit = db.prepare(
    `INSERT INTO forfeit_events (draw_id, seq, group_name, candidate, replacement, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const listForfeits = db.prepare(
    'SELECT * FROM forfeit_events WHERE draw_id = ? ORDER BY seq ASC'
  );
  // Forfeit events only exist for v3 draws; other versions short-circuit to
  // an empty log so legacy views/verification stay exactly as before.
  const forfeitRowsFor = (row) => (
    (row.protocol_version || PROTOCOL_V1) === PROTOCOL_V3 ? listForfeits.all(row.id) : []
  );

  app.get('/', async () => ({
    name: 'verifiable-draw',
    description: 'Commit-reveal public draw: v3 grouped-quota snapshot commitments, SHA-256 rejection-sampling Fisher-Yates per group, sequenced forfeit/replacement log for revealed v3 draws; v1/v2 records remain verifiable',
    endpoints: {
      create: 'POST /draws',
      reveal: 'POST /draws/:id/reveal',
      forfeit: 'POST /draws/:id/forfeits',
      status: 'GET /draws/:id',
      verifyStored: 'GET /draws/:id/verify',
      verifyIndependent: 'POST /verify',
      multipartyCommit: 'POST /draws/:id/participants/:name/commitment',
      multipartyReveal: 'POST /draws/:id/participants/:name/reveal',
    },
  }));

  app.get('/health', async () => ({ status: 'ok' }));

  // ---- Create draw ------------------------------------------------------
  // v3: an ordered `groups` list ([{name, candidates, quota}]) replaces the
  // flat candidates/count. Without `participants`: single-nonce flow
  // (mode=single). With `participants`: multi-party commit-reveal entropy
  // aggregation (mode=multiparty); the participant order is fixed at creation.
  app.post('/draws', {
    schema: {
      body: {
        type: 'object',
        required: ['groups'],
        additionalProperties: false,
        properties: {
          groups: groupSchema,
          participants: participantListSchema,
        },
      },
    },
  }, async (request, reply) => {
    const { groups, participants } = request.body;

    // Cross-field/global validation (unique names, quota within group size,
    // globally unique non-empty candidates, total quota >= 1).
    const groupError = validateGroups(groups);
    if (groupError) {
      return badRequest(reply, groupError);
    }

    const id = crypto.randomUUID();
    const seed = generateSeed();
    // v3: the commitment binds the exact grouped snapshot, so the published
    // commitment is SHA-256("v3:<seed>:<snapshotDigest>").
    const snapshotDigest = snapshotDigestForGroups(groups);
    const commitment = commitmentForVersion(LATEST_PROTOCOL_VERSION, seed, snapshotDigest);
    const createdAt = new Date().toISOString();
    const mode = Array.isArray(participants) ? 'multiparty' : 'single';
    const totalQuota = groups.reduce((sum, g) => sum + g.quota, 0);
    const totalCandidates = groups.reduce((sum, g) => sum + g.candidates.length, 0);

    // Legacy columns are NOT NULL; v3 rows leave them empty/zero and carry
    // the authoritative setup in `groups`.
    db.exec('BEGIN IMMEDIATE');
    try {
      insertDraw.run(
        id, mode, commitment, seed, JSON.stringify([]), 0, createdAt,
        LATEST_PROTOCOL_VERSION, snapshotDigest, JSON.stringify(groups)
      );
      if (mode === 'multiparty') {
        participants.forEach((name, position) => insertParticipant.run(id, position, name));
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw err;
    }

    // Only the commitment and the snapshot digest are returned; the seed
    // stays hidden until reveal.
    const response = {
      drawId: id,
      mode,
      status: 'pending',
      version: LATEST_PROTOCOL_VERSION,
      commitment,
      snapshotDigest,
      groups: groups.map((g) => ({
        name: g.name,
        quota: g.quota,
        candidates: g.candidates,
        candidateCount: g.candidates.length,
      })),
      groupCount: groups.length,
      totalQuota,
      candidateCount: totalCandidates,
      createdAt,
    };
    if (mode === 'multiparty') {
      response.participants = participants.map((name, position) => ({
        name,
        position,
        status: 'pending',
      }));
    }
    return reply.code(201).send(response);
  });

  // ---- Single-party reveal (single-shot, transactional) -----------------
  app.post('/draws/:id/reveal', {
    schema: {
      body: {
        type: 'object',
        required: ['nonce'],
        additionalProperties: false,
        properties: {
          nonce: { type: 'string', minLength: 1, maxLength: MAX_NONCE_LENGTH },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { nonce } = request.body;

    // BEGIN IMMEDIATE takes the write lock up front; row locking, seed reveal
    // and result persistence all happen in this one transaction.
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = getDraw.get(id);
      if (!row) {
        db.exec('ROLLBACK');
        return notFound(reply, id);
      }
      if (row.mode !== 'single') {
        db.exec('ROLLBACK');
        return conflict(
          reply,
          'this is a multi-party draw; use /participants/:name/commitment and /participants/:name/reveal'
        );
      }
      if (row.status === 'revealed') {
        db.exec('ROLLBACK');
        return conflict(reply, 'draw already revealed; a nonce can only be submitted once', {
          draw: publicView(row, [], forfeitRowsFor(row)),
        });
      }

      const version = row.protocol_version || PROTOCOL_V1;
      let resultPayload;
      if (version === PROTOCOL_V3) {
        const groups = JSON.parse(row.groups);
        resultPayload = { results: computeGroupedResult(row.seed, nonce, groups) };
      } else {
        const candidates = JSON.parse(row.candidates);
        const order = computeOrder(row.seed, nonce, candidates);
        resultPayload = { order, winners: order.slice(0, row.draw_count) };
      }
      const revealedAt = new Date().toISOString();
      const changed = finalizeSingle.run(
        nonce,
        JSON.stringify(resultPayload),
        revealedAt,
        id
      );
      if (Number(changed.changes) !== 1) {
        db.exec('ROLLBACK');
        return conflict(reply, 'draw already revealed; a nonce can only be submitted once');
      }
      db.exec('COMMIT');

      return reply.send(publicView(getDraw.get(id), []));
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw err;
    }
  });

  // ---- Multi-party: submit a commitment --------------------------------
  // Only accepted while the draw is still in the commitment phase and the
  // named participant has not committed yet. The draw flips pending ->
  // committed when the first commitment lands.
  app.post('/draws/:id/participants/:name/commitment', {
    schema: {
      body: {
        type: 'object',
        required: ['commitment'],
        additionalProperties: false,
        properties: {
          commitment: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        },
      },
    },
  }, async (request, reply) => {
    const { id, name } = request.params;
    const { commitment } = request.body;

    db.exec('BEGIN IMMEDIATE');
    try {
      const row = getDraw.get(id);
      if (!row) {
        db.exec('ROLLBACK');
        return notFound(reply, id);
      }
      if (row.mode !== 'multiparty') {
        db.exec('ROLLBACK');
        return conflict(reply, 'this is a single-nonce draw; use POST /draws/:id/reveal');
      }
      if (row.status === 'revealed') {
        db.exec('ROLLBACK');
        return conflict(reply, 'draw already revealed; the commitment phase is over');
      }
      const participant = getParticipant.get(id, name);
      if (!participant) {
        db.exec('ROLLBACK');
        return badRequest(reply, `participant '${name}' is not declared on this draw`);
      }
      if (participant.commitment !== null) {
        db.exec('ROLLBACK');
        return conflict(reply, `participant '${name}' has already committed`, {
          participant: participantViews([participant])[0],
        });
      }

      const committedAt = new Date().toISOString();
      markCommitted.run(id);
      putCommitment.run(commitment, committedAt, id, name);
      db.exec('COMMIT');

      const rows = getParticipants.all(id);
      const views = participantViews(rows);
      return reply.code(201).send({
        drawId: id,
        phase: 'committed',
        status: 'committed',
        participant: views.find((p) => p.name === name),
        participants: views,
        committedCount: views.filter((p) => p.status !== 'pending').length,
        participantCount: views.length,
      });
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw err;
    }
  });

  // ---- Multi-party: reveal a secret ------------------------------------
  // Accepted only after the participant's commitment exists, the draw is in
  // the reveal phase (>=1 commitment), the secret matches the commitment, and
  // this participant has not revealed yet. The last valid reveal aggregates
  // every secret hash in fixed participant order into the nonce, then runs
  // the (version-dependent) shuffle and finalizes the draw — all in one tx.
  app.post('/draws/:id/participants/:name/reveal', {
    schema: {
      body: {
        type: 'object',
        required: ['secret'],
        additionalProperties: false,
        properties: {
          secret: secretSchema,
        },
      },
    },
  }, async (request, reply) => {
    const { id, name } = request.params;
    const { secret } = request.body;

    db.exec('BEGIN IMMEDIATE');
    try {
      const row = getDraw.get(id);
      if (!row) {
        db.exec('ROLLBACK');
        return notFound(reply, id);
      }
      if (row.mode !== 'multiparty') {
        db.exec('ROLLBACK');
        return conflict(reply, 'this is a single-nonce draw; use POST /draws/:id/reveal');
      }
      if (row.status === 'revealed') {
        db.exec('ROLLBACK');
        return conflict(reply, 'draw already revealed', {
          draw: publicView(row, getParticipants.all(id), forfeitRowsFor(row)),
        });
      }
      const participant = getParticipant.get(id, name);
      if (!participant) {
        db.exec('ROLLBACK');
        return badRequest(reply, `participant '${name}' is not declared on this draw`);
      }
      if (participant.commitment === null) {
        db.exec('ROLLBACK');
        return conflict(reply, `participant '${name}' has not committed yet; commit first`);
      }
      if (participant.secret !== null) {
        db.exec('ROLLBACK');
        return conflict(reply, `participant '${name}' has already revealed`);
      }
      if (secretHash(secret) !== participant.commitment) {
        db.exec('ROLLBACK');
        return conflict(reply, `secret does not match '${name}'s commitment`, {
          participant: participantViews([participant])[0],
        });
      }

      const rows = getParticipants.all(id);
      const pending = rows.filter((p) => p.commitment === null);
      if (pending.length > 0) {
        db.exec('ROLLBACK');
        return conflict(
          reply,
          `reveal phase is not open: ${pending.length} participant(s) have not committed yet`,
          { waitingFor: pending.map((p) => p.name) }
        );
      }

      const revealedAt = new Date().toISOString();
      putSecret.run(secret, revealedAt, id, name);

      // Re-read inside the same transaction: this snapshot includes the
      // secret we just stored.
      const freshOrdered = getParticipants.all(id)
        .slice()
        .sort((a, b) => a.position - b.position);
      const unrevealed = freshOrdered.filter((p) => p.secret === null);

      if (unrevealed.length > 0) {
        db.exec('COMMIT');
        const views = participantViews(getParticipants.all(id));
        return reply.send({
          drawId: id,
          status: 'committed',
          phase: 'reveal',
          participant: views.find((p) => p.name === name),
          participants: views,
          committedCount: views.length,
          revealedCount: views.filter((p) => p.status === 'revealed').length,
          participantCount: views.length,
        });
      }

      // Last reveal: aggregate and finalize inside the same lock.
      const nonce = aggregateNonce(freshOrdered.map((p) => p.secret));
      const version = row.protocol_version || PROTOCOL_V1;
      let resultPayload;
      if (version === PROTOCOL_V3) {
        const groups = JSON.parse(row.groups);
        resultPayload = { results: computeGroupedResult(row.seed, nonce, groups) };
      } else {
        const candidates = JSON.parse(row.candidates);
        const order = computeOrder(row.seed, nonce, candidates);
        resultPayload = { order, winners: order.slice(0, row.draw_count) };
      }
      const changed = finalizeMultiparty.run(
        nonce,
        JSON.stringify(resultPayload),
        revealedAt,
        id
      );
      if (Number(changed.changes) !== 1) {
        db.exec('ROLLBACK');
        return conflict(reply, 'draw already revealed');
      }
      db.exec('COMMIT');

      const finalRow = getDraw.get(id);
      return reply.send(publicView(finalRow, getParticipants.all(id)));
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw err;
    }
  });

  // ---- Forfeit a winning slot (v3, revealed draws only) -------------------
  // A current effective winner gives up their slot. The event is appended to
  // the draw's sequenced forfeit log inside one BEGIN IMMEDIATE transaction,
  // and the vacated slot is refilled with the first standby in that group's
  // original shuffle order who never won and never forfeited — or left
  // vacant (replacement = null) when the standby pool is exhausted.
  app.post('/draws/:id/forfeits', {
    schema: {
      body: {
        type: 'object',
        required: ['group', 'candidate'],
        additionalProperties: false,
        properties: {
          group: { type: 'string', minLength: 1, maxLength: MAX_GROUP_NAME_LENGTH },
          candidate: { type: 'string', minLength: 1, maxLength: MAX_CANDIDATE_LENGTH },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { group: groupName, candidate } = request.body;

    // BEGIN IMMEDIATE takes the write lock up front; the current-winner
    // check, the replacement pick and the sequenced append all happen in
    // this one transaction, so concurrent forfeits cannot interleave.
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = getDraw.get(id);
      if (!row) {
        db.exec('ROLLBACK');
        return notFound(reply, id);
      }
      const version = row.protocol_version || PROTOCOL_V1;
      if (version !== PROTOCOL_V3) {
        db.exec('ROLLBACK');
        return conflict(reply, `forfeits are only supported for v3 grouped draws; this draw is ${version}`);
      }
      if (row.status !== 'revealed') {
        db.exec('ROLLBACK');
        return conflict(reply, `draw is ${row.status}; forfeits are accepted only after the reveal`);
      }

      const result = JSON.parse(row.result);
      const events = listForfeits.all(id).map(forfeitEventView);
      const replay = replayForfeits(result.results, events);
      const groupState = replay.groups.find((g) => g.name === groupName);
      if (!groupState) {
        db.exec('ROLLBACK');
        return badRequest(reply, `group '${groupName}' does not exist in this draw`);
      }
      if (!groupState.currentWinners.includes(candidate)) {
        db.exec('ROLLBACK');
        return conflict(
          reply,
          `'${candidate}' is not a current winner of group '${groupName}': 只有当前有效中奖者可以放弃`,
          { currentWinners: groupState.currentWinners }
        );
      }

      const replacement = groupState.nextReplacement;
      const seq = events.length === 0 ? 1 : events[events.length - 1].seq + 1;
      const forfeitedAt = new Date().toISOString();
      insertForfeit.run(id, seq, groupName, candidate, replacement, forfeitedAt);
      db.exec('COMMIT');

      const currentWinners = groupState.currentWinners.filter((c) => c !== candidate);
      if (replacement !== null) currentWinners.push(replacement);
      return reply.code(201).send({
        drawId: id,
        forfeit: { seq, group: groupName, candidate, replacement, forfeitedAt },
        group: {
          name: groupName,
          quota: groupState.quota,
          currentWinners,
          vacancies: groupState.vacancies + (replacement === null ? 1 : 0),
        },
        forfeitCount: seq,
      });
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw err;
    }
  });

  // ---- Draw status --------------------------------------------------------
  app.get('/draws/:id', async (request, reply) => {
    const row = getDraw.get(request.params.id);
    if (!row) {
      return notFound(reply, request.params.id);
    }
    const participants = row.mode === 'multiparty' ? getParticipants.all(row.id) : [];
    return publicView(row, participants, forfeitRowsFor(row));
  });

  // ---- Verify a stored draw (self-consistency recompute) -----------------
  app.get('/draws/:id/verify', async (request, reply) => {
    const row = getDraw.get(request.params.id);
    if (!row) {
      return notFound(reply, request.params.id);
    }
    if (row.status !== 'revealed') {
      return conflict(reply, `draw is ${row.status}; nothing to verify yet`);
    }
    const stored = JSON.parse(row.result);
    const participantRows = row.mode === 'multiparty' ? getParticipants.all(row.id) : [];
    const version = row.protocol_version || PROTOCOL_V1;

    let input;
    if (version === PROTOCOL_V3) {
      input = {
        version,
        snapshotDigest: row.snapshot_digest === null ? undefined : row.snapshot_digest,
        commitment: row.commitment,
        seed: row.seed,
        nonce: row.nonce,
        groups: JSON.parse(row.groups),
        results: stored.results,
        // Sequenced forfeit/replacement log, replayed in order during verify.
        forfeits: listForfeits.all(row.id).map(forfeitEventView),
      };
    } else {
      input = {
        version,
        snapshotDigest: row.snapshot_digest === null ? undefined : row.snapshot_digest,
        commitment: row.commitment,
        seed: row.seed,
        nonce: row.nonce,
        candidates: JSON.parse(row.candidates),
        count: row.draw_count,
        order: stored.order,
        winners: stored.winners,
      };
    }
    if (row.mode === 'multiparty') {
      input.contributions = participantRows
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((p) => ({
          name: p.name,
          position: p.position,
          commitment: p.commitment,
          secret: p.secret,
        }));
    }
    let report;
    try {
      report = verifyRecord(input);
    } catch (err) {
      if (err instanceof VerifyBadRequest) {
        return badRequest(reply, err.message);
      }
      throw err;
    }
    return { drawId: row.id, mode: row.mode, ...report };
  });

  // ---- Independent verification ------------------------------------------
  // Recompute everything from the commitment, nonce and snapshot; any
  // supplied field that disagrees with the recomputation is tampered.
  //   v3: `groups` ([{name, candidates, quota}]) + optional `results`;
  //   v2: `candidates`/`count` (snapshot digest recomputed);
  //   absent/other version: legacy v1 algorithm.
  // For multi-party draws, `contributions` (in participant order) lets the
  // caller prove the nonce was really derived from the revealed secrets.
  app.post('/verify', {
    schema: {
      body: {
        type: 'object',
        required: ['commitment', 'seed', 'nonce'],
        additionalProperties: false,
        properties: {
          version: { type: 'string', enum: [PROTOCOL_V1, PROTOCOL_V2, PROTOCOL_V3] },
          snapshotDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          commitment: { type: 'string', minLength: 1 },
          seed: { type: 'string', minLength: 1 },
          nonce: { type: 'string', minLength: 1, maxLength: MAX_PARTICIPANTS * 64 },
          // v1/v2 flat snapshot:
          candidates: { ...candidateListSchema, minItems: 0 },
          count: { type: 'integer', minimum: 0 },
          order: { type: 'array', items: { type: 'string' } },
          winners: { type: 'array', items: { type: 'string' } },
          // v3 grouped snapshot (structural/global rules are checked in
          // verifyRecord so tampered groups are reported, not rejected):
          groups: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                candidates: { type: 'array', items: { type: 'string' } },
                quota: { type: 'integer', minimum: 0 },
              },
            },
          },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                quota: { type: 'integer', minimum: 0 },
                order: { type: 'array', items: { type: 'string' } },
                winners: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          // v3 forfeit/replacement log (optional): replayed in seq order
          // against the recomputed original results.
          forfeits: {
            type: 'array',
            items: {
              type: 'object',
              required: ['seq', 'group', 'candidate'],
              additionalProperties: false,
              properties: {
                seq: { type: 'integer', minimum: 1 },
                group: { type: 'string', minLength: 1, maxLength: MAX_GROUP_NAME_LENGTH },
                candidate: { type: 'string', minLength: 1, maxLength: MAX_CANDIDATE_LENGTH },
                replacement: { type: ['string', 'null'], minLength: 1, maxLength: MAX_CANDIDATE_LENGTH },
              },
            },
          },
          contributions: {
            type: 'array',
            minItems: 2,
            maxItems: MAX_PARTICIPANTS,
            items: {
              type: 'object',
              required: ['commitment', 'secret'],
              additionalProperties: false,
              properties: {
                name: { type: 'string', maxLength: MAX_PARTICIPANT_NAME_LENGTH },
                position: { type: 'integer', minimum: 0 },
                commitment: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                secret: secretSchema,
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    try {
      return verifyRecord(request.body);
    } catch (err) {
      if (err instanceof VerifyBadRequest) {
        return badRequest(reply, err.message);
      }
      throw err;
    }
  });

  return app;
}

// Common multi-party audit: every revealed secret must open its commitment,
// positions must be unique and 0-based, and concatenating the secret hashes
// in fixed order must reproduce the nonce. Returns the derived nonce (which
// always equals the supplied nonce when nonceDerived holds).
function checkContributions(contributions, nonce, checks, problems) {
  const sorted = contributions
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  checks.positionsComplete = sorted.every(
    (c, i) => Number.isInteger(c.position) && c.position === i
  );
  if (!checks.positionsComplete) {
    problems.push('contributions mismatch: position 必须是从 0 开始的连续序号 — 贡献列表已被篡改');
  }

  checks.commitmentsOpen = sorted.every((c) => secretHash(c.secret) === c.commitment);
  if (!checks.commitmentsOpen) {
    problems.push('contributions mismatch: SHA-256(secret) != commitment — 某条 secret 或 commitment 已被篡改');
  }

  const derivedNonce = aggregateNonce(sorted.map((c) => c.secret));
  checks.nonceDerived = derivedNonce === nonce;
  if (!checks.nonceDerived) {
    problems.push('nonce mismatch: 按参与者顺序拼接的 secret 哈希与 nonce 不一致 — nonce 或贡献列表已被篡改');
  }
  return derivedNonce;
}

// ---- v3 verification ----------------------------------------------------
// Recompute the grouped snapshot digest, commitment, contribution chain and
// per-group results. Tampering is reported per dimension (group names,
// membership, quotas, winners/orders) so the failure reason is actionable.
// When a forfeit log is supplied it is replayed in seq order against the
// recomputed original results: a forfeit by anyone who is not a current
// effective winner, a replacement that skips an earlier eligible standby,
// and a duplicate replacement are each reported as inconsistencies.
function verifyRecordV3(input) {
  const {
    commitment, seed, nonce, groups, snapshotDigest, contributions, results, forfeits,
  } = input;
  const problems = [];
  const checks = {};

  // 1. Structural validity of the supplied groups themselves.
  const structuralError = validateGroups(groups);
  checks.groupsValid = structuralError === null;
  if (!checks.groupsValid) {
    problems.push(`groups invalid: ${structuralError} — 分组结构（组名/候选/名额）已被篡改`);
  }

  // 2. Snapshot digest and the snapshot-bound commitment. Only recompute the
  //    digest from structurally valid groups (otherwise the snapshot builder
  //    would throw on the tampered payload).
  let expectedSnapshotDigest;
  if (checks.groupsValid) {
    expectedSnapshotDigest = snapshotDigestForGroups(groups);
    if (snapshotDigest !== undefined) {
      checks.snapshotDigestMatch = snapshotDigest === expectedSnapshotDigest;
      if (!checks.snapshotDigestMatch) {
        problems.push('snapshot digest mismatch: 分组快照摘要与 groups 重算结果不一致 — 组名、组顺序、归属候选或 quota 已被篡改');
      }
    }
  }
  checks.commitmentMatch = checks.groupsValid
    && commitmentForVersion(PROTOCOL_V3, seed, expectedSnapshotDigest) === commitment;
  if (!checks.commitmentMatch) {
    problems.push('commitment mismatch: SHA-256(v3:seed:分组快照摘要) != commitment — seed、commitment 或分组快照（组名/归属/名额）已被篡改');
  }

  // 3. Multi-party contribution chain.
  let effectiveNonce = nonce;
  if (Array.isArray(contributions)) {
    effectiveNonce = checkContributions(contributions, nonce, checks, problems);
  }

  // 4. Recompute every group's order/winners from (seed, nonce, groups).
  let expectedResults = [];
  if (checks.groupsValid) {
    expectedResults = computeGroupedResult(seed, effectiveNonce, groups);
  }

  // 5. Cross-check a supplied result set: group set/order, membership, quota
  //    and the shuffle outcome — naming the offending group on failure.
  //    Without a structurally valid snapshot these comparisons have no
  //    trustworthy baseline; the groupsValid problem already fails the report.
  if (results !== undefined) {
    const resultChecks = {
      resultsCountMatch: false,
      groupNamesMatch: false,
      membershipMatch: false,
      quotasMatch: false,
      ordersMatch: false,
      winnersMatch: false,
    };

    if (!checks.groupsValid) {
      Object.assign(checks, resultChecks);
    } else {
      const countOk = Array.isArray(results) && results.length === groups.length;
      resultChecks.resultsCountMatch = countOk;
      if (!countOk) {
        problems.push(`results mismatch: 结果组数 ${Array.isArray(results) ? results.length : '(非数组)'} 与声明组数 ${groups.length} 不一致 — 结果或分组已被篡改`);
      }

      if (countOk) {
        let namesOk = true;
        let membershipOk = true;
        let quotasOk = true;
        let ordersOk = true;
        let winnersOk = true;

        for (let i = 0; i < groups.length; i += 1) {
          const supplied = results[i];
          const group = groups[i];
          const expected = expectedResults[i];

          if (!supplied || typeof supplied !== 'object') {
            namesOk = membershipOk = quotasOk = ordersOk = winnersOk = false;
            problems.push(`results[${i}] mismatch: 缺少该组结果 — 结果已被篡改`);
            continue;
          }

          // Name / position in the ordered group list.
          if (supplied.name !== group.name) {
            namesOk = false;
            problems.push(`group name mismatch: 第 ${i} 组结果名为 '${supplied.name}'，快照中为 '${group.name}' — 组名或归属已被篡改`);
          }

          // Quota carried by the result must match the snapshot quota.
          if (supplied.quota !== group.quota) {
            quotasOk = false;
            problems.push(`quota mismatch: 组 '${group.name}' 结果 quota=${supplied.quota}，快照 quota=${group.quota} — 名额已被篡改`);
          }

          if (Array.isArray(supplied.order)) {
            // Membership: order must be a permutation of that group's candidates.
            const sameLength = supplied.order.length === group.candidates.length;
            const sameMembers = sameLength
              && new Set(supplied.order).size === supplied.order.length
              && supplied.order.every((c) => group.candidates.includes(c));
            if (!sameMembers) {
              membershipOk = false;
              problems.push(`membership mismatch: 组 '${group.name}' 的 order 不是该组候选的排列 — 归属候选已被篡改`);
            }
            // The shuffled order must equal the deterministic recomputation.
            const orderOk = sameMembers && supplied.order.every((c, j) => c === expected.order[j]);
            if (!orderOk) {
              ordersOk = false;
              problems.push(`order mismatch: 组 '${group.name}' 的中奖顺序与重算结果不一致 — order/中奖结果已被篡改`);
            }
          } else {
            membershipOk = ordersOk = false;
            problems.push(`order mismatch: 组 '${group.name}' 缺少 order 数组 — 结果已被篡改`);
          }

          if (Array.isArray(supplied.winners)) {
            const winnersOkHere = supplied.winners.length === group.quota
              && supplied.winners.every((c, j) => c === expected.winners[j]);
            if (!winnersOkHere) {
              winnersOk = false;
              problems.push(`winners mismatch: 组 '${group.name}' 的中奖者（前 ${group.quota} 名）与重算结果不一致 — winners/名额结果已被篡改`);
            }
          } else {
            winnersOk = false;
            problems.push(`winners mismatch: 组 '${group.name}' 缺少 winners 数组 — 结果已被篡改`);
          }
        }

        resultChecks.groupNamesMatch = namesOk;
        resultChecks.membershipMatch = membershipOk;
        resultChecks.quotasMatch = quotasOk;
        resultChecks.ordersMatch = ordersOk;
        resultChecks.winnersMatch = winnersOk;
      }

      Object.assign(checks, resultChecks);
    }
  }

  // 6. Forfeit/replacement log: replay the events in seq order over the
  //    recomputed original results (the honest baseline). Every event must
  //    be a current-winner forfeit whose replacement is the first standby in
  //    the group's shuffle order who never won and never forfeited.
  let expectedCurrentWinners;
  if (forfeits !== undefined) {
    if (!checks.groupsValid) {
      // No trustworthy baseline; the groupsValid problem already fails the
      // report, so the forfeit checks are simply marked failed as well.
      checks.forfeitsSequenceValid = false;
      checks.forfeitsValid = false;
    } else {
      const replay = replayForfeits(expectedResults, forfeits);
      checks.forfeitsSequenceValid = replay.sequenceValid;
      checks.forfeitsValid = replay.valid;
      problems.push(...replay.problems);
      expectedCurrentWinners = replay.groups.map((g) => ({
        name: g.name,
        currentWinners: g.currentWinners,
        vacancies: g.vacancies,
        forfeited: g.forfeited,
      }));
    }
  }

  return {
    valid: problems.length === 0,
    version: PROTOCOL_V3,
    ...(expectedSnapshotDigest !== undefined ? { snapshotDigest: expectedSnapshotDigest } : {}),
    checks,
    expected: {
      results: expectedResults,
      ...(expectedCurrentWinners !== undefined ? { currentWinners: expectedCurrentWinners } : {}),
    },
    problems,
  };
}

// ---- v1/v2 verification (legacy flat candidates/count records) ----------
function verifyRecordLegacy({
  commitment, seed, nonce, candidates, count, order, winners, contributions, version, snapshotDigest,
}) {
  const problems = [];
  const checks = {};
  // Records without a version marker verify with the legacy v1 algorithm.
  const protocol = version === PROTOCOL_V2 ? PROTOCOL_V2 : PROTOCOL_V1;

  // 1. Commitment must match the revealed seed under the record's protocol
  //    version. v2 also binds the candidate snapshot: the digest is recomputed
  //    from the supplied candidates/count, so any change to candidate order,
  //    content or count breaks the commitment check.
  let expectedSnapshotDigest;
  if (protocol === PROTOCOL_V2) {
    expectedSnapshotDigest = snapshotDigestFor(candidates, count);
    if (snapshotDigest !== undefined) {
      checks.snapshotDigestMatch = snapshotDigest === expectedSnapshotDigest;
      if (!checks.snapshotDigestMatch) {
        problems.push('snapshot digest mismatch: 候选快照摘要与 candidates/count 重算结果不一致 — 候选顺序、内容或 count 已被篡改');
      }
    }
  }
  checks.commitmentMatch = commitmentForVersion(protocol, seed, expectedSnapshotDigest) === commitment;
  if (!checks.commitmentMatch) {
    problems.push(protocol === PROTOCOL_V2
      ? 'commitment mismatch: SHA-256(v2:seed:快照摘要) != commitment — seed、commitment 或候选快照已被篡改'
      : 'commitment mismatch: SHA-256(seed) != commitment — seed 或 commitment 已被篡改');
  }

  // 2. Candidate snapshot sanity: unique, and count within range.
  const seen = new Set(candidates);
  checks.candidatesUnique = seen.size === candidates.length;
  if (!checks.candidatesUnique) {
    problems.push('candidates mismatch: 候选快照存在重复项 — candidates 已被篡改');
  }
  checks.countInRange = Number.isInteger(count) && count >= 1 && count <= candidates.length;
  if (!checks.countInRange) {
    problems.push('count mismatch: 抽取数量超出候选范围 — count 已被篡改');
  }

  // 3. Multi-party audit trail.
  let effectiveNonce = nonce;
  if (Array.isArray(contributions)) {
    effectiveNonce = checkContributions(contributions, nonce, checks, problems);
  }

  // 4. Recompute the winning order from (seed, nonce, candidates).
  const expectedOrder = computeOrder(seed, effectiveNonce, candidates);
  const expectedWinners = expectedOrder.slice(0, Math.min(count, expectedOrder.length));

  if (order !== undefined) {
    checks.orderMatch = Array.isArray(order) && order.length === expectedOrder.length
      && order.every((v, i) => v === expectedOrder[i]);
    if (!checks.orderMatch) {
      problems.push('order mismatch: 提供的中奖顺序与重算结果不一致 — order 或输入参数已被篡改');
    }
  }
  if (winners !== undefined) {
    checks.winnersMatch = Array.isArray(winners) && winners.length === expectedWinners.length
      && winners.every((v, i) => v === expectedWinners[i]);
    if (!checks.winnersMatch) {
      problems.push('winners mismatch: 提供的中奖名单与重算结果不一致 — winners 或输入参数已被篡改');
    }
  }

  return {
    valid: problems.length === 0,
    version: protocol,
    ...(expectedSnapshotDigest !== undefined ? { snapshotDigest: expectedSnapshotDigest } : {}),
    checks,
    expected: { order: expectedOrder, winners: expectedWinners },
    problems,
  };
}

// Dispatch by protocol version; also enforces that the snapshot fields the
// selected protocol needs are actually present (400 for a malformed request,
// versus valid=false with `problems` for a well-formed but tampered record).
function verifyRecord(input) {
  if (input.version === PROTOCOL_V3) {
    if (!Array.isArray(input.groups)) {
      throw new VerifyBadRequest('v3 verification requires a non-empty groups array');
    }
    return verifyRecordV3(input);
  }
  if (!Array.isArray(input.candidates) || !Number.isInteger(input.count)) {
    throw new VerifyBadRequest('v1/v2 verification requires candidates (array) and count (integer)');
  }
  return verifyRecordLegacy(input);
}

module.exports = { buildApp, validateGroups };
