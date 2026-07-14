/* =========================================================
   character.js — live Three.js render of chiefmonkey-onboarding.glb

   Per-step camera framing + a dedicated, forbidden-safe animation state
   machine (v0.1.17):

     - Each onboarding step gets ONE dedicated, loop-friendly clip that
       plays deterministically on entering/restoring the step (STEP_CLIPS
       / selectStepClip in onboarding-client.js). Camera geometry per step
       lives here; the clip choice is a single source of truth shared with
       the build pipeline and the tests.
     - Clicking directly on Chiefmonkey (raycast hit-test, NOT arbitrary
       page clicks, and never stealing a click from a UI control) plays one
       random one-shot from a curated pool, then crossfades back to the
       current step's dedicated clip. Respects prefers-reduced-motion and
       ignores click-spam while a reaction is active.
     - Step-1 auth phases (prompting/success/failure) are transient
       overrides that always resolve back to the current step's clip, so an
       async auth/wallet/Routstr outcome or the character load order can
       never race or permanently overwrite the live step state.
     - Locomotion / knock-down clips can never be selected — the production
       GLB has them dropped at build time AND every runtime pool is filtered
       through the shared isForbiddenClip predicate as defence in depth.
   ========================================================= */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import {
  nextLoadAttempt,
  createCharacterSync,
  recordStep,
  resolveReadyStep,
  markCharacterFailed,
  selectStepClip,
  selectAnimation,
  pickClickReaction,
  shouldReactToClick,
  IDLE_CLIP,
} from './onboarding-client.js';

const canvas = document.getElementById('character');

// v0.1.15: single source of truth for the character↔deck step race. Any
// onboarding:step that arrives before the GLB is ready is remembered here and
// applied the instant the model loads (see onLoaded), so a restored middle
// step and its dedicated clip are never dropped regardless of load ordering.
const sync = createCharacterSync();

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  powerPreference: 'high-performance',
});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();

// Warm rim + amber key light matches painterly backdrops
const key = new THREE.DirectionalLight(0xffcc88, 2.6);
key.position.set(-2, 3, 4);
scene.add(key);

const rim = new THREE.DirectionalLight(0xff8844, 1.4);
rim.position.set(4, 2, -3);
scene.add(rim);

const fill = new THREE.HemisphereLight(0xffe4b8, 0x1a1208, 0.75);
scene.add(fill);

// Ground shadow disc — soft amber puddle under character
const shadowMat = new THREE.MeshBasicMaterial({
  color: 0x000000,
  transparent: true,
  opacity: 0.35,
});
const shadowGeo = new THREE.CircleGeometry(0.6, 32);
const groundShadow = new THREE.Mesh(shadowGeo, shadowMat);
groundShadow.rotation.x = -Math.PI / 2;
groundShadow.position.y = 0.01;
scene.add(groundShadow);

const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);

// Returns true when the viewport is taller than wide (mobile portrait).
function isPortrait() {
  return window.innerHeight > window.innerWidth;
}

// v0.1.7: world-space x offset for the character on desktop. Canvas is
// now 100vw, so we shift Chiefmonkey left of world-origin to keep him
// framed in the left third with the panel on the right. Mobile keeps 0.
const CHAR_X_DESKTOP = -0.5;

// Per-step CAMERA framing only (pos = camera position, look = target,
// yaw = char rotation). The clip for each step is resolved from STEP_CLIPS
// via selectStepClip() against the clips the GLB actually ships — the anim
// name is NOT hard-coded here so the build asset and the runtime can never
// disagree, and a forbidden locomotion clip can never sneak into a step.
const STEP_FRAMES = {
  1: { camPos: [0.4, 1.55, 3.6], camLook: [0, 1.3, 0], yaw: 0.15, charY: 0 },   // Verify — greeting/explaining
  2: { camPos: [0.4, 1.55, 3.5], camLook: [0, 1.3, 0], yaw: -0.2, charY: 0 },   // Wallet — assent
  3: { camPos: [0.5, 1.35, 2.6], camLook: [0, 1.1, 0], yaw: 0.35, charY: 0 },   // Routstr — network of minds
  4: { camPos: [0.15, 1.6, 2.2], camLook: [0, 1.5, 0], yaw: 0, charY: 0 },      // Welcome — bow, face forward
  5: { camPos: [0.6, 1.7, 3.9], camLook: [0.1, 1.35, 0], yaw: -0.25, charY: 0 }, // Recovery kit — calm settle
  6: { camPos: [0.6, 1.7, 4.5], camLook: [0, 1.35, 0], yaw: 0, charY: 0 },      // Curtain — celebration
};

// Mobile-portrait framing: camera pulled back (z) and raised (y) so
// Chiefmonkey sits visible above the ~62vh frosted bottom sheet, and
// camLook is raised so we frame his head/torso, not his feet. Same yaw as
// desktop, only the camera geometry changes; clip is shared (selectStepClip).
const STEP_FRAMES_MOBILE = {
  1: { camPos: [0.4, 1.85, 5.2], camLook: [0, 1.7, 0], yaw: 0.15, charY: 0 },
  2: { camPos: [0.4, 1.85, 5.1], camLook: [0, 1.7, 0], yaw: -0.2, charY: 0 },
  3: { camPos: [0.5, 1.65, 4.2], camLook: [0, 1.5, 0], yaw: 0.35, charY: 0 },
  4: { camPos: [0.15, 1.9, 3.8], camLook: [0, 1.9, 0], yaw: 0, charY: 0 },
  5: { camPos: [0.6, 2.0, 5.5], camLook: [0.1, 1.75, 0], yaw: -0.25, charY: 0 },
  6: { camPos: [0.6, 2.0, 6.1], camLook: [0, 1.75, 0], yaw: 0, charY: 0 },
};

let mixer = null;
let model = null;
let currentAction = null;
const actions = new Map();
// Clip names the loaded GLB actually ships — used to resolve every step /
// phase / click clip against reality (and, via the shared filter, to keep
// forbidden clips unselectable even if the asset ever regresses).
let availableClips = new Set();

const raycaster = new THREE.Raycaster();

// prefers-reduced-motion: no click reactions when the operator opts out.
const reduceMq = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;
let reducedMotion = !!(reduceMq && reduceMq.matches);
if (reduceMq && reduceMq.addEventListener) {
  reduceMq.addEventListener('change', (e) => { reducedMotion = e.matches; });
}

const draco = new DRACOLoader();
// Self-hosted Draco decoder — no third-party CDN. Ships from Torii itself in production.
draco.setDecoderPath('./three-libs/draco/');
// v0.1.10: switched from 'js' to 'wasm'. The JS decoder is 3-10x slower for
// skinned meshes; the wasm decoder ships alongside (draco_decoder.wasm) and
// is pre-warmed by the <link rel=preload> in index.html.
draco.setDecoderConfig({ type: 'wasm' });
// Pre-instantiate the wasm decoder before we start streaming the GLB so
// decode can begin the instant the arraybuffer arrives.
draco.preload();
const loader = new GLTFLoader();
loader.setDRACOLoader(draco);
const GLB_URL = './assets/chiefmonkey-onboarding.glb';
// v0.1.11: watchdog for a *stalled* load (preload cache mismatch, network
// hiccup, decoder init failure). v0.1.14: the same one-shot retry now also
// covers a *hard error*. Both failure modes route through the pure
// nextLoadAttempt() policy: first failure → one cache-busting retry, second →
// give up. The preload hints are untouched (v0.1.11 no-crossorigin fix kept).
const _load = { loaded: false, retried: false };
let _stallTimer = null;

function startLoad(url) {
  clearTimeout(_stallTimer);
  _stallTimer = setTimeout(() => handleFailure('stall'), 8000);
  loader.load(url, onLoaded, undefined, onErr);
}

function handleFailure(event) {
  const decision = nextLoadAttempt(_load, event);
  if (decision.action === 'ignore') return;
  clearTimeout(_stallTimer);
  _stallTimer = null;
  if (decision.action === 'retry') {
    _load.retried = true;
    console.warn(`[character] GLB ${event}, retrying with cache-bust`);
    startLoad(GLB_URL + (decision.bustCache ? '?r=' + Date.now() : ''));
    return;
  }
  // give-up: nothing more to try; leave the stage empty rather than loop.
  // v0.1.15: publish a terminal state + event so the rest of the page can
  // stop waiting on a character that will never arrive (and tests can assert
  // the give-up branch deterministically).
  markCharacterFailed(sync);
  canvas.style.opacity = '0';
  window.__toriiCharacterFailed = true;
  window.dispatchEvent(new CustomEvent('onboarding:model-error', { detail: { event } }));
}

function onLoaded(gltf) {
  _load.loaded = true;
  clearTimeout(_stallTimer);
  _stallTimer = null;

  model = gltf.scene;
  // Opaque material patch (v0.1.5) - matches torii-quest src/napNpc.js.
  // Without this the GLB's alphaMode:BLEND makes the skinned mesh split
  // and disintegrate. frustumCulled=false so bones leaving initial bbox
  // don't cull the whole mesh mid-animation.
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = false;
      o.frustumCulled = false;
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          m.transparent = false;
          m.depthWrite = true;
          m.alphaTest = 0;
          m.envMapIntensity = 0.7;
          m.needsUpdate = true;
        }
      }
    }
  });
  // Baseline placement. v0.1.7: character sits at world x = CHAR_X_DESKTOP
  // (negative) on desktop so a full-viewport canvas frames him in the left
  // third; mobile keeps him centered. Re-applied on resize().
  model.position.set(isPortrait() ? 0 : CHAR_X_DESKTOP, 0, 0);
  model.rotation.y = 0.15;
  scene.add(model);

  // Set up animation mixer with all clips, and record what the GLB ships so
  // every step / phase / click choice is resolved against reality.
  mixer = new THREE.AnimationMixer(model);
  availableClips = new Set();
  gltf.animations.forEach((clip) => {
    const a = mixer.clipAction(clip);
    a.setLoop(THREE.LoopRepeat, Infinity);
    actions.set(clip.name, a);
    availableClips.add(clip.name);
  });

  // A finished one-shot (click reaction or success/failure phase) settles back
  // into whatever the CURRENT step's dedicated clip is now — so a reaction that
  // overlapped a step change returns to the new step, never the old one.
  mixer.addEventListener('finished', (e) => {
    if (e.action === currentAction && !playingLoop) {
      reactionActive = false;
      playStepLoop(currentStepClip || IDLE_CLIP);
    }
  });

  // v0.1.15: apply the step the deck actually wants, not a hard-coded 1.
  // resolveReadyStep honours any onboarding:step already broadcast (deck ran
  // first) and otherwise falls back to a restored session step read *now* from
  // window.__toriiRestoredStep (deck ran after / its event was missed), so a
  // refresh into a middle step lands there rather than reverting to step 1.
  const readyStep = resolveReadyStep(sync, window.__toriiRestoredStep);
  applyStep(readyStep);

  // v0.1.10: precompile shaders and warm up GPU pipelines BEFORE fade-in.
  try { renderer.compile(scene, camera); } catch (_) { /* older three fallback */ }

  // Fade in canvas once model is ready.
  canvas.style.transition = 'opacity 400ms ease-out';
  canvas.style.opacity = '1';

  // v0.1.15: announce readiness so any listener no longer has to poll, and so
  // a step broadcast that arrives *after* this point applies immediately via
  // the onboarding:step handler (sync.ready is now true).
  window.__toriiCharacterReady = true;
  window.dispatchEvent(new CustomEvent('onboarding:model-loaded', { detail: { step: readyStep } }));
}
function onErr(err) {
  console.error('[character] GLB failed to load', err);
  handleFailure('error');
}
// v0.1.15: hide the canvas BEFORE kicking off the async load so the initial
// hidden→fade-in transition is deterministic.
canvas.style.opacity = '0';

startLoad(GLB_URL);

// ─── Animation state machine ────────────────────────────────────────
// currentStep      - the active deck step (drives camera + dedicated clip)
// currentStepClip  - the dedicated clip name resolved for currentStep
// reactionActive   - a transient override (click reaction or auth phase) owns
//                    the character right now; a click-spam is ignored and a
//                    step change won't clobber a one-shot mid-play
// playingLoop      - whether currentAction is looping (a step/prompting clip)
//                    vs a one-shot (click reaction / success / failure)
// lastReaction     - last click reaction, to avoid an immediate repeat
const FADE = 0.4;
let currentStep = 1;
let currentStepClip = null;
let reactionActive = false;
let playingLoop = false;
let playingName = null;
let lastReaction = null;

// Crossfade to `name`, either looping or one-shot. No-op when already playing
// that exact clip in the same mode (so a resize/re-apply never hitches).
function crossTo(name, loop) {
  const a = actions.get(name);
  if (!a) return false;
  if (a === currentAction && playingName === name && playingLoop === loop && a.isRunning()) {
    return true;
  }
  if (loop) {
    a.setLoop(THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = false;
  } else {
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
  }
  const hadCurrent = !!currentAction;
  if (currentAction && currentAction !== a) currentAction.fadeOut(FADE);
  a.reset().fadeIn(hadCurrent ? FADE : 0).play();
  currentAction = a;
  playingName = name;
  playingLoop = loop;
  return true;
}

function playStepLoop(name) {
  crossTo(name, true);
}

function applyStep(step) {
  const stepChanged = step !== currentStep;
  currentStep = step;
  const frameSet = isPortrait() ? STEP_FRAMES_MOBILE : STEP_FRAMES;
  const frame = frameSet[step] || frameSet[1];

  // Camera easing to new position (always, even mid-reaction).
  animateVec3(camera.position, frame.camPos, 900);
  animateLookAt(camera, frame.camLook, 900);
  if (model) animateNumber(model.rotation, 'y', frame.yaw, 900);

  // Resolve the dedicated clip against what the GLB actually ships; IDLE_CLIP
  // is the universal floor. selectStepClip already excludes forbidden clips.
  const clip = selectStepClip(step, availableClips) || IDLE_CLIP;
  currentStepClip = clip;

  // Take over the base loop unless a one-shot reaction is mid-play. A looping
  // auth-phase override (prompting) yields to a genuine step change so manual
  // navigation isn't stuck talking, but a mere resize (same step) does not
  // interrupt it. A one-shot reaction is always allowed to finish and will
  // then settle into whatever currentStepClip is by then (see mixer finished).
  const canTakeOver = !reactionActive || (playingLoop && stepChanged);
  if (canTakeOver) {
    reactionActive = false;
    playStepLoop(clip);
  }
}

/* Simple tween helpers */
function animateVec3(target, [x, y, z], dur) {
  const start = { x: target.x, y: target.y, z: target.z };
  const t0 = performance.now();
  function tick() {
    const t = Math.min(1, (performance.now() - t0) / dur);
    const e = 1 - Math.pow(1 - t, 3);
    target.x = start.x + (x - start.x) * e;
    target.y = start.y + (y - start.y) * e;
    target.z = start.z + (z - start.z) * e;
    if (t < 1) requestAnimationFrame(tick);
  }
  tick();
}
function animateLookAt(cam, [x, y, z], dur) {
  const lookTarget = new THREE.Vector3(x, y, z);
  const t0 = performance.now();
  function tick() {
    const t = Math.min(1, (performance.now() - t0) / dur);
    cam.lookAt(lookTarget);
    if (t < 1) requestAnimationFrame(tick);
  }
  tick();
}
function animateNumber(obj, prop, target, dur) {
  const start = obj[prop];
  const t0 = performance.now();
  function tick() {
    const t = Math.min(1, (performance.now() - t0) / dur);
    const e = 1 - Math.pow(1 - t, 3);
    obj[prop] = start + (target - start) * e;
    if (t < 1) requestAnimationFrame(tick);
  }
  tick();
}

/* Listen for step changes */
window.addEventListener('onboarding:step', (e) => {
  // v0.1.15: route through the sync state machine. Before the model is ready
  // the step is only remembered (recordStep → apply:false) and resolveReadyStep
  // replays it on load; once ready it is applied immediately.
  const { apply, step } = recordStep(sync, e.detail?.step);
  if (apply) applyStep(step);
});

// ─── Click reactions (raycast hit-test on the model) ────────────────
// A pointerdown anywhere is hit-tested against the model in NDC space. We must
// NOT rely on the canvas receiving the event (shared.css sets
// #character{pointer-events:none} so panel controls stay clickable), and we
// must NOT steal a click aimed at a UI control. On a genuine model hit we play
// one random one-shot from the curated pool and return to the step clip.
function isUiTarget(target) {
  return !!(target && typeof target.closest === 'function'
    && target.closest('button, input, select, textarea, a, label, [role="button"], [data-advance], [data-step]'));
}

function onPointerDown(e) {
  if (!model || !mixer) return;
  // Spam guard + reduced-motion: cheap early-out before any raycast work.
  if (reactionActive || reducedMotion) return;
  // Never steal a click destined for an interactive control.
  if (isUiTarget(e.target)) return;

  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  if (nx < -1 || nx > 1 || ny < -1 || ny > 1) return; // outside the stage

  raycaster.setFromCamera({ x: nx, y: ny }, camera);
  const hit = raycaster.intersectObject(model, true).length > 0;

  if (!shouldReactToClick({ active: reactionActive, reducedMotion, hit })) return;

  const name = pickClickReaction({ available: availableClips, last: lastReaction });
  if (!name) return;
  lastReaction = name;
  reactionActive = true;
  crossTo(name, false); // one-shot; mixer 'finished' returns to the step clip
}
window.addEventListener('pointerdown', onPointerDown);

// ─── Step-1 auth phase overrides (onboarding-client.js) ─────────────
// prompting loops while we wait for the signer; success/failure are one-shots
// that resolve back to the current step's dedicated clip. All three are
// forbidden-safe and resolved against the GLB via selectAnimation().
function playPhase(phase) {
  const name = selectAnimation(phase, availableClips);
  if (!name) return; // nothing suitable present → keep current (never freeze)
  reactionActive = true;
  // prompting is open-ended (waiting) so it loops; success/failure play once
  // and the mixer 'finished' handler returns us to the current step clip.
  crossTo(name, phase === 'prompting');
}
window.addEventListener('onboarding:anim', (e) => {
  playPhase(e.detail?.phase);
});

/* Responsive resize */
function resize() {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  // Cap pixel ratio at 2 to avoid overwhelming older phone GPUs.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // v0.1.7: re-anchor the character's base x when orientation flips.
  if (model) {
    model.position.x = isPortrait() ? 0 : CHAR_X_DESKTOP;
  }
  // Re-apply the current step so orientation changes reflow the camera framing.
  applyStep(currentStep);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);
// iOS Safari/Brave: the initial resize can run before the canvas has a real
// height, so defer the first resize + apply to the next animation frame.
requestAnimationFrame(resize);

/* Main loop */
const clock = new THREE.Clock();
function loop() {
  const dt = clock.getDelta();
  if (mixer) mixer.update(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
loop();
