import { describe, it, expect } from 'vitest';
import { buildRosterEvent, ROSTER_KIND } from './roster.js';
import { toNpub } from './npub.js';
import * as agent from '../data/agent.js';

const hex = (c) => c.repeat(64);
const OWNER = hex('a');

describe('buildRosterEvent', () => {
  it('builds an unsigned kind-30098 event with roles and agent-of', () => {
    const ev = buildRosterEvent('alpha', [
      { npub: toNpub(hex('b')), role: 'maintainer' },
      { npub: hex('c'), role: 'agent', of: toNpub(hex('b')) },
    ], { ownerHex: OWNER, createdAt: 10 });
    expect(ev).toEqual({ kind: ROSTER_KIND, created_at: 10, content: '',
      tags: [['d', 'alpha'], ['p', hex('b'), 'maintainer'], ['p', hex('c'), 'agent', hex('b')]] });
    expect(ev).not.toHaveProperty('pubkey');
  });
  it('rejects owner listed, duplicates, unknown roles, dangling agents, bad npubs', () => {
    const o = { ownerHex: OWNER };
    expect(() => buildRosterEvent('a', [{ npub: OWNER, role: 'viewer' }], o)).toThrow(/implicit/);
    expect(() => buildRosterEvent('a', [{ npub: hex('b'), role: 'viewer' }, { npub: hex('b'), role: 'viewer' }], o)).toThrow(/duplicate/);
    expect(() => buildRosterEvent('a', [{ npub: hex('b'), role: 'admin' }], o)).toThrow(/role/);
    expect(() => buildRosterEvent('a', [{ npub: hex('c'), role: 'agent', of: hex('d') }], o)).toThrow(/listed/);
    expect(() => buildRosterEvent('a', [{ npub: 'npub1nope', role: 'viewer' }], o)).toThrow(/invalid/);
  });
  it('caps at 12 people including the owner', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ npub: (i + 1).toString(16).padStart(64, '0'), role: 'viewer' }));
    expect(() => buildRosterEvent('a', many, { ownerHex: OWNER })).toThrow(/12/);
    expect(buildRosterEvent('a', many.slice(1), { ownerHex: OWNER }).tags).toHaveLength(12);
  });
});

describe('roster client', () => {
  it('exports projectRoster + putProjectRoster', () => {
    expect(typeof agent.projectRoster).toBe('function');
    expect(typeof agent.putProjectRoster).toBe('function');
  });
});
