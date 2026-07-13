/* =========================================================
   character.js — live Three.js render of chiefmonkey6.glb
   per-step animation + camera framing shifts
   ========================================================= */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { nextLoadAttempt } from './onboarding-client.js';

const canvas = document.getElementById('character');

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

// Per-step framing: mapped to the narrative beats.
// pos = camera position, look = target, anim = clip name, tilt = char yaw
const STEP_FRAMES = {
  1: { // Arrival — wide, waist-up, greeting
    camPos: [0.4, 1.55, 3.6],
    camLook: [0, 1.3, 0],
    anim: 'Idle_03',
    yaw: 0.15,
    charY: 0,
  },
  2: { // Preparation — medium-wide, girding for the journey
    camPos: [0.4, 1.55, 3.5],
    camLook: [0, 1.3, 0],
    anim: 'Idle_03',
    yaw: -0.2,
    charY: 0,
  },
  3: { // Connection — turning toward the gate, walking in place
    camPos: [0.5, 1.35, 2.6],
    camLook: [0, 1.1, 0],
    anim: 'Stylish_Walk_inplace',
    yaw: 0.35,
    charY: 0,
  },
  4: { // Introduction — close, face forward, speaking
    camPos: [0.15, 1.6, 2.2],
    camLook: [0, 1.5, 0],
    anim: 'Idle_03',
    yaw: 0,
    charY: 0,
  },
  5: { // Departure — wide again, sweep to the world
    camPos: [0.6, 1.7, 3.9],
    camLook: [0.1, 1.35, 0],
    anim: 'Walking',
    yaw: -0.25,
    charY: 0,
  },
  6: { // Curtain — fade the character
    camPos: [0.6, 1.7, 4.5],
    camLook: [0, 1.35, 0],
    anim: 'FunnyDancing_02',
    yaw: 0,
    charY: 0,
  },
};

// Mobile-portrait framing: camera pulled back (z) and raised (y) so
// Chiefmonkey sits visible above the ~62vh frosted bottom sheet, and
// camLook is raised so we frame his head/torso, not his feet.
// Same anim + yaw as desktop, only the camera geometry changes.
const STEP_FRAMES_MOBILE = {
  1: {
    camPos: [0.4, 1.85, 5.2],
    camLook: [0, 1.7, 0],
    anim: 'Idle_03',
    yaw: 0.15,
    charY: 0,
  },
  2: {
    camPos: [0.4, 1.85, 5.1],
    camLook: [0, 1.7, 0],
    anim: 'Idle_03',
    yaw: -0.2,
    charY: 0,
  },
  3: {
    camPos: [0.5, 1.65, 4.2],
    camLook: [0, 1.5, 0],
    anim: 'Stylish_Walk_inplace',
    yaw: 0.35,
    charY: 0,
  },
  4: {
    camPos: [0.15, 1.9, 3.8],
    camLook: [0, 1.9, 0],
    anim: 'Idle_03',
    yaw: 0,
    charY: 0,
  },
  5: {
    camPos: [0.6, 2.0, 5.5],
    camLook: [0.1, 1.75, 0],
    anim: 'Walking',
    yaw: -0.25,
    charY: 0,
  },
  6: {
    camPos: [0.6, 2.0, 6.1],
    camLook: [0, 1.75, 0],
    anim: 'FunnyDancing_02',
    yaw: 0,
    charY: 0,
  },
};

let mixer = null;
let model = null;
let currentAction = null;
const actions = new Map();

const draco = new DRACOLoader();
// Self-hosted Draco decoder — no third-party CDN. Ships from Torii itself in production.
draco.setDecoderPath('./three-libs/draco/');
// v0.1.10: switched from 'js' to 'wasm'. The JS decoder is 3-10x slower for
// skinned meshes; the wasm decoder ships alongside (draco_decoder.wasm) and
// is pre-warmed by the <link rel=preload> in index.html. This alone accounts
// for most of the "Chiefmonkey appears 10s after scene" delay.
draco.setDecoderConfig({ type: 'wasm' });
// Pre-instantiate the wasm decoder before we start streaming the GLB so
// decode can begin the instant the arraybuffer arrives.
draco.preload();
const loader = new GLTFLoader();
loader.setDRACOLoader(draco);
const GLB_URL = './assets/chiefmonkey6.glb';
// v0.1.11: watchdog for a *stalled* load (preload cache mismatch, network
// hiccup, decoder init failure). v0.1.14: the same one-shot retry now also
// covers a *hard error*. On reload the preloaded same-origin fetch could not
// only stall but error out; the old onErr just hid the canvas and gave up, so
// Chiefmonkey never reappeared. Both failure modes now route through the pure
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
  canvas.style.opacity = '0';
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
    // Baseline placement. v0.1.7: character now sits at world x = CHAR_X_DESKTOP
    // (negative) so a full-viewport canvas frames him in the left third instead
    // of centered. Mobile keeps him centered (bottom sheet covers UI).
    // The value is re-applied on resize() when portrait <-> landscape swaps.
    model.position.set(isPortrait() ? 0 : CHAR_X_DESKTOP, 0, 0);
    model.rotation.y = 0.15;
    scene.add(model);

    // Set up animation mixer with all clips
    mixer = new THREE.AnimationMixer(model);
    gltf.animations.forEach((clip) => {
      const a = mixer.clipAction(clip);
      a.setLoop(THREE.LoopRepeat, Infinity);
      actions.set(clip.name, a);
    });

    // Apply initial step
    applyStep(1);

  // v0.1.10: precompile shaders and warm up GPU pipelines BEFORE fade-in.
    // Without this, the first render after model add causes a stall while
    // WebGL compiles skinning shaders - shows up as "character pops in then
    // freezes". compile() runs synchronously here so by the time we start
    // the fade the render loop is ready.
    try { renderer.compile(scene, camera); } catch (_) { /* older three fallback */ }

  // Fade in canvas once model is ready. Shortened 900ms -> 400ms so the
  // character is visually present sooner after the fetch/decode window.
  canvas.style.transition = 'opacity 400ms ease-out';
  canvas.style.opacity = '1';
}
function onErr(err) {
  console.error('[character] GLB failed to load', err);
  handleFailure('error');
}
startLoad(GLB_URL);

canvas.style.opacity = '0';

// Tracks the active step at module scope so resize()/orientationchange
// can re-apply the correct framing without needing the caller to resend it.
let currentStep = 1;

function applyStep(step) {
  currentStep = step;
  const frameSet = isPortrait() ? STEP_FRAMES_MOBILE : STEP_FRAMES;
  const frame = frameSet[step] || frameSet[1];

  // Camera easing to new position
  animateVec3(camera.position, frame.camPos, 900);
  animateLookAt(camera, frame.camLook, 900);

  // Character rotation
  if (model) animateNumber(model.rotation, 'y', frame.yaw, 900);

  // Crossfade animation
  const nextAction = actions.get(frame.anim);
  if (nextAction && nextAction !== currentAction) {
    if (currentAction) {
      currentAction.fadeOut(0.4);
    }
    nextAction.reset().fadeIn(0.4).play();
    currentAction = nextAction;
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
  applyStep(e.detail.step);
});

// Step-1 auth phases (onboarding-client.js): HandGesture_00 while
// prompting/signing, Idle_03 on success, Confused_02 on failure. The GLB
// may not ship every requested clip, so each phase carries an ordered
// fallback list of clips that DO exist; if none are present we keep the
// current animation (graceful fallback — never freeze or throw).
const PHASE_CLIPS = {
  prompting: ['HandGesture_00', 'idle_to_push_up', 'Idle_03'],
  success: ['Idle_03'],
  failure: ['Confused_02', 'Hit_Reaction_to_Waist', 'Knock_Down'],
};
function playPhaseClip(phase) {
  const candidates = PHASE_CLIPS[phase];
  if (!candidates) return;
  let nextAction = null;
  for (const name of candidates) {
    const a = actions.get(name);
    if (a) { nextAction = a; break; }
  }
  if (!nextAction || nextAction === currentAction) return;
  if (currentAction) currentAction.fadeOut(0.3);
  nextAction.reset().fadeIn(0.3).play();
  currentAction = nextAction;
}
window.addEventListener('onboarding:anim', (e) => {
  playPhaseClip(e.detail?.phase);
});

/* Responsive resize */
function resize() {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  // Cap pixel ratio at 2 to avoid overwhelming older phone GPUs; recomputed
  // here so a mid-session orientation change / DPR change stays capped.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // v0.1.7: re-anchor the character's base x when orientation flips so a
  // desktop-to-mobile swap doesn't leave him stranded off-frame.
  if (model) {
    model.position.x = isPortrait() ? 0 : CHAR_X_DESKTOP;
  }
  // Re-apply the current step so orientation changes (landscape <-> portrait)
  // immediately reflow the camera framing instead of sticking to the old one.
  applyStep(currentStep);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);
// iOS Safari/Brave: the initial resize can run before the canvas has a real
// height (safe-area / URL bar animation not settled yet), so defer the first
// resize + apply to the next animation frame.
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
