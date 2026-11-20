import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRecoveryProbe, PROBE_MODEL, safeProviderCode } from '../ops/probe-deepseek-recovery.mjs';
test('diagnostic reports only bounded, recognized codes; never bodies or arbitrary identifiers', async () => {
  for (const [body,expected] of [[{detail:{error:{code:'key_not_found',message:'private'}}},'key_not_found'],
    [{error:{code:'invalid_api_key'}},'invalid_api_key'],[{error:{code:401}},401],
    [{error:{code:'sk-private'}},null],[{code:'missing_api_key',detail:'x'.repeat(9000)},null]]) {
    assert.equal(await safeProviderCode(new Response(JSON.stringify(body))),expected);
  }
});
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
      calls++; assert.equal(sats, 1); assert.deepEqual(options, { maxDebitSats: 2 }); return { ok: true };
    } }),
    routerFactory: (config, wallet, _log, deps) => {
      assert.equal(config.routstr.fallback.enabled, false);
      assert.equal(config.routstr.models.chat, PROBE_MODEL);
      return { stopDiscovery() {}, stopPaymentRecovery() {},
        async chat({ onDelta }) {
          await wallet.send(1);
          await assert.rejects(wallet.send(1), /single-deposit/);
          await deps.observeRejectedCompletion(new Response('{"detail":{"error":{"code":"key_not_found","message":"private"}}}',{status:401}));
          return { ok: false, failure_kind: 'upstream_4xx' };
        } };
    },
  });
  assert.equal(calls, 1);
  assert.equal(report.ok, false);
  assert.equal(report.http_status,401);
  assert.equal(report.provider_error_code,'key_not_found');
  assert.ok(!JSON.stringify(report).includes('private'));
  assert.equal(report.deposits, 1);
  assert.equal(report.deposit_attempts, 1);
  assert.equal(report.response_chars, 0);
  assert.equal(report.max_total_debit_sats, 2);
  assert.equal(cfg.routstr.models, undefined);
});
