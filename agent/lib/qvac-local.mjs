// One text-only question over a filesystem-protected Unix socket. No network
// URL, tools, model-supplied actions, shared history, or remote fallback.
import { createConnection } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
export const QVAC_SOCKET = '/run/continuum-qvac.sock';
export function localQuestion(input) {
  if (typeof input !== 'string') return null;
  const q = input.trim();
  return q && Buffer.byteLength(q) <= 2048 ? q : null;
}
export function askQvac(question, { onDelta, signal, path = QVAC_SOCKET, timeoutMs = 100000 } = {}) {
  const q = localQuestion(question);
  if (!q) return Promise.reject(new Error('Use a short text question.'));
  if (signal?.aborted) return Promise.reject(new Error('Local request cancelled.'));
  return new Promise((resolve, reject) => {
    const s = createConnection(path), decoder = new StringDecoder('utf8');
    let buf = '', answer = '', settled = false, bytes = 0;
    const finish = (err) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      s.destroy(); err ? reject(new Error(err)) : resolve(answer);
    };
    const cancel = () => finish('Local request cancelled.');
    const timer = setTimeout(() => finish('Local AI timed out.'), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    s.on('connect', () => s.write(JSON.stringify({ question: q }) + '\n'));
    s.on('error', () => finish('Local AI is unavailable.'));
    s.on('close', () => finish('Local AI stopped before completing its reply.'));
    s.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 32768) return finish('Local response too large.');
      buf += decoder.write(chunk);
      while (!settled && buf.includes('\n')) {
        const i = buf.indexOf('\n'), line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.done === true && answer.trim()) return finish();
          if (typeof msg.delta !== 'string') return finish('Local AI did not return a reply.');
          answer += msg.delta; onDelta?.(msg.delta);
        } catch { return finish('Invalid local response.'); }
      }
    });
  });
}
