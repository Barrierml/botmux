import { describe, it, expect } from 'vitest';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { shouldPreMarkFirstTurn } from '../src/codex-rpc-lifecycle.js';
import type { CodexBridgeEvent } from '../src/services/codex-transcript.js';

// Consecutive-turn regressions against the REAL CodexBridgeQueue, locking the
// fresh-first-turn mark discipline (Codex P1): the pre-mark must fire ONLY for a
// confirmed-accepted turn. A stale/duplicate unstarted head wedges drainEmittable
// forever, so not-sent (paste re-marks) and ambiguous (never starts) must NOT
// leave a phantom head.
const T0 = 'first prompt alpha';
const T1 = 'second prompt beta';
const user = (uuid: string, text: string, ts: number): CodexBridgeEvent => ({ uuid, timestampMs: ts, kind: 'user', text });
const asst = (uuid: string, text: string, ts: number): CodexBridgeEvent => ({ uuid, timestampMs: ts, kind: 'assistant_final', text });

describe('shouldPreMarkFirstTurn — accepted-only pre-mark', () => {
  it('only accepted pre-marks the bridge', () => {
    expect(shouldPreMarkFirstTurn('accepted')).toBe(true);
    expect(shouldPreMarkFirstTurn('ambiguous')).toBe(false);
    expect(shouldPreMarkFirstTurn('not-engaged')).toBe(false);
    expect(shouldPreMarkFirstTurn('resumed')).toBe(false);
  });
});

describe('CodexBridgeQueue — fresh first-turn mark discipline (Codex P1 stale-head)', () => {
  it('accepted single pre-mark → the turn emits once, queue empties, next turn still emits', () => {
    const q = new CodexBridgeQueue();
    q.mark('t0', T0, 1000); // accepted → exactly ONE mark (prompt not re-queued)
    q.ingest([user('u0', T0, 1001), asst('a0', 'reply0', 1002)]);
    expect(q.drainEmittable().map(t => t.turnId)).toEqual(['t0']);
    expect(q.size()).toBe(0); // no stale head
    q.mark('t1', T1, 2000);
    q.ingest([user('u1', T1, 2001), asst('a1', 'reply1', 2002)]);
    expect(q.drainEmittable().map(t => t.turnId)).toEqual(['t1']);
    expect(q.size()).toBe(0);
  });

  it('not-sent → paste flush marks EXACTLY ONCE → emits once + next different prompt still emits', () => {
    // The worker does NOT pre-mark on not-sent; only flushPending marks (once).
    const q = new CodexBridgeQueue();
    q.mark('t0', T0, 1000); // the single paste-path mark
    q.ingest([user('u0', T0, 1001), asst('a0', 'reply0', 1002)]);
    expect(q.drainEmittable().map(t => t.turnId)).toEqual(['t0']);
    expect(q.size()).toBe(0);
    q.mark('t1', T1, 2000);
    q.ingest([user('u1', T1, 2001), asst('a1', 'reply1', 2002)]);
    expect(q.drainEmittable().map(t => t.turnId)).toEqual(['t1']);
  });

  it('ambiguous → NO pre-mark → the next explicit prompt starts/emits (not blocked by a phantom head)', () => {
    const q = new CodexBridgeQueue();
    // ambiguous fresh turn leaves the queue untouched.
    expect(q.size()).toBe(0);
    q.mark('t1', T1, 2000);
    q.ingest([user('u1', T1, 2001), asst('a1', 'reply1', 2002)]);
    expect(q.drainEmittable().map(t => t.turnId)).toEqual(['t1']);
    expect(q.size()).toBe(0);
  });

  it('REGRESSION GUARD: a DOUBLE mark of the same turnId (the reverted pre-mark bug) wedges the next turn', () => {
    const q = new CodexBridgeQueue();
    q.mark('t0', T0, 1000); // early pre-mark (old bug)
    q.mark('t0', T0, 1000); // flush re-mark, same turnId
    q.ingest([user('u0', T0, 1001), asst('a0', 'reply0', 1002)]);
    expect(q.drainEmittable().map(t => t.turnId)).toEqual(['t0']);
    expect(q.size()).toBe(1); // the duplicate t0 lingers UNSTARTED at the head
    q.mark('t1', T1, 2000);
    q.ingest([user('u1', T1, 2001), asst('a1', 'reply1', 2002)]);
    // wedged: the stale unstarted head breaks the FIFO drain — this is exactly
    // what accepted-only marking prevents.
    expect(q.drainEmittable()).toEqual([]);
  });
});
