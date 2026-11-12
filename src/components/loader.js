/**
 * One calm loading ring (adr-seamless-team-chat §1, §2): an amber arc sweeps
 * round a faint track, with "…" after the label. Reduced motion gets a slow
 * pulse instead (styles/layout.css `.loader`). Torii Teams draws the same.
 */
import { h } from '../views/util.js';

const NS = 'http://www.w3.org/2000/svg';

function ring() {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'loader-ring');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('aria-hidden', 'true');
  for (const cls of ['loader-track', 'loader-arc']) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', '20');
    c.setAttribute('cy', '20');
    c.setAttribute('r', '16');
    svg.appendChild(c);
  }
  return svg;
}

/** @param {string} label e.g. "Loading project" */
export function loaderEl(label) {
  return h('div', { class: 'loader', role: 'status', 'aria-live': 'polite' }, [
    ring(),
    h('p', { class: 'loader-label' }, [label, h('span', { class: 'loader-dots', 'aria-hidden': 'true' })]),
  ]);
}
