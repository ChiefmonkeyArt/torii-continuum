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
      if (step < Math.min(next, TOTAL_STEPS + 1)) {
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

    // Broadcast so character.js can switch animations
    window.dispatchEvent(new CustomEvent('onboarding:step', {
      detail: { step: next, forward, previous: current }
    }));

    current = next;
    setTimeout(() => { inFlight = false; }, 500);

    // Curtain: after a beat, this would call location.href = '/continuum/home'
    if (next === CURTAIN_STEP) {
      setTimeout(() => {
        // In production: window.location.href = '/continuum/home';
        console.log('[onboarding] curtain complete — would redirect to /continuum/home');
      }, 2400);
    }
  }

  // Wire per-panel "advance" buttons
  deck.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-advance]');
    if (btn) go(current + 1);
  });

  navForward.addEventListener('click', () => go(current + 1));
  navBack.addEventListener('click', () => go(current - 1));
  skipBtn.addEventListener('click', () => go(CURTAIN_STEP));

  // Allow clicking dots to jump (nice for demo purposes)
  dots.forEach(d => d.addEventListener('click', () => {
    const target = Number(d.dataset.step);
    if (target && target !== current) go(target);
  }));

  // Keyboard nav
  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'Enter') go(current + 1);
    if (e.key === 'ArrowLeft')  go(current - 1);
    if (e.key === 'Escape')     go(CURTAIN_STEP);
  });

  // Initial state
  navBack.disabled = true;
  window.dispatchEvent(new CustomEvent('onboarding:step', {
    detail: { step: 1, forward: true, previous: 0 }
  }));
})();
