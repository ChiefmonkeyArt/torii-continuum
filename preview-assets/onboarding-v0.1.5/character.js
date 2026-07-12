/* =========================================================
   character.js — live Three.js render of chiefmonkey6.glb
   per-step animation + camera framing shifts
   ========================================================= */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

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
draco.setDecoderConfig({ type: 'js' });
const loader = new GLTFLoader();
loader.setDRACOLoader(draco);
loader.load(
  './assets/chiefmonkey6.glb',
  (gltf) => {
    model = gltf.scene;
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
        if (o.material) {
          o.material.envMapIntensity = 0.7;
        }
      }
    });
    // Baseline placement
    model.position.set(0, 0, 0);
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

    // Fade in canvas once model is ready
    canvas.style.transition = 'opacity 900ms ease-out';
    canvas.style.opacity = '1';
  },
  undefined,
  (err) => {
    console.error('[character] GLB failed to load', err);
    canvas.style.opacity = '0';
  }
);

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
