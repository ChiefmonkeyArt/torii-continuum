import { safeRemoteBaseUrl } from './routstr-discovery.mjs';

export function validQuarantine(value) {
  return Array.isArray(value) && value.length <= 8 && value.every(base => {
    try { return safeRemoteBaseUrl(base) === base && new URL(base).origin === base; }
    catch { return false; }
  });
}

export function isQuarantined(cfg, base) {
  const list = cfg.routstr?.quarantined_providers || [];
  if (!validQuarantine(list)) throw new Error('Invalid provider quarantine');
  try { return list.includes(new URL(base).origin); } catch { return true; }
}
