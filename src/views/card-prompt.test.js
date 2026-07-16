import { describe, it, expect } from 'vitest';
import { buildCardPrompt } from './card-prompt.js';

describe('buildCardPrompt', () => {
  it('composes title, description, project and column into the expected shape', () => {
    const card = { content: { title: 'Fix login bug', description: 'Users get 500 on submit' } };
    const out = buildCardPrompt(card, 'Torii (torii)', 'Doing');
    expect(out).toBe(
      'Work on this task.\n' +
      'Title: Fix login bug\n' +
      'Details: Users get 500 on submit\n' +
      'Project: Torii (torii)\n' +
      'Status: Doing'
    );
  });

  it('omits the Details line when the description is empty', () => {
    const card = { content: { title: 'Write docs', description: '' } };
    const out = buildCardPrompt(card, 'Torii (torii)', 'Todo');
    expect(out).not.toContain('Details:');
    expect(out).toBe(
      'Work on this task.\n' +
      'Title: Write docs\n' +
      'Project: Torii (torii)\n' +
      'Status: Todo'
    );
  });

  it('omits Details when description is missing entirely', () => {
    const out = buildCardPrompt({ content: { title: 'Only title' } }, 'P (p)', 'Done');
    expect(out).not.toContain('Details:');
    expect(out).toContain('Title: Only title');
  });

  it('trims each field', () => {
    const card = { content: { title: '  spaced  ', description: '  d  ' } };
    const out = buildCardPrompt(card, '  Proj  ', '  Col  ');
    expect(out).toContain('Title: spaced\n');
    expect(out).toContain('Details: d\n');
    expect(out).toContain('Project: Proj\n');
    expect(out).toContain('Status: Col');
  });

  it('caps the total prompt length at ~600 chars', () => {
    const card = { content: { title: 'T', description: 'x'.repeat(2000) } };
    const out = buildCardPrompt(card, 'Proj (p)', 'Doing');
    expect(out.length).toBeLessThanOrEqual(600);
  });

  it('accepts a bare content object (no wrapping card)', () => {
    const out = buildCardPrompt({ title: 'Bare', description: 'y' }, 'Proj (p)', 'Todo');
    expect(out).toContain('Title: Bare');
    expect(out).toContain('Details: y');
  });
});
