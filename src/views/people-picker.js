/**
 * People picker (docs/adr-teams-membership-signals.md). Search by profile
 * name, NIP-05 (name@domain) or npub; every result shows avatar, display name
 * and NIP-05 / short npub. The agent does the searching (owner session only).
 */
import { h, clear } from './util.js';
import { personEl, rememberProfiles } from '../lib/people.js';

export const DEBOUNCE_MS = 300;

/**
 * @param {object} o
 * @param {(q:string) => Promise<{ok:boolean, data?:{results:Array}, reason?:string}>} o.search
 * @param {(hex:string) => void} o.onPick
 * @param {() => Set<string>} [o.exclude] pubkeys already on the list
 * @param {string} [o.placeholder]
 */
export function renderPeoplePicker({ search, onPick, exclude = () => new Set(), placeholder = 'Search by name, name@domain or npub' }) {
  const input = h('input', { type: 'search', placeholder, maxlength: '128', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-label': 'Find a person', style: 'width:100%;' });
  const results = h('div', { class: 'people-results', role: 'listbox', style: 'display:flex;flex-direction:column;gap:2px;margin-top:6px;max-height:300px;overflow:auto;' });
  const note = h('div', { class: 'muted', role: 'status', style: 'font-size:12px;min-height:16px;margin-top:4px;' });
  let timer = null;
  let seq = 0;

  async function run(q) {
    const mine = ++seq;
    if (q.length < 2) { clear(results); note.textContent = ''; return; }
    note.textContent = 'Searching…';
    const r = await search(q);
    if (mine !== seq) return; // a newer query won
    clear(results);
    if (!r?.ok) { note.textContent = r?.offline ? 'The agent is offline.' : `Search failed: ${r?.reason || 'unknown error'}`; return; }
    const skip = exclude();
    const list = (r.data?.results || []).filter((p) => !skip.has(p.pubkey));
    rememberProfiles(list);
    note.textContent = list.length ? '' : 'Nobody found. Try their npub or name@domain.';
    for (const p of list) {
      const btn = h('button', {
        type: 'button', class: 'ghost people-result', role: 'option',
        style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;text-align:left;padding:6px 8px;width:100%;',
        onClick: () => { onPick(p.pubkey); input.value = ''; clear(results); note.textContent = ''; input.focus(); },
      }, [personEl(p.pubkey), p.follows ? h('span', { class: 'pill', text: 'You follow' }) : null]);
      results.appendChild(btn);
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    timer = setTimeout(() => run(q), DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(input.value.trim()); }
  });

  const el = h('div', { class: 'people-picker' }, [input, note, results]);
  el.focus = () => input.focus();
  return el;
}
