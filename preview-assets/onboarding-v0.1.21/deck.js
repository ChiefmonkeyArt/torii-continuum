/* =========================================================
   deck.js — panel choreography + step dots + nav
   ========================================================= */

(() => {
  const TOTAL_STEPS = 5;
  const CURTAIN_STEP = 6;

  const deck = document.getElementById('panelDeck');
  const panels = Array.from(deck.querySelectorAll('.panel'));
  const dots = Array.from(document.querySelectorAll('.step-dot'));
  const scenes = Array.from(document.querySelectorAll('.stage .scene'));
  const navBack = document.getElementById('navBack');
  const navForward = document.getElementById('navForward');
  const skipBtn = document.getElementById('skipBtn');

  let current = 1;
  let inFlight = false;

  function go(next) {
    if (inFlight) return;
    if (next < 1 || next > CURTAIN_STEP) return;
    if (next === current) return;

    inFlight = true;
    const forward = next > current;

    const curPanel = panels[current - 1];
    const nextPanel = panels[next - 1];

    // Move current out
    curPanel.classList.remove('panel-current');
    curPanel.classList.add(forward ? 'panel-exit-left' : 'panel-exit-right');

    // Reset next panel's baseline before showing
    nextPanel.classList.remove('panel-exit-left', 'panel-exit-right');
    // Force a reflow so the transition triggers
    void nextPanel.offsetHeight;
    nextPanel.classList.add('panel-current');

    // Update backdrop
    scenes.forEach((s, i) => s.classList.toggle('active', i === Math.min(next, TOTAL_STEPS) - 1));

    // Update dots
    dots.forEach((d, i) => {
      const step = i + 1;
      d.classList.remove('active', 'done');
      if (step <= Math.min(next, TOTAL_STEPS + 1)) {
        if (step === next && next <= TOTAL_STEPS) d.classList.add('active');
        else if (step < next) d.classList.add('done');
      }
    });
    if (next > TOTAL_STEPS) {
      dots.forEach(d => { d.classList.remove('active'); d.classList.add('done'); });
    }

    // Nav button state
    navBack.disabled = next <= 1 || next > TOTAL_STEPS;
    navForward.disabled = next > TOTAL_STEPS;

    // FE-11: the incoming panel is the ONLY interactive one — every other panel
    // (including the just-left outgoing panel) becomes inert/unreachable so Tab
    // and assistive tech can't land on hidden payment/key controls. Focus moves
    // to the new panel's heading so keyboard users arrive on the right step.
    applyPanelReachability(next);
    const heading = nextPanel.querySelector('.panel-title');
    if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }

    // Broadcast so character.js can switch animations
    window.dispatchEvent(new CustomEvent('onboarding:step', {
      detail: { step: next, forward, previous: current }
    }));

    current = next;
    setTimeout(() => { inFlight = false; }, 500);

    // Curtain navigation is owned by onboarding-client.js (initCurtain): it
    // listens for this same onboarding:step broadcast, resolves the real
    // same-origin Continuum destination, navigates deterministically, and shows
    // a fallback "Open Continuum now" link. Deck.js only drives the panels.
  }

  // FE-11: make exactly one panel reachable. Non-active panels get `inert` (no
  // keyboard focus, no pointer interaction, hidden from the accessibility tree)
  // plus `aria-hidden`, while the active panel is re-exposed. We deliberately do
  // NOT toggle display/visibility — that would kill the outgoing panel's
  // transition animation. Called on every step change and on restored load.
  function applyPanelReachability(activeStep) {
    panels.forEach((p, i) => {
      const isActive = (i + 1) === activeStep;
      p.inert = !isActive;
      if (isActive) p.removeAttribute('aria-hidden');
      else p.setAttribute('aria-hidden', 'true');
    });
  }

  // Wire per-panel "advance" buttons
  deck.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-advance]');
    if (btn) go(current + 1);
  });

  navForward.addEventListener('click', () => go(current + 1));
  navBack.addEventListener('click', () => go(current - 1));
  skipBtn.addEventListener('click', () => go(CURTAIN_STEP));

  // onboarding-client.js drives step 1 via the live agent API and asks the
  // deck to advance only after a verified signature (not on a raw click).
  window.addEventListener('onboarding:advance', (e) => {
    const from = e.detail?.from;
    if (from === undefined || from === current) go(current + 1);
  });

  // Allow clicking dots to jump (nice for demo purposes)
  dots.forEach(d => d.addEventListener('click', () => {
    const target = Number(d.dataset.step);
    if (target && target !== current) go(target);
  }));

  // Keyboard nav
  window.addEventListener('keydown', (e) => {
    // FE-11: never let deck navigation fire while the operator is editing a form
    // control or composing text — Enter/arrows there belong to the field.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.isComposing) return;
    if (e.key === 'ArrowRight' || e.key === 'Enter') go(current + 1);
    if (e.key === 'ArrowLeft')  go(current - 1);
    if (e.key === 'Escape')     go(CURTAIN_STEP);
  });

  // Initial state. onboarding-client.js sets window.__toriiRestoredStep when a
  // still-valid session survived a page reload; when present we open directly
  // on that step (no animation, no step-1 flash) instead of starting at 1. If
  // onboarding-client.js instead ran first and its dispatch was missed, the
  // same event path (onboarding:advance) still advances us once this listener
  // is live — the two mechanisms together are order-independent.
  const restored = Number(window.__toriiRestoredStep);
  const start = (restored >= 2 && restored <= TOTAL_STEPS) ? restored : 1;
  if (start !== 1) {
    panels[0].classList.remove('panel-current');
    panels[start - 1].classList.add('panel-current');
    scenes.forEach((s, i) => s.classList.toggle('active', i === Math.min(start, TOTAL_STEPS) - 1));
    dots.forEach((d, i) => {
      const step = i + 1;
      d.classList.remove('active', 'done');
      if (step < start) d.classList.add('done');
      else if (step === start) d.classList.add('active');
    });
    current = start;
  }
  // FE-11: reachability must hold on the default path too — on a fresh load
  // (start === 1) panels 2..6 would otherwise stay Tab-focusable.
  applyPanelReachability(current);
  navBack.disabled = current <= 1;
  navForward.disabled = current > TOTAL_STEPS;
  window.dispatchEvent(new CustomEvent('onboarding:step', {
    detail: { step: current, forward: true, previous: 0 }
  }));
})();
