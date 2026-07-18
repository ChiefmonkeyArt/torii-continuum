/**
 * Pure geometry helpers for the floating chat composer (UI-COMPOSER-1).
 *
 * Kept DOM-free so they can be unit-tested without jsdom (the repo's test
 * convention) and reused by chat.js for auto-grow + reserved-space math.
 */

// Composer textarea bounds, in px. Below the min it holds a single comfortable
// line; at the max it stops growing and scrolls internally instead.
export const CHAT_INPUT_MIN = 40;
export const CHAT_INPUT_MAX = 160;

// Gap (px) left between the floating dock and the content it hovers over. Also
// the extra breathing room folded into the reserved bottom space so the last
// line of content never tucks under the composer.
export const CHAT_FLOAT_GAP = 16;

/**
 * Auto-grow height for the textarea: grow with content up to CHAT_INPUT_MAX,
 * never below CHAT_INPUT_MIN. Returns an integer px value.
 */
export function clampInputHeight(scrollHeight, min = CHAT_INPUT_MIN, max = CHAT_INPUT_MAX) {
  const raw = Math.ceil(Number(scrollHeight) || 0);
  return Math.max(min, Math.min(max, raw));
}

/**
 * Once content exceeds the max height the textarea must scroll internally
 * rather than push the dock taller. Drives overflow-y on the input.
 */
export function inputShouldScroll(scrollHeight, max = CHAT_INPUT_MAX) {
  return (Math.ceil(Number(scrollHeight) || 0)) > max;
}

/**
 * Bottom space (px) the content scroller must reserve so the floating dock
 * never obscures content: the dock's own height plus the float gap. Zero when
 * the dock has no measurable height (e.g. not yet laid out) so we fall back to
 * the CSS default instead of clamping content to nothing.
 */
export function reserveSpaceFor(dockHeight, gap = CHAT_FLOAT_GAP) {
  const h = Math.round(Number(dockHeight) || 0);
  return h > 0 ? h + gap : 0;
}
