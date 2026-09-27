'use strict';

const crypto = require('node:crypto');

const UINT32_SPACE = 0x100000000; // 2^32

// Commitment protocol versions. Records created before v2 carry no version
// marker and are always verified with the legacy v1 formula. v3 replaces the
// flat candidates/count snapshot with ordered quota groups.
const PROTOCOL_V1 = 'v1';
const PROTOCOL_V2 = 'v2';
const PROTOCOL_V3 = 'v3';
const LATEST_PROTOCOL_VERSION = PROTOCOL_V3;

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

// seed: 32 random bytes, hex-encoded (64 chars). Only its SHA-256 commitment
// is published until reveal time.
function generateSeed() {
  return crypto.randomBytes(32).toString('hex');
}

// Legacy v1 commitment = SHA-256(seed), where seed is the UTF-8 hex string.
function commitmentFor(seed) {
  return sha256Hex(seed);
}

// Canonical candidate snapshot serialization (v2), in the original order:
//   "<count as decimal>\n" followed by "<utf8 byte length>:<original bytes>"
//   for every candidate, concatenated with no extra separators. The length
//   prefix makes the concatenation unambiguous (it survives multibyte UTF-8),
//   so the resulting digest binds candidate order, content and count.
function snapshotDigestFor(candidates, count) {
  let snapshot = `${count}\n`;
  for (const candidate of candidates) {
    snapshot += `${Buffer.byteLength(candidate, 'utf8')}:${candidate}`;
  }
  return sha256Hex(snapshot);
}

// Versioned draw commitment:
//   v1: SHA-256(seed)
//   v2: SHA-256("v2:<seed>:<snapshotDigest>")
//   v3: SHA-256("v3:<seed>:<snapshotDigest>")  (snapshot is the groups one)
// Anything that is not v2/v3 verifies with the legacy v1 formula.
function commitmentForVersion(version, seed, snapshotDigest) {
  if (version === PROTOCOL_V2 || version === PROTOCOL_V3) {
    return sha256Hex(`${version}:${seed}:${snapshotDigest}`);
  }
  return commitmentFor(seed);
}

// v3 grouped-quota snapshot. Layout (every number is decimal, names and
// candidate strings are length-prefixed with their UTF-8 byte count):
//
//   "v3\n<groupCount>\n"
//
// followed, in declared group order, by per group:
//
//   "<nameByteLen>:<name><quota>\n<candidateCount>\n"
//   "<candByteLen>:<candidate>" for every candidate (no separators)
//
// Groups run straight into each other with no newline between them; the
// candidate count and the length prefixes keep everything unambiguous.
// Example (one group '红组', quota 1, candidates alice/bob):
//   "v3\n1\n6:红组1\n2\n5:alice3:bob"
function buildV3Snapshot(groups) {
  let snapshot = `v3\n${groups.length}\n`;
  for (const group of groups) {
    snapshot += `${Buffer.byteLength(group.name, 'utf8')}:${group.name}${group.quota}\n${group.candidates.length}\n`;
    for (const candidate of group.candidates) {
      snapshot += `${Buffer.byteLength(candidate, 'utf8')}:${candidate}`;
    }
  }
  return snapshot;
}

function snapshotDigestForGroups(groups) {
  return sha256Hex(buildV3Snapshot(groups));
}

// A participant commits to SHA-256(secret) before revealing the secret.
function secretHash(secret) {
  return sha256Hex(secret);
}

// Multi-party entropy aggregation: concatenate every participant's secret
// hash in the fixed participant order declared at draw creation. Each digest
// is a fixed-width 64 hex chars, so the concatenation is unambiguous and the
// resulting string is the nonce fed into the existing shuffle.
function aggregateNonce(secretsInParticipantOrder) {
  return secretsInParticipantOrder.map(sha256Hex).join('');
}

// Deterministic uint32 stream (v1/v2):
//   block(i) = SHA-256(`${seed}:${nonce}:${i}`), i = 0, 1, 2, ...
// each 32-byte block yields 8 big-endian uint32 values, consumed in order.
function createUint32Stream(seed, nonce) {
  let counter = 0;
  let block = Buffer.alloc(0);
  let offset = 0;
  return function nextUint32() {
    if (offset + 4 > block.length) {
      block = crypto.createHash('sha256').update(`${seed}:${nonce}:${counter}`, 'utf8').digest();
      counter += 1;
      offset = 0;
    }
    const value = block.readUInt32BE(offset);
    offset += 4;
    return value;
  };
}

// v3 per-group deterministic stream. Every group gets its own independent
// block sequence (block index restarts at 0), with the group index as an
// extra scope in the hashed input:
//   block(i) = SHA-256(`${seed}:${nonce}:${groupIndex}:${i}`)
function createGroupUint32Stream(seed, nonce, groupIndex) {
  let counter = 0;
  let block = Buffer.alloc(0);
  let offset = 0;
  return function nextUint32() {
    if (offset + 4 > block.length) {
      block = crypto
        .createHash('sha256')
        .update(`${seed}:${nonce}:${groupIndex}:${counter}`, 'utf8')
        .digest();
      counter += 1;
      offset = 0;
    }
    const value = block.readUInt32BE(offset);
    offset += 4;
    return value;
  };
}

// Unbiased uniform integer in [0, n) via rejection sampling:
// reject x >= floor(2^32 / n) * n so every residue class has equal probability.
function makeUniform(nextUint32) {
  return function uniform(n) {
    const limit = Math.floor(UINT32_SPACE / n) * n;
    for (;;) {
      const x = nextUint32();
      if (x < limit) return x % n;
    }
  };
}

// Fisher-Yates shuffle driven by the deterministic stream. The result is the
// full winning order; the first `count` entries are the winners.
function computeOrder(seed, nonce, candidates) {
  const uniform = makeUniform(createUint32Stream(seed, nonce));
  const result = candidates.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = uniform(i + 1);
    const tmp = result[i];
    result[i] = result[j];
    result[j] = tmp;
  }
  return result;
}

// v3: shuffle one group with its own group-scoped random stream.
function computeGroupOrder(seed, nonce, groupIndex, candidates) {
  const uniform = makeUniform(createGroupUint32Stream(seed, nonce, groupIndex));
  const result = candidates.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = uniform(i + 1);
    const tmp = result[i];
    result[i] = result[j];
    result[j] = tmp;
  }
  return result;
}

// v3: every group is shuffled independently; the first `quota` entries of
// each group's order are that group's winners (quota 0 yields no winners).
function computeGroupedResult(seed, nonce, groups) {
  return groups.map((group, groupIndex) => {
    const order = computeGroupOrder(seed, nonce, groupIndex, group.candidates);
    return {
      name: group.name,
      quota: group.quota,
      order,
      winners: order.slice(0, group.quota),
    };
  });
}

module.exports = {
  sha256Hex,
  generateSeed,
  commitmentFor,
  commitmentForVersion,
  snapshotDigestFor,
  buildV3Snapshot,
  snapshotDigestForGroups,
  secretHash,
  aggregateNonce,
  computeOrder,
  computeGroupOrder,
  computeGroupedResult,
  PROTOCOL_V1,
  PROTOCOL_V2,
  PROTOCOL_V3,
  LATEST_PROTOCOL_VERSION,
};
