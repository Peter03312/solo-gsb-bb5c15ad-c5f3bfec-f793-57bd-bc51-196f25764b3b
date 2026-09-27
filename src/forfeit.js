'use strict';

// Forfeit/replacement replay for revealed v3 grouped draws.
//
// After a draw is revealed, current winners may give up their slot. Every
// forfeit is appended to a per-draw, sequenced event log (seq = 1, 2, 3, …)
// inside a SQLite transaction. The vacated slot is refilled with the first
// candidate in that group's original shuffle order who never won (originally
// or by replacement) and never forfeited; when no such standby remains the
// slot stays vacant. Slots only ever empty through a forfeit, so "never won
// and never forfeited" is exactly the eligible standby set.
//
// replayForfeits() is the single source of truth shared by:
//   - the forfeit endpoint (current winners + next replacement),
//   - the public draw view (current effective winners per group),
//   - stored/independent verification (honest replay + tamper reports).
//
// Verification semantics: events are validated in seq order against the
// honest replay. An invalid event is reported and NOT applied — the replay
// always continues with the transition an honest server would have made, so
// later events are still judged against the canonical state.

// results: [{ name, quota, order, winners }] (original draw outcome)
// events:  [{ seq, group, candidate, replacement }] in ascending seq order
//          (replacement is null when the slot was left vacant)
function replayForfeits(results, events) {
  const states = results.map((r) => ({
    name: r.name,
    quota: r.quota,
    order: r.order.slice(),
    originalWinners: r.winners.slice(),
    slots: r.winners.slice(), // slot i: current holder, null = vacant
    forfeited: [], // candidate names, in event order
    forfeitedSet: new Set(),
    everWon: new Set(r.winners), // original winners + every replacement
  }));
  const byName = new Map(states.map((s) => [s.name, s]));

  const problems = [];
  const eventReports = [];
  let sequenceValid = true;

  events.forEach((event, index) => {
    const replacement = event.replacement === undefined ? null : event.replacement;
    const report = {
      seq: event.seq,
      group: event.group,
      candidate: event.candidate,
      replacement,
      expectedReplacement: null,
      ok: true,
    };

    if (event.seq !== index + 1) {
      sequenceValid = false;
      report.ok = false;
      problems.push(`forfeit sequence mismatch: 第 ${index + 1} 条事件的序号为 ${event.seq}，应为 ${index + 1} — 放弃/递补事件已被篡改`);
    }

    const state = byName.get(event.group);
    if (!state) {
      report.ok = false;
      problems.push(`forfeit mismatch: 事件 #${event.seq} 引用的组 '${event.group}' 不存在 — 放弃/递补事件已被篡改`);
      eventReports.push(report);
      return;
    }

    const slotIndex = state.slots.findIndex((holder) => holder === event.candidate);
    if (slotIndex === -1) {
      // Only a current effective winner may forfeit; anything else (never
      // won, already forfeited, wrong group) is rejected/flagged here.
      report.ok = false;
      problems.push(`forfeit mismatch: 事件 #${event.seq} 中 '${event.candidate}' 不是组 '${event.group}' 的当前有效中奖者 — 非当前中奖者放弃`);
      eventReports.push(report);
      return;
    }

    // Honest transition: vacate the slot, then refill it with the first
    // standby in the group's shuffle order who never won and never forfeited.
    state.forfeited.push(event.candidate);
    state.forfeitedSet.add(event.candidate);
    const expected = state.order.find((c) => !state.everWon.has(c) && !state.forfeitedSet.has(c)) ?? null;
    report.expectedReplacement = expected;

    if (replacement !== expected) {
      report.ok = false;
      if (replacement !== null && state.everWon.has(replacement)) {
        problems.push(`replacement mismatch: 事件 #${event.seq} 的递补者 '${replacement}' 已经是中奖者 — 重复递补`);
      } else if (replacement !== null && state.forfeitedSet.has(replacement)) {
        problems.push(`replacement mismatch: 事件 #${event.seq} 的递补者 '${replacement}' 已经放弃过，不能再次递补 — 放弃/递补事件已被篡改`);
      } else if (expected !== null) {
        problems.push(`replacement mismatch: 事件 #${event.seq} 应递补 '${expected}'（组 '${event.group}' 洗牌顺序中首位未中奖且未放弃者），实际为 ${replacement === null ? '空缺' : `'${replacement}'`} — 跳过更靠前候补`);
      } else {
        problems.push(`replacement mismatch: 事件 #${event.seq} 候补已耗尽，名额应空缺，实际递补 '${replacement}' — 放弃/递补事件已被篡改`);
      }
    }

    state.slots[slotIndex] = expected; // null = 名额空缺
    if (expected !== null) state.everWon.add(expected);
    eventReports.push(report);
  });

  const groups = states.map((s) => ({
    name: s.name,
    quota: s.quota,
    originalWinners: s.originalWinners,
    currentWinners: s.slots.filter((holder) => holder !== null),
    vacancies: s.slots.filter((holder) => holder === null).length,
    forfeited: s.forfeited,
    // The standby who would replace the next forfeit in this group (null
    // when the standby pool is exhausted). Used by the forfeit endpoint.
    nextReplacement: s.order.find((c) => !s.everWon.has(c) && !s.forfeitedSet.has(c)) ?? null,
  }));

  return {
    groups,
    events: eventReports,
    problems,
    sequenceValid,
    valid: problems.length === 0,
  };
}

module.exports = { replayForfeits };
