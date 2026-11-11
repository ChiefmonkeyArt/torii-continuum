// docs/adr-routstr-provider-fallback.md §4: say who answered when Routstr switched.
import { describe, it, expect } from 'vitest';
import { routstrFallbackNote } from './chat.js';

describe('routstrFallbackNote', () => {
  it('is empty when nothing switched', () => {
    expect(routstrFallbackNote(null)).toBe('');
    expect(routstrFallbackNote(undefined)).toBe('');
  });
  it('names the model and provider when another model answered', () => {
    expect(routstrFallbackNote({ model: 'deepseek-v4-flash', provider: 'api.nonkycai.com', from_model: 'gone', from_provider: null }))
      .toBe('\n\n_(answered by deepseek-v4-flash via api.nonkycai.com — gone was unavailable)_');
  });
  it('names the provider that failed when only the provider changed', () => {
    expect(routstrFallbackNote({ model: 'm', provider: 'b.example', from_model: 'm', from_provider: 'a.example' }))
      .toBe('\n\n_(answered by m via b.example — a.example was unavailable)_');
  });
  it('strips markup from untrusted names', () => {
    const note = routstrFallbackNote({ model: 'm', provider: '[x](javascript:alert(1))', from_model: 'm', from_provider: '<img>' });
    expect(note).not.toMatch(/[[\]<>]/);
    expect(note).not.toContain('alert(');
  });
});
