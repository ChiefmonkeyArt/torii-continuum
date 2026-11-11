/**
 * Short memory of slow or failing Routstr providers (docs/adr-routstr-turns-dont-hang.md §2).
 * In memory only: a restart forgets. Keyed by provider and model.
 */

export const REST_BASE_MS = 10 * 60 * 1000;
export const REST_MAX_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 200;

// Failures that say the provider was slow or broken, not that the request was.
const PROVIDER_FAULTS = new Set(['upstream_timeout', 'upstream_stalled', 'upstream_too_long',
  'upstream_incomplete', 'upstream_5xx', 'upstream_html', 'upstream_empty', 'network']);

export function isProviderFault(kindOrCode) {
  return PROVIDER_FAULTS.has(kindOrCode);
}

export function createProviderHealth({ now = Date.now } = {}) {
  const entries = new Map();
  const key = (baseUrl, modelId) => `${baseUrl}\n${modelId}`;

  function fail(baseUrl, modelId) {
    const k = key(baseUrl, modelId);
    const strikes = (entries.get(k)?.strikes || 0) + 1;
    const rest = Math.min(REST_MAX_MS, REST_BASE_MS * 2 ** (strikes - 1));
    entries.delete(k);
    entries.set(k, { strikes, until: now() + rest });
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  }

  function ok(baseUrl, modelId) { entries.delete(key(baseUrl, modelId)); }

  function resting(baseUrl, modelId) {
    const e = entries.get(key(baseUrl, modelId));
    return !!e && e.until > now();
  }

  /** Resting pairs go last; otherwise the given (price) order is kept. */
  function order(candidates) {
    const fresh = [], rest = [];
    for (const c of candidates) (resting(c.baseUrl, c.model?.id) ? rest : fresh).push(c);
    return [...fresh, ...rest];
  }

  return { fail, ok, resting, order, size: () => entries.size };
}
