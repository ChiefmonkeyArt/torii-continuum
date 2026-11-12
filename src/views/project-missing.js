/**
 * A project page whose project is not in the store yet
 * (adr-seamless-team-chat §1). While the store is still loading from the
 * agent: "Loading project" with the loading ring, then the page draws itself
 * the moment the project arrives. Only once loading has finished: "No project
 * with that slug." (and still redraws if it turns up later).
 */
import { h, clear } from './util.js';
import * as store from '../data/store.js';
import { navigate } from '../router.js';
import { loaderEl } from '../components/loader.js';

/**
 * @param {HTMLElement} mount
 * @param {string} slug
 * @param {() => void} redraw renders the page again (the project is there now)
 * @param {{go?: (path: string) => void, back?: string}} [opts]
 */
export function renderProjectMissing(mount, slug, redraw, { go = navigate, back = '/projects' } = {}) {
  clear(mount);
  const loading = store.storeLoading();
  const el = loading
    ? loaderEl('Loading project')
    : h('div', { class: 'empty' }, [
      h('div', { class: 'big', text: '⛩' }),
      h('div', { text: 'No project with that slug.' }),
      h('button', { style: 'margin-top: 12px', onClick: () => go(back) }, ['Back to projects']),
    ]);
  mount.appendChild(el);
  const off = store.subscribe(() => {
    if (!el.isConnected) { off(); return; }
    if (store.getProject(slug)) { off(); redraw(); return; }
    if (loading && !store.storeLoading()) { off(); renderProjectMissing(mount, slug, redraw, { go, back }); }
  });
}
