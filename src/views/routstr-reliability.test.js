// @vitest-environment jsdom
import { beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
vi.mock('../data/agent.js', async importOriginal => ({
  ...await importOriginal(),
  isAgentConfigured: () => true,
  walletBalance: vi.fn(),
  walletPendingQuotes: vi.fn(async () => ({ ok: true, data: { quotes: [] } })),
  walletQuotesResume: vi.fn(), walletReceive: vi.fn(), walletMint: vi.fn(),
  walletInvoice: vi.fn(), walletMintQuoteStatus: vi.fn(), walletMintClaim: vi.fn(),
  nwcStatus: vi.fn(async () => ({ ok: true, data: { connected: false } })),
  walletNwcConnect: vi.fn(), walletNwcDisconnect: vi.fn(), walletNwcTopup: vi.fn(),
  agentRoutstrUsage: vi.fn(async () => ({ ok: false })),
  routstrModels: vi.fn(async () => ({ ok: true, data: { selected_model: 'deepseek-v4-flash', max_sats_per_request: 50,
    models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] } })),
  selectRoutstrModel: vi.fn(),
}));
vi.mock('../chat.js', () => ({ setChatContext: vi.fn() }));
vi.mock('../router.js', () => ({ currentRoute: () => ({ pattern: '/routstr' }) }));
vi.mock('../auth.js', () => ({ isSessionLive: () => true, startLogin: vi.fn(), getSession: () => null }));
import { walletBalance } from '../data/agent.js';
import * as store from '../data/store.js';
import { renderRoutstr, paymentRecoveryLabel } from './routstr.js';
const tick = () => new Promise(r => setTimeout(r, 0));
beforeEach(() => {
  vi.clearAllMocks(); window.location.hash = '#/routstr';
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  store.initStore();
  store.updateRoutstr({ cashuBalanceSats: 999999 });
});
afterEach(() => { window.location.hash = '#/projects'; document.body.replaceChildren(); });
describe('live wallet clarity', () => {
  test('an empty server preferences event does not crash the screen', async () => {
    store.getState().routstr = null;
    walletBalance.mockResolvedValue({ ok: true, data: { total_sats: 7 } });
    const mount = document.createElement('main'); document.body.append(mount);
    expect(() => renderRoutstr(mount)).not.toThrow();
    await tick();
    expect(mount.querySelector('.bal-num').textContent).toBe('7');
  });
  test('never shows cached money or mock controls; advanced remains collapsed', async () => {
    let resolve;
    walletBalance.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const mount = document.createElement('main'); document.body.append(mount);
    renderRoutstr(mount);
    expect(mount.querySelector('.bal-num').textContent).toBe('—');
    expect(mount.textContent).not.toMatch(/mock|Connect Cashu wallet/);
    expect(mount.querySelector('.routstr-advanced').open).toBe(false);
    resolve({ ok: true, data: { total_sats: 52, payment_recovery: { available: true, blocked: true, pending: 1 } } });
    await tick();
    expect(mount.querySelector('.bal-num').textContent).toBe('52');
    expect(mount.textContent).toContain('Do not top up to fix this');
    expect(mount.textContent).toContain('50-sat request cap');
  });
  test('unavailable amounts are unknown, never stale or zero', async () => {
    walletBalance.mockResolvedValue({ ok: false });
    const mount = document.createElement('main'); document.body.append(mount);
    renderRoutstr(mount); await tick();
    expect(mount.querySelector('.bal-num').textContent).toBe('—');
    expect(mount.textContent).toContain('Balance unavailable');
  });
  test('old route requests cannot overwrite a new mount', async () => {
    let resolve;
    walletBalance.mockImplementationOnce(() => new Promise(r => { resolve = r; }))
      .mockResolvedValue({ ok: true, data: { total_sats: 12 } });
    const mount = document.createElement('main'); document.body.append(mount);
    renderRoutstr(mount); renderRoutstr(mount); await tick();
    resolve({ ok: true, data: { total_sats: 999 } }); await tick();
    expect(mount.querySelector('.bal-num').textContent).toBe('12');
  });
  test('missing recovery information is never presented as ready', () => {
    expect(paymentRecoveryLabel(null)).toContain('unavailable');
    expect(paymentRecoveryLabel({ available: true, held: 2 })).toContain('2 isolated');
    expect(paymentRecoveryLabel({ available: true, active: 1 })).toContain('in progress');
  });
});
