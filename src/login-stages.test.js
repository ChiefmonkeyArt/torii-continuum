/**
 * CONT-LOGIN-1 — the login stage model.
 *
 * The model is pure, so these tests can assert the two properties that keep a
 * login from stalling in the first place: every stage is bounded, and every way
 * a stage can fail names something the operator can DO.
 */
import { describe, it, expect } from 'vitest';
import {
  STAGE_TIMEOUTS_MS,
  STAGE_ORDER,
  LOGIN_DEADLINE_MS,
  SIGNER_SLOW_HINT_MS,
  stageTimeout,
  stageLabel,
  stageMessage,
  describeStageFailure,
  busyStatus,
} from './login-stages.js';

const KINDS = ['timeout', 'offline', 'rejected', 'empty', 'cancelled', 'no_signer', 'no_agent', 'agent_rejected'];
const RECOVERIES = ['retry', 'install-signer', 'check-agent', 'none'];

describe('stage deadlines', () => {
  it('bounds every stage of the flow, not only the signer', () => {
    for (const stage of STAGE_ORDER) {
      expect(stageTimeout(stage)).toBeGreaterThan(0);
    }
  });

  it('keeps the machine-to-machine stages far tighter than the generic client budget', () => {
    // The old behaviour: challenge and verify inherited the 30s chat budget,
    // which is a budget for a model generating tokens — not for an agent
    // answering a click the operator is waiting on.
    expect(STAGE_TIMEOUTS_MS.challenge).toBeLessThan(30_000);
    expect(STAGE_TIMEOUTS_MS.verify).toBeLessThan(30_000);
  });

  it('gives the one human-scale stage by far the largest share', () => {
    expect(STAGE_TIMEOUTS_MS.signer).toBeGreaterThan(STAGE_TIMEOUTS_MS.challenge);
    expect(STAGE_TIMEOUTS_MS.signer).toBeGreaterThan(STAGE_TIMEOUTS_MS.verify);
  });

  it('shortens the signer wait from the old 90s', () => {
    // Beyond a minute the honest conclusion is that the popup never appeared.
    expect(STAGE_TIMEOUTS_MS.signer).toBeLessThan(90_000);
  });

  it('caps the whole attempt above the sum of its stages', () => {
    // The ceiling must not fire before a legitimately slow but healthy attempt
    // finishes, or it would abort logins that were about to succeed.
    const sum = STAGE_ORDER.reduce((n, s) => n + STAGE_TIMEOUTS_MS[s], 0);
    expect(LOGIN_DEADLINE_MS).toBeGreaterThan(sum);
  });

  it('warns that the signer is slow well before giving up on it', () => {
    expect(SIGNER_SLOW_HINT_MS).toBeLessThan(STAGE_TIMEOUTS_MS.signer);
  });

  it('has no deadline for an unknown stage', () => {
    expect(stageTimeout('nope')).toBeNull();
    expect(stageTimeout(null)).toBeNull();
    // Inherited Object properties must not be mistaken for stages.
    expect(stageTimeout('toString')).toBeNull();
  });
});

describe('what the operator is told while a stage runs', () => {
  it('places each stage in the sequence', () => {
    expect(stageLabel('challenge')).toBe('step 1 of 3');
    expect(stageLabel('signer')).toBe('step 2 of 3');
    expect(stageLabel('verify')).toBe('step 3 of 3');
  });

  it('has no position for an unknown stage', () => {
    expect(stageLabel('nope')).toBe('');
  });

  it('says something for every stage', () => {
    for (const stage of STAGE_ORDER) {
      expect(stageMessage(stage).length).toBeGreaterThan(0);
    }
    expect(stageMessage('nope')).toBe('');
  });

  it('escalates the signer copy when the wait runs long', () => {
    const normal = stageMessage('signer');
    const slow = stageMessage('signer', { slow: true });
    expect(slow).not.toBe(normal);
    // The most likely cause of a long wait is a popup the operator never saw.
    expect(slow).toMatch(/popup/i);
  });
});

describe('every failure names a way forward', () => {
  it('maps each kind to a recovery the UI knows how to render', () => {
    for (const stage of STAGE_ORDER) {
      for (const kind of KINDS) {
        const d = describeStageFailure(stage, kind);
        expect(RECOVERIES).toContain(d.recovery);
        expect(d.message.length).toBeGreaterThan(0);
        expect(d.stage).toBe(stage);
        expect(d.kind).toBe(kind);
      }
    }
  });

  it('never leaves an unrecognised failure as a dead end', () => {
    // This is the property that matters most: a failure mode added later, with
    // no case here, still reaches the screen with a button on it.
    const d = describeStageFailure('signer', 'something_nobody_wrote_a_case_for');
    expect(d.retryable).toBe(true);
    expect(d.recovery).toBe('retry');
  });

  it('offers install links, not a retry, when there is no signer', () => {
    const d = describeStageFailure('challenge', 'no_signer');
    expect(d.recovery).toBe('install-signer');
    expect(d.retryable).toBe(false);
  });

  it('points at the agent when a machine stage times out', () => {
    for (const stage of ['challenge', 'verify']) {
      const d = describeStageFailure(stage, 'timeout');
      expect(d.recovery).toBe('check-agent');
      expect(d.retryable).toBe(true);
      expect(d.message).toContain(stage);
    }
  });

  it('points at the signer when the signer times out', () => {
    const d = describeStageFailure('signer', 'timeout');
    expect(d.recovery).toBe('retry');
    expect(d.message).toMatch(/signer/i);
  });

  it('treats a deliberate cancel as an outcome, not an error', () => {
    const d = describeStageFailure('signer', 'cancelled');
    expect(d.error).toBe(false);
    expect(d.recovery).toBe('none');
    expect(d.retryable).toBe(false);
  });

  it('marks every non-cancel outcome as an error', () => {
    for (const kind of KINDS.filter((k) => k !== 'cancelled')) {
      expect(describeStageFailure('signer', kind).error).toBe(true);
    }
  });

  it('carries the underlying reason through when there is one', () => {
    expect(describeStageFailure('verify', 'agent_rejected', { detail: 'bad sig' }).message)
      .toContain('bad sig');
    // ...and reads cleanly when there is not.
    expect(describeStageFailure('verify', 'agent_rejected').message).not.toMatch(/undefined|: \./);
  });

  it('does not send an operator without an agent chasing a retry', () => {
    const d = describeStageFailure('challenge', 'no_agent');
    expect(d.retryable).toBe(false);
    expect(d.message).toMatch(/agent/i);
  });
});

describe('a click on an already-running attempt', () => {
  it('is always answered', () => {
    for (const stage of STAGE_ORDER) {
      expect(busyStatus(stage).message.length).toBeGreaterThan(0);
    }
    expect(busyStatus(null).message.length).toBeGreaterThan(0);
  });

  it('offers a way out only during the stage that waits on a human', () => {
    // The machine stages are bounded in seconds and will resolve themselves;
    // the signer stage is the one that can wait on a popup that never appeared.
    expect(busyStatus('signer').cancellable).toBe(true);
    expect(busyStatus('signer').recovery).toBe('cancel');
    expect(busyStatus('challenge').cancellable).toBe(false);
    expect(busyStatus('verify').cancellable).toBe(false);
  });
});
