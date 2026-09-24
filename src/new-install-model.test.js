import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
test('both new-install entry points default chat to V4 Flash without migrating existing config', () => {
  for (const path of ['../agent/config.example.yaml', '../ops/ansible/roles/continuum/templates/config.yaml.j2']) {
    const text = readFileSync(new URL(path, import.meta.url), 'utf8');
    expect(text).toMatch(/chat:\s+"deepseek-v4-flash"/);
    expect(text).toMatch(/max_sats_per_request:\s+50/);
  }
  const installer = readFileSync(new URL('../ops/install-agent.sh', import.meta.url), 'utf8');
  expect(installer).toMatch(/config\.yaml/);
});
