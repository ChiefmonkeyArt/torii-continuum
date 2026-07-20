/**
 * NavLink — a real <a href="#/route"> that still transitions in-SPA.
 *
 * Every in-app navigable renders a genuine anchor so that hover shows the URL,
 * right-click → "Open in new tab" works, and ⌘/Ctrl-click opens a new tab —
 * the affordances a <div role="button"> silently breaks. A left click with no
 * modifier is intercepted and handed to the hash router so navigation stays a
 * client-side transition (no full reload).
 *
 * The href is passed through demoAware() at CONSTRUCTION time, so while the
 * visitor is browsing the /demo mockup the anchor points into /demo/* — the
 * hover URL, the new-tab target and the intercepted transition all agree, and
 * none of them bounce to a guarded route.
 */
import { h } from '../views/util.js';
import { navigate } from '../router.js';
import { demoAware } from '../demo/demo-mode.js';

/**
 * Decide whether a click should be handled in-SPA or left to the browser.
 * Mirrors the router-link convention: honour an already-prevented event, and
 * escape-hatch anything that isn't a plain primary-button click (modifier keys
 * → new tab/window/download; non-primary buttons → context/middle-click).
 * Returns the router target (href minus the leading '#') when we should
 * intercept, or null when the browser should handle it natively.
 * @param {MouseEvent} e
 * @param {string} href resolved hash href, e.g. '#/demo/projects'
 */
export function navClickTarget(e, href) {
  if (!e || e.defaultPrevented) return null;
  if (e.button != null && e.button !== 0) return null;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  if (typeof href !== 'string' || !href.startsWith('#')) return null;
  return href.slice(1);
}

/**
 * Build a real anchor that transitions in-SPA on a plain left click.
 * @param {{href: string, children?: any, class?: string, ariaLabel?: string,
 *          dataset?: object, title?: string, onNavigate?: (target: string)=>void}} props
 *   href      — a hash href beginning with '#/', e.g. '#/projects';
 *   children  — string | node | array of them (anchor content);
 *   class     — className for the anchor;
 *   onNavigate— optional hook fired with the router target after navigate().
 */
export function NavLink(props = {}) {
  const { href, children = [], class: className, ariaLabel, dataset, title, onNavigate } = props;
  const resolved = demoAware(href);

  const attrs = { href: resolved };
  if (className) attrs.class = className;
  if (ariaLabel) attrs['aria-label'] = ariaLabel;
  if (title) attrs.title = title;
  if (dataset) attrs.dataset = dataset;
  attrs.onClick = (e) => {
    const target = navClickTarget(e, resolved);
    if (target == null) return; // let the browser open it (modifier / new tab)
    e.preventDefault();
    navigate(target);
    if (typeof onNavigate === 'function') onNavigate(target);
  };

  return h('a', attrs, children);
}
