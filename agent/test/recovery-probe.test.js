import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRecoveryProbe, PROBE_MODEL } from '../ops/probe-deepseek-recovery.mjs';
const cfg = { routstr: { payment_mode: 'ephemeral_bearer', quarantined_providers: ['https://bad.example'] } };
test('probe requires explicit approval before even discovering providers', async () => {
  await assert.rejects(runRecoveryProbe(cfg), /approval/);
});
test('no eligible same-model offer fails before opening the wallet', async () => {
  await assert.rejects(runRecoveryProbe(cfg, { approved: true,
    discover: async () => [], catalog: async () => [],
    walletFactory: async () => { assert.fail('wallet must not be opened'); },
  }), /no compatible/);
});
test('probe retains model, restricts one deposit, and includes fee cap', async () => {
  let calls = 0;
  const provider = { baseUrl: 'https://good.example', models: [{ id: PROBE_MODEL,
    pricing_sats: { request: 0, prompt: 0.000001, completion: 0.00001 } }] };
  const report = await runRecoveryProbe(cfg, { approved: true, emit() {}, log: {},
    discover: async () => [{ baseUrl: 'https://bad.example' }, provider],
    catalog: async providers => { assert.deepEqual(providers, [provider]); return providers; },
    walletFactory: async () => ({ balance: async () => ({ total: 10 }), send: async (sats, options) => {
      calls++; assert.equal(sats, 1); assert.deepEqual(options, { maxDebitSats: 2 }); return {};
    } }),
    routerFactory: (config, wallet) => {
      assert.equal(config.routstr.fallback.enabled, false);
      assert.equal(config.routstr.models.chat, PROBE_MODEL);
      return { stopDiscovery() {}, stopPaymentRecovery() {},
        async chat({ onDelta }) {
          await wallet.send(1);
          await assert.rejects(wallet.send(1), /single-deposit/);
          onDelta('GM'); return { ok: true, content: 'GM' };
        } };
    },
  });
  assert.equal(calls, 1);
  assert.equal(report.ok, true);
  assert.equal(report.response_chars, 2);
  assert.equal(report.max_total_debit_sats, 2);
  assert.equal(cfg.routstr.models, undefined);
});
