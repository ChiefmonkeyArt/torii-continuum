import { h, openModal } from './util.js';
import { localChat } from '../data/agent.js';

export function openLocalChat(ask = localChat) {
  const input = h('textarea', { rows: '3', maxlength: '2048', 'aria-label': 'Local AI question', placeholder: 'Ask a short question…' });
  const answer = h('p', { role: 'status', 'aria-live': 'polite' });
  const send = h('button', { type: 'submit', class: 'primary' }, ['Ask locally']);
  const done = h('button', { type: 'button' }, ['Close']);
  const form = h('form', {}, [input, answer, send, done]);
  const { close } = openModal({ title: 'Local AI · QVAC', subtitle: 'Llama 3.2 1B · This server only · No sats', body: form,
    onClose() { document.removeEventListener('continuum:session-changed', close); document.removeEventListener('keydown', esc); } });
  function esc(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', esc);
  document.addEventListener('continuum:session-changed', close);
  done.onclick = close;
  form.onsubmit = async event => {
    event.preventDefault();
    const q = input.value.trim();
    if (!q || send.disabled) return;
    if (new TextEncoder().encode(q).length > 2048) { answer.textContent = 'Please shorten your question.'; return; }
    send.disabled = true; answer.textContent = 'Thinking locally…';
    let text = '';
    try {
      const r = await ask(q, e => {
        if (e.type === 'delta' && typeof e.delta === 'string' && form.isConnected) answer.textContent = text += e.delta;
      });
      if (form.isConnected) answer.textContent = r.ok ? r.data.reply : 'Local AI is unavailable. Nothing was sent to Routstr.';
    } catch { if (form.isConnected) answer.textContent = 'Local AI is unavailable. Nothing was sent to Routstr.'; }
    finally { send.disabled = false; }
  };
  input.focus();
}
