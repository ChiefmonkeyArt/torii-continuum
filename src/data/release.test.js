/**
 * Pure tests for the UI version-state helpers (VERSION-UPDATE-1). No DOM, no
 * network — these mirror the jsdom-free convention and cover the version states
 * the task calls out: current / newer / unavailable, plus stale and the
 * server-vetted update-target contract.
 */
import { describe, it, expect } from 'vitest';
import { displayVersion, describeVersionState, updateTargetTag } from './release.js';

describe('displayVersion', () => {
  it('adds a single leading v to a bare version', () => {
    expect(displayVersion('0.2.69-alpha')).toBe('v0.2.69-alpha');
  });

  it('does not double the v when one is already present', () => {
    expect(displayVersion('v0.2.69-alpha')).toBe('v0.2.69-alpha');
  });

  it('trims surrounding whitespace', () => {
    expect(displayVersion('  0.2.69-alpha  ')).toBe('v0.2.69-alpha');
  });

  it('returns null for non-strings and empty input', () => {
    expect(displayVersion(null)).toBe(null);
    expect(displayVersion(undefined)).toBe(null);
    expect(displayVersion('')).toBe(null);
    expect(displayVersion('   ')).toBe(null);
    expect(displayVersion(123)).toBe(null);
  });
});

describe('describeVersionState', () => {
  it('reports "current" (Up to date) when no update is available', () => {
    const s = describeVersionState({
      ok: true, current: '0.2.69-alpha', latest: '0.2.69-alpha',
      update_available: false, source: 'live', stale: false,
    });
    expect(s.state).toBe('current');
    expect(s.label).toBe('Up to date');
    expect(s.current).toBe('v0.2.69-alpha');
    expect(s.latest).toBe('v0.2.69-alpha');
  });

  it('reports "newer" with the latest tag when an update is available', () => {
    const s = describeVersionState({
      ok: true, current: '0.2.69-alpha', latest: '0.2.70-alpha',
      update_available: true, source: 'live', stale: false,
    });
    expect(s.state).toBe('newer');
    expect(s.label).toBe('Update available · v0.2.70-alpha');
    expect(s.latest).toBe('v0.2.70-alpha');
  });

  it('reports "unknown" when the summary is null', () => {
    const s = describeVersionState(null);
    expect(s.state).toBe('unknown');
    expect(s.label).toBe('Latest version unavailable');
    expect(s.latest).toBe(null);
  });

  it('reports "unknown" when ok is false', () => {
    expect(describeVersionState({ ok: false, current: '0.2.69-alpha' }).state).toBe('unknown');
  });

  it('reports "unknown" when the release check was unreachable', () => {
    const s = describeVersionState({
      ok: true, current: '0.2.69-alpha', latest: null,
      source: 'unreachable', stale: true,
    });
    expect(s.state).toBe('unknown');
  });

  it('reports "unknown" when no latest is known even if ok', () => {
    const s = describeVersionState({ ok: true, current: '0.2.69-alpha', latest: null, source: 'live' });
    expect(s.state).toBe('unknown');
  });

  it('preserves the current version even in the unknown state', () => {
    const s = describeVersionState({ ok: false, current: '0.2.69-alpha' });
    expect(s.current).toBe('v0.2.69-alpha');
  });

  it('carries the stale flag through', () => {
    const fresh = describeVersionState({
      ok: true, current: '0.2.69-alpha', latest: '0.2.69-alpha',
      update_available: false, source: 'live', stale: false,
    });
    const stale = describeVersionState({
      ok: true, current: '0.2.69-alpha', latest: '0.2.70-alpha',
      update_available: true, source: 'cache', stale: true,
    });
    expect(fresh.stale).toBe(false);
    expect(stale.stale).toBe(true);
  });
});

describe('updateTargetTag (server-vetted install target)', () => {
  it('returns the v-prefixed latest tag when an update is available', () => {
    expect(updateTargetTag({ update_available: true, latest: '0.2.70-alpha' })).toBe('v0.2.70-alpha');
  });

  it('returns null when no update is available', () => {
    expect(updateTargetTag({ update_available: false, latest: '0.2.70-alpha' })).toBe(null);
  });

  it('returns null for a null summary', () => {
    expect(updateTargetTag(null)).toBe(null);
  });

  it('never invents a tag from a missing latest', () => {
    expect(updateTargetTag({ update_available: true, latest: null })).toBe(null);
  });
});
