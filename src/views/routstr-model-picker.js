import { h, clear } from './util.js';
import { routstrModels, selectRoutstrModel } from '../data/agent.js';

export function renderLiveModelPicker({ load = routstrModels, save = selectRoutstrModel } = {}) {
  let selected = null, models = [], busy = false;
  const current = h('p', { class: 'muted', text: 'Loading your current model…' });
  const status = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite', text: '' });
  const search = h('input', { id: 'routstr-model-search', type: 'search', placeholder: 'Find a model, e.g. DeepSeek', 'aria-label': 'Find a chat model', disabled: true });
  const select = h('select', { 'aria-label': 'Chat model', disabled: true, style: 'width:100%;max-width:100%;' });
  const price = h('p', { class: 'muted', text: '' });
  const cap = h('p', { class: 'muted', text: '' });
  const button = h('button', { class: 'btn primary', text: 'Use this model', disabled: true });
  const retry = h('button', { class: 'btn', text: 'Refresh models', disabled: true });
  const card = h('div', { class: 'card live-model-picker' }, [
    h('h3', { text: 'Chat model' }), current,
    h('p', { class: 'muted', text: 'Choose the real model your agent uses for new chats. Your choice is saved on your server, not just in this browser.' }),
    h('div', { class: 'field', style: 'display:grid;gap:12px;min-width:0;' }, [
      h('label', { for: 'routstr-model-search', text: 'Find and select a model' }), search, select, price,
      h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;' }, [button, retry])]), cap, status,
  ]);
  function showPrice() {
    const row = models.find(m => m.id === select.value);
    price.textContent = row ? `From ${Number(row.input_sats_per_1k).toFixed(3)} sats / 1k input tokens · ${Number(row.output_sats_per_1k).toFixed(3)} sats / 1k output tokens` : '';
    button.disabled = busy || !row || select.value === selected;
  }
  function draw(preferred = selected) {
    clear(select);
    const term = search.value.trim().toLowerCase();
    const filtered = models.filter(m => `${m.name} ${m.id}`.toLowerCase().includes(term));
    if (selected && !models.some(m => m.id === selected))
      select.append(h('option', { value: selected, text: `${selected} (currently unavailable)`, disabled: true }));
    for (const m of filtered) select.append(h('option', { value: m.id, text: `${m.name} (${m.id})` }));
    if ([...select.options].some(o => o.value === preferred)) select.value = preferred;
    select.disabled = busy || !filtered.length;
    showPrice();
  }
  async function refresh() {
    if (busy) return;
    busy = true; retry.disabled = true; button.disabled = true; select.disabled = true; search.disabled = true;
    status.textContent = 'Checking available models. This does not spend any sats.';
    try {
      const result = await load();
      if (!card.isConnected) return;
      if (!result.ok) throw new Error('load');
      selected = result.data.selected_model; models = result.data.models || [];
      current.textContent = `Current: ${models.find(m => m.id === selected)?.name || selected}`;
      cap.textContent = `Your ${result.data.max_sats_per_request}-sat request cap stays unchanged. Declared rates vary by provider; payment rounding and mint fees may apply.`;
      status.textContent = models.length ? 'Select a model, then choose “Use this model”.' : 'No priced models are available right now. Your current setting has not changed.';
    } catch { if (card.isConnected) status.textContent = 'Could not load models. Check your sign-in and try Refresh models.'; }
    finally { busy = false; retry.disabled = false; search.disabled = !models.length; draw(); }
  }
  search.addEventListener('input', () => draw(select.value));
  select.addEventListener('change', showPrice);
  retry.addEventListener('click', refresh);
  button.addEventListener('click', async () => {
    if (busy || button.disabled) return;
    const requested = select.value; busy = true; button.disabled = true; select.disabled = true; search.disabled = true; retry.disabled = true;
    status.textContent = 'Saving your chat model…';
    try {
      const result = await save(requested);
      if (!card.isConnected) return;
      if (!result.ok || result.data?.selected_model !== requested) throw new Error('save');
      selected = requested;
      current.textContent = `Current: ${models.find(m => m.id === selected)?.name || selected}`;
      status.textContent = 'Saved. Your next chat will use this model. No restart needed.';
    } catch { if (card.isConnected) status.textContent = 'Could not save. Your confirmed model is unchanged. Refresh models and try again.'; }
    finally { busy = false; search.disabled = false; retry.disabled = false; draw(requested); }
  });
  queueMicrotask(refresh);
  return card;
}
