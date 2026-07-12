import { test, expect } from '@playwright/test';

const AGENT_URL = process.env.CONTINUUM_AGENT_URL || 'https://agent.example.com';

test.describe('Continuum Agent API', () => {

  test('GET /api/health returns ok', async ({ request }) => {
    const resp = await request.get(`${AGENT_URL}/api/health`);
    expect(resp.ok()).toBeTruthy();
    const data = await resp.json();
    expect(data.ok).toBe(true);
    expect(data.service).toContain('torii-continuum-agent');
    expect(data.version).toBeDefined();
    expect(typeof data.version).toBe('string');
    console.log(`  Agent version: ${data.version}, memory: ${data.memory_unlocked}`);
  });

  test('POST /api/auth/challenge returns challenge token', async ({ request }) => {
    const resp = await request.post(`${AGENT_URL}/api/auth/challenge`);
    expect(resp.status()).toBe(200);
    const data = await resp.json();
    expect(data.challenge).toBeDefined();
    expect(data.challenge.length).toBeGreaterThan(10);
    expect(data.expires_in).toBe(300);
    expect(data.kind).toBe(22242);
    console.log(`  Challenge: ${data.challenge.slice(0, 20)}...`);
  });

  test('GET /api/wallet/balance returns 401 without auth', async ({ request }) => {
    const resp = await request.get(`${AGENT_URL}/api/wallet/balance`);
    expect(resp.status()).toBe(401);
  });

  test('POST /api/chat returns 401 without auth', async ({ request }) => {
    const resp = await request.post(`${AGENT_URL}/api/chat`, {
      data: { message: 'hello' },
    });
    expect(resp.status()).toBe(401);
  });

  test('POST /api/chat returns 401 with empty message (auth check runs before body validation)', async ({ request }) => {
    const resp = await request.post(`${AGENT_URL}/api/chat`, {
      data: { message: '' },
    });
    expect(resp.status()).toBe(401);
  });

  test('Character endpoint returns 401 without auth', async ({ request }) => {
    const resp = await request.get(`${AGENT_URL}/api/character`);
    expect(resp.status()).toBe(401);
  });
});
