// Incremental UTF-8/SSE reader. EOF without a terminal event is NOT success.
export async function readChatEvents(response, onEvent) {
  if (!response.body?.getReader) throw new Error('missing chat stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      size += part.value?.byteLength || 0;
      if (size > 2 * 1024 * 1024) throw new Error('chat stream too large');
      buffer += decoder.decode(part.value || new Uint8Array(), { stream: !part.done });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
        if (!data) continue;
        const event = JSON.parse(data);
        onEvent?.(event);
        if (event.type === 'done') return { ok: true, data: event };
        if (event.type === 'error') return { ok: false, reason: event.error || 'Chat failed.', code: event.code, data: event };
      }
      if (part.done) throw new Error('chat stream ended before completion');
    }
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}

const PHASE_LABELS = {
  prepare: 'Preparing',
  discovery: 'Finding provider',
  payment: 'Preparing payment',
  provider_wait: 'Waiting for model',
  settlement: 'Finishing payment',
};
export function phaseLabel(phase) { return PHASE_LABELS[phase] || 'Thinking'; }
export function timingLabel(t) {
  if (!t || !Number.isFinite(t.total_ms)) return '';
  const seconds = ms => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  return [
    t.first_text_ms == null ? null : `First text ${seconds(t.first_text_ms)}`,
    `Total ${seconds(t.total_ms)}`,
    ...[['discovery', 'Provider search'], ['payment', 'Payment'], ['provider_wait', 'Model wait'],
      ['generation', 'Generation'], ['settlement', 'Settlement']]
      .filter(([key]) => Number.isFinite(t[`${key}_ms`]))
      .map(([key, label]) => `${label} ${seconds(t[`${key}_ms`])}`),
    Number.isFinite(t.attempts) ? `Attempts ${t.attempts}` : null,
  ].filter(Boolean).join(' · ');
}
