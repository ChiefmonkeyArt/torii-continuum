import { PassThrough } from 'node:stream';

// Numeric timings only. No prompts, replies, credentials, endpoints or owner IDs.
const PHASES = new Set(['prepare', 'discovery', 'payment', 'provider_wait', 'generation', 'settlement']);
export function createChatTelemetry(emit = () => {}, now = performance.now.bind(performance)) {
  const started = now();
  const totals = {};
  let firstText = null;
  let attempts = 0;
  let provider = null;
  const add = (phase, ms) => {
    if (PHASES.has(phase) && Number.isFinite(ms)) {
      totals[`${phase}_ms`] = (totals[`${phase}_ms`] || 0) + Math.max(0, ms);
    }
  };
  return {
    add,
    async measure(phase, task) {
      emit({ type: 'phase', phase });
      const t = now();
      try { return await task(); } finally { add(phase, now() - t); }
    },
    attempt(name) {
      attempts += 1;
      provider = name;
      emit({ type: 'reset', provider, attempt: attempts });
    },
    firstText() { if (firstText === null) firstText = now() - started; },
    snapshot() {
      return {
        ...Object.fromEntries([...PHASES].map(p => [`${p}_ms`, Math.round(totals[`${p}_ms`] || 0)])),
        first_text_ms: firstText === null ? null : Math.round(firstText),
        total_ms: Math.round(now() - started), attempts, provider,
      };
    },
  };
}

export const measure = (telemetry, phase, task) => telemetry
  ? telemetry.measure(phase, task) : task();

// A code fence may contain store-write instructions labelled store/json/blank.
// Hold ALL fenced content (and trailing backticks) until the validated final
// reply. Preview never executes actions, exposes action JSON or hidden reasoning.
export function createPreviewFilter(onDelta) {
  let pending = '';
  let held = false;
  return {
    push(text) {
      if (held || typeof text !== 'string') return;
      pending += text;
      const fence = pending.indexOf('```');
      if (fence >= 0) {
        if (fence) onDelta(pending.slice(0, fence));
        pending = ''; held = true;
        return;
      }
      const tail = pending.match(/`{1,2}$/)?.[0].length || 0;
      const safe = pending.slice(0, pending.length - tail);
      pending = pending.slice(pending.length - tail);
      if (safe) onDelta(safe);
    },
    reset() { pending = ''; held = false; },
  };
}

export function openChatStream(reply) {
  const stream = new PassThrough({ highWaterMark: 16384 });
  let ended = false;
  const emit = (event) => {
    if (ended || stream.destroyed) return;
    // A slow/disconnected browser must not accumulate unbounded plaintext.
    if (stream.writableLength > 65536 || stream.readableLength > 65536) {
      stream.destroy();
      reply.raw.destroy();
      return;
    }
    stream.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  reply.header('Content-Type', 'text/event-stream; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('X-Accel-Buffering', 'no');
  reply.send(stream);
  emit({ type: 'phase', phase: 'prepare' });
  const heartbeat = setInterval(() => emit({ type: 'heartbeat' }), 10000);
  heartbeat.unref?.();
  stream.on('close', () => clearInterval(heartbeat));
  return {
    emit,
    connected: () => !stream.destroyed && !reply.raw.destroyed,
    end() { ended = true; clearInterval(heartbeat); stream.end(); },
  };
}
