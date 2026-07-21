/**
 * Sats-burst celebration (v0.2.89-alpha, Item 4).
 *
 * Fired on a successful Lightning top-up mint (toPaid) and the NWC invoice-settled
 * path — never the paste-a-token flow, which has its own confirmation. Three
 * pieces: a canvas ⚡ burst from the QR centre, a balance-number tween, and a
 * floating "+N sats" chip. Zero deps: canvas + requestAnimationFrame + inline CSS.
 *
 * Honours prefers-reduced-motion: reduce → a single 200ms flash on the balance
 * card plus a static "+N sats" that fades over 800ms.
 *
 * Everything is dependency-injectable (raf, cancelRaf, now, setTimeout,
 * reducedMotion, matchMedia) so the effect is deterministically testable under
 * the repo's node-env vitest with no jsdom.
 */

const PALETTE = ['hsl(45, 100%, 55%)', 'hsl(30, 100%, 60%)', 'hsl(50, 95%, 65%)'];
const GLYPH_COUNT = 40;
const GRAVITY = 400;      // px/s²
const SPEED_MIN = 200;    // px/s
const SPEED_MAX = 500;    // px/s
const BURST_MS = 1400;
const TWEEN_MS = 1000;
const CHIP_MS = 1400;
const REDUCED_FLASH_MS = 200;
const REDUCED_CHIP_MS = 800;

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

function resolveDeps(opts) {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  return {
    now: opts.now || (() => (g.performance && g.performance.now ? g.performance.now() : Date.now())),
    raf: opts.raf || (g.requestAnimationFrame ? g.requestAnimationFrame.bind(g) : (cb) => g.setTimeout(() => cb(Date.now()), 16)),
    cancelRaf: opts.cancelRaf || (g.cancelAnimationFrame ? g.cancelAnimationFrame.bind(g) : g.clearTimeout && g.clearTimeout.bind(g)) || (() => {}),
    setTimeout: opts.setTimeout || (g.setTimeout ? g.setTimeout.bind(g) : (fn) => fn()),
    reducedMotion: opts.reducedMotion,
    matchMedia: opts.matchMedia || g.matchMedia,
  };
}

function prefersReduced(deps) {
  if (typeof deps.reducedMotion === 'boolean') return deps.reducedMotion;
  try {
    return !!(deps.matchMedia && deps.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (_e) { return false; }
}

function tweenBalance({ balanceEl, from, to, fmt, deps }) {
  if (!balanceEl) return;
  if (typeof from !== 'number' || typeof to !== 'number' || from === to) {
    balanceEl.textContent = fmt(to);
    return;
  }
  const start = deps.now();
  const step = (t) => {
    const elapsed = (typeof t === 'number' ? t : deps.now()) - start;
    const p = Math.min(1, elapsed / TWEEN_MS);
    balanceEl.textContent = fmt(Math.round(from + (to - from) * easeOutCubic(p)));
    if (p < 1) deps.raf(step);
    else balanceEl.textContent = fmt(to);
  };
  deps.raf(step);
}

function spawnChip({ card, amt, fmt, deps, reduced }) {
  if (!card || typeof document === 'undefined') return null;
  const chip = document.createElement('div');
  chip.className = 'sats-burst-chip';
  chip.textContent = `+${fmt(amt)} sats`;
  chip.style.cssText = [
    'position: absolute', 'left: 50%', 'bottom: 8px', 'transform: translateX(-50%)',
    'padding: 4px 10px', 'border-radius: 999px', 'font-size: 12px', 'font-weight: 600',
    'background: hsl(45, 100%, 55%)', 'color: #1a1a1a', 'box-shadow: 0 4px 12px rgba(0,0,0,0.35)',
    'pointer-events: none', 'z-index: 30', 'opacity: 1',
    `transition: opacity ${reduced ? REDUCED_CHIP_MS : CHIP_MS}ms ease, transform ${CHIP_MS}ms ease`,
  ].join('; ');
  card.appendChild(chip);
  deps.raf(() => {
    chip.style.opacity = '0';
    if (!reduced) chip.style.transform = 'translate(-50%, -40px)';
  });
  deps.setTimeout(() => { if (chip.parentNode) chip.parentNode.removeChild(chip); }, reduced ? REDUCED_CHIP_MS : CHIP_MS);
  return chip;
}

function spawnBurst({ modalBody, origin, deps }) {
  if (!modalBody || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.className = 'sats-burst-canvas';
  const w = modalBody.clientWidth || 320;
  const hpx = modalBody.clientHeight || 320;
  canvas.width = w; canvas.height = hpx;
  canvas.style.cssText = 'position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 20;';
  modalBody.appendChild(canvas);

  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  const cx = origin && Number.isFinite(origin.x) ? origin.x : w / 2;
  const cy = origin && Number.isFinite(origin.y) ? origin.y : hpx / 2;

  const parts = Array.from({ length: GLYPH_COUNT }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN);
    return {
      x: cx, y: cy,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      rot: Math.random() * Math.PI * 2, vrot: (Math.random() - 0.5) * 8,
      color: PALETTE[(Math.random() * PALETTE.length) | 0],
      size: 14 + Math.random() * 10,
    };
  });

  const start = deps.now();
  let last = start;
  let handle = null;
  const done = () => { if (canvas.parentNode) canvas.parentNode.removeChild(canvas); };

  const frame = (t) => {
    const nowT = typeof t === 'number' ? t : deps.now();
    const elapsed = nowT - start;
    const dt = Math.min(0.05, Math.max(0, (nowT - last) / 1000));
    last = nowT;
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const alpha = Math.max(0, 1 - elapsed / BURST_MS);
      for (const p of parts) {
        p.vy += GRAVITY * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vrot * dt;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.font = `${p.size}px sans-serif`;
        ctx.fillStyle = p.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚡', 0, 0);
        ctx.restore();
      }
    }
    if (elapsed >= BURST_MS) { done(); return; }
    handle = deps.raf(frame);
  };
  handle = deps.raf(frame);

  return { canvas, cancel() { deps.cancelRaf(handle); done(); } };
}

// Public entry. opts: { modalBody, origin:{x,y}, balanceEl, card, from, to,
// amountSats, formatSats, + injectable deps }. Returns a small handle describing
// what ran ({ reduced, canvas?, chip?, cancel? }).
export function satsBurst(opts = {}) {
  const deps = resolveDeps(opts);
  const fmt = opts.formatSats || ((n) => String(Math.round(n)));
  const { modalBody = null, origin = null, balanceEl = null, card = null, from = 0, to = 0 } = opts;
  const amt = Number.isFinite(opts.amountSats) ? opts.amountSats : Math.max(0, Math.round((to || 0) - (from || 0)));

  if (prefersReduced(deps)) {
    if (balanceEl) balanceEl.textContent = fmt(to);
    if (card) {
      const prev = card.style.transition;
      card.style.transition = `opacity ${REDUCED_FLASH_MS}ms ease`;
      card.style.opacity = '0.4';
      deps.setTimeout(() => { card.style.opacity = '1'; card.style.transition = prev || ''; }, REDUCED_FLASH_MS);
    }
    const chip = spawnChip({ card, amt, fmt, deps, reduced: true });
    return { reduced: true, chip };
  }

  tweenBalance({ balanceEl, from, to, fmt, deps });
  const chip = spawnChip({ card, amt, fmt, deps, reduced: false });
  const burst = spawnBurst({ modalBody, origin, deps });
  return { reduced: false, canvas: burst && burst.canvas, chip, cancel: burst && burst.cancel };
}
