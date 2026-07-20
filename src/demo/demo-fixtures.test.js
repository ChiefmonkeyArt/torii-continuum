/**
 * Demo fixtures (v0.2.85-alpha).
 *
 * The demo surface must be OBVIOUSLY fake: every human-facing string carries
 * "DEMO" or "Sample" so a mockup screen can never be mistaken for real operator
 * data. These tests lock that contract plus the read-only demoStore facade shape
 * (method names + return shapes mirror src/data/store.js so demo-capable views
 * swap data source with one line and never fork).
 */
import { describe, it, expect } from 'vitest';
import {
  DEMO_BALANCE_SATS,
  DEMO_PROJECTS,
  DEMO_MARKET_TASKS,
  DEMO_MEMBERS,
  DEMO_ROUTSTR,
  demoStore,
} from './demo-fixtures.js';

// A human-facing label must advertise itself as fake.
const looksFake = (s) => /DEMO|Sample/i.test(String(s));

describe('demo fixtures — obviously fake', () => {
  it('uses the brief-specified fake Cashu balance', () => {
    expect(DEMO_BALANCE_SATS).toBe(21042);
  });

  it('ships exactly three demo projects, all labelled fake', () => {
    expect(DEMO_PROJECTS).toHaveLength(3);
    for (const p of DEMO_PROJECTS) {
      expect(looksFake(p.content.name)).toBe(true);
      expect(looksFake(p.content.description)).toBe(true);
    }
  });

  it('every marketplace task title + team member label is labelled fake', () => {
    for (const t of DEMO_MARKET_TASKS) expect(looksFake(t.title)).toBe(true);
    for (const m of DEMO_MEMBERS) expect(looksFake(m.label)).toBe(true);
  });

  it('every milestone / todo / session title across projects is labelled fake', () => {
    for (const p of DEMO_PROJECTS) {
      const slug = p.content.slug;
      for (const m of demoStore.milestonesFor(slug)) expect(looksFake(m.content.title)).toBe(true);
      for (const t of demoStore.todosFor(slug)) expect(looksFake(t.content.text)).toBe(true);
      for (const s of demoStore.sessionsFor(slug)) expect(looksFake(s.content.title)).toBe(true);
    }
  });

  it('the Routstr model names are labelled fake', () => {
    for (const m of DEMO_ROUTSTR.content.models) expect(looksFake(m.name)).toBe(true);
  });
});

describe('demoStore — read-only facade mirroring src/data/store.js', () => {
  it('listProjects / getProject return nostr-shaped project events', () => {
    const list = demoStore.listProjects();
    expect(list).toHaveLength(3);
    const one = demoStore.getProject(list[0].content.slug);
    expect(one).not.toBeNull();
    expect(one.content.slug).toBe(list[0].content.slug);
    expect(demoStore.getProject('no-such-slug')).toBeNull();
  });

  it('milestonesFor / todosFor / sessionsFor / filesFor wrap fixtures as events', () => {
    const slug = 'demo-acme';
    for (const list of [
      demoStore.milestonesFor(slug),
      demoStore.todosFor(slug),
      demoStore.sessionsFor(slug),
      demoStore.filesFor(slug),
    ]) {
      expect(Array.isArray(list)).toBe(true);
      for (const ev of list) {
        expect(typeof ev.id).toBe('string');
        expect(typeof ev.kind).toBe('number');
        expect(ev.content.projectSlug).toBe(slug);
      }
    }
  });

  it('boardStatsFor derives a coarse, non-negative progress shape', () => {
    const bs = demoStore.boardStatsFor('demo-acme');
    for (const k of ['total', 'backlog', 'todo', 'doing', 'done', 'percent']) {
      expect(typeof bs[k]).toBe('number');
      expect(bs[k]).toBeGreaterThanOrEqual(0);
    }
    expect(bs.percent).toBeLessThanOrEqual(100);
  });

  it('listMarketTasks / listMembers / getRoutstr return the fixtures', () => {
    expect(demoStore.listMarketTasks()).toHaveLength(DEMO_MARKET_TASKS.length);
    expect(demoStore.listMembers()).toHaveLength(DEMO_MEMBERS.length);
    expect(demoStore.getRoutstr().content.cashuBalanceSats).toBe(DEMO_BALANCE_SATS);
  });

  it('subscribe is a no-op returning an unsubscribe function (store-compatible)', () => {
    const unsub = demoStore.subscribe(() => { throw new Error('demo store must never notify'); });
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });

  it('is frozen — no mutation entry points leak onto the facade', () => {
    expect(Object.isFrozen(demoStore)).toBe(true);
    expect(demoStore.createProject).toBeUndefined();
    expect(demoStore.addMember).toBeUndefined();
    expect(demoStore.updateRoutstr).toBeUndefined();
  });
});
