/**
 * Structured, sanitised provider errors + the 5xx/HTML/timeout fallback
 * decision (v0.2.90-alpha, CONT-FALLBACK-1).
 *
 * The live bug: Routstr's edge can answer with a Cloudflare HTML error page
 * (sometimes under a 200 status), a 5xx, or simply hang. The old router only
 * fell back to the local Ollama model on payment/network prose, so all three of
 * those became dead chat turns — and the failure reason spliced up to 200 chars
 * of the raw upstream body (HTML, possibly echoed secrets) into a string that
 * reached the browser.
 *
 * These tests pin both halves of the fix: classification/sanitisation, and the
 * retryability contract the router depends on.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_CODES,
  isRetryableCode,
  sanitizeReason,
  looksLikeHtml,
  classifyHttpFailure,
  classifyThrownError,
  providerFailure,
  inferCodeFromReason,
} from '../lib/provider-errors.mjs';

test('looksLikeHtml detects the Cloudflare-style error page shapes', () => {
  assert.equal(looksLikeHtml('<!DOCTYPE html><html><head><title>520</title>'), true);
  assert.equal(looksLikeHtml('  \n<html lang="en"><body>error</body></html>'), true);
  assert.equal(looksLikeHtml('<?xml version="1.0"?><error/>'), true);
  assert.equal(looksLikeHtml('<title>Bad gateway</title>'), true);
  // Not HTML
  assert.equal(looksLikeHtml('{"error":{"message":"nope"}}'), false);
  assert.equal(looksLikeHtml('data: {"choices":[]}\n\ndata: [DONE]'), false);
  assert.equal(looksLikeHtml(''), false);
  assert.equal(looksLikeHtml(undefined), false);
});

test('classifyHttpFailure: a 5xx is upstream_5xx and retryable', () => {
  const r = classifyHttpFailure({ status: 503, body: '{"error":{"message":"overloaded"}}', provider: 'routstr' });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.UPSTREAM_5XX);
  assert.equal(r.status, 503);
  assert.equal(r.retryable, true);
  assert.match(r.reason, /http 503/);
  assert.match(r.reason, /overloaded/);
});

test('classifyHttpFailure: an HTML body wins over the status line', () => {
  // A 520 that serves HTML is an edge fault, not a model API error.
  const r = classifyHttpFailure({ status: 520, body: '<!doctype html><html><title>520</title>', provider: 'routstr' });
  assert.equal(r.code, ERROR_CODES.UPSTREAM_HTML);
  assert.equal(r.retryable, true);
  assert.match(r.reason, /HTML error page/);
});

test('classifyHttpFailure NEVER forwards the raw upstream body', () => {
  const html = '<!doctype html><html><body>secret-internal-hostname.example brokenpipe at line 42</body></html>';
  const r = classifyHttpFailure({ status: 502, body: html, provider: 'routstr' });
  assert.ok(!r.reason.includes('secret-internal-hostname'), 'must not echo body text');
  assert.ok(!r.reason.includes('<'), 'must not carry markup');
});

test('classifyHttpFailure: 402 maps to insufficient_funds (retryable to the free model)', () => {
  const r = classifyHttpFailure({ status: 402, body: 'payment required', provider: 'routstr' });
  assert.equal(r.code, ERROR_CODES.INSUFFICIENT_FUNDS);
  assert.equal(r.retryable, true);
});

test('classifyHttpFailure: a plain 4xx is NOT retryable', () => {
  const r = classifyHttpFailure({ status: 400, body: '{"error":{"message":"bad model"}}', provider: 'routstr' });
  assert.equal(r.code, ERROR_CODES.UPSTREAM_4XX);
  assert.equal(r.retryable, false);
});

test('classifyThrownError: an AbortError becomes a retryable upstream_timeout', () => {
  const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const r = classifyThrownError(err, { timeoutMs: 45000, provider: 'routstr' });
  assert.equal(r.code, ERROR_CODES.UPSTREAM_TIMEOUT);
  assert.equal(r.retryable, true);
  assert.match(r.reason, /timed out after 45000ms/);
});

test('classifyThrownError: a socket failure becomes a retryable network error', () => {
  const r = classifyThrownError(new Error('fetch failed ECONNREFUSED'), { provider: 'routstr' });
  assert.equal(r.code, ERROR_CODES.NETWORK);
  assert.equal(r.retryable, true);
});

test('sanitizeReason redacts cashu tokens, NWC URIs, bearer values and long hex', () => {
  const dirty = 'failed with cashuAeyJ0b2tlbiI6dGVzdFBBWUxPQUQ token and '
    + 'nostr+walletconnect://relay?secret=abc and Authorization: Bearer sk-supersecretvalue '
    + 'proof 0123456789abcdef0123456789abcdef';
  const clean = sanitizeReason(dirty, 500);
  assert.ok(clean.includes('[cashu-token-redacted]'), 'cashu token redacted');
  assert.ok(!clean.includes('cashuAeyJ0'), 'no raw cashu token');
  assert.ok(clean.includes('[nwc-uri-redacted]'), 'nwc uri redacted');
  assert.ok(!clean.includes('sk-supersecretvalue'), 'bearer value redacted');
  assert.ok(!clean.includes('0123456789abcdef0123456789abcdef'), 'long hex redacted');
});

test('sanitizeReason bounds length and collapses whitespace', () => {
  const r = sanitizeReason('a\n\n   b   c' + 'x'.repeat(500));
  assert.ok(r.length <= 180, `expected <=180 chars, got ${r.length}`);
  assert.ok(!r.includes('\n'), 'newlines collapsed');
});

test('retryability contract: transport/payment retry, malformed request does not', () => {
  for (const code of [
    ERROR_CODES.UPSTREAM_5XX,
    ERROR_CODES.UPSTREAM_HTML,
    ERROR_CODES.UPSTREAM_TIMEOUT,
    ERROR_CODES.UPSTREAM_EMPTY,
    ERROR_CODES.NETWORK,
    ERROR_CODES.INSUFFICIENT_FUNDS,
    ERROR_CODES.TOKEN_ALREADY_SPENT,
  ]) {
    assert.equal(isRetryableCode(code), true, `${code} should be retryable`);
  }
  for (const code of [ERROR_CODES.BAD_REQUEST, ERROR_CODES.UPSTREAM_4XX, ERROR_CODES.PROVIDER_DISABLED]) {
    assert.equal(isRetryableCode(code), false, `${code} should NOT be retryable`);
  }
});

test('providerFailure derives retryable from the code and sanitises the reason', () => {
  const r = providerFailure(ERROR_CODES.UPSTREAM_EMPTY, 'routstr returned an empty completion stream');
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.UPSTREAM_EMPTY);
  assert.equal(r.retryable, true);

  const bad = providerFailure(ERROR_CODES.BAD_REQUEST, 'messages must be a non-empty array');
  assert.equal(bad.retryable, false);
});

test('inferCodeFromReason bridges legacy free-text reasons', () => {
  assert.equal(inferCodeFromReason('timeout after 60000ms'), ERROR_CODES.UPSTREAM_TIMEOUT);
  assert.equal(inferCodeFromReason('network: fetch failed'), ERROR_CODES.NETWORK);
  assert.equal(inferCodeFromReason('http 520: <html>'), ERROR_CODES.UPSTREAM_HTML);
  assert.equal(inferCodeFromReason('no content in stream'), ERROR_CODES.UPSTREAM_EMPTY);
  assert.equal(
    inferCodeFromReason('wallet: insufficient balance across all mints for 50 sats'),
    ERROR_CODES.INSUFFICIENT_FUNDS,
  );
  assert.equal(inferCodeFromReason('http 500: upstream boom'), ERROR_CODES.UPSTREAM_5XX);
  assert.equal(inferCodeFromReason('messages must be a non-empty array'), null);
});
