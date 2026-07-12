/* =========================================================
   inspector.js - clip inspector for chiefmonkey6.glb
   Loads every animation clip and plays them one at a time
   so the operator can flag glitching / limb-through-body /
   foot-through-floor issues. Verdict is stored in localStorage
   and exportable as a plain-text report.
   ========================================================= */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const canvas = document.getElementById('viewport');
const clipList = document.getElementById('clipList');
const clipCount = document.getElementById('clipCount');
const speedInput = document.getElementById('speed');
const speedVal = document.getElementById('speedVal');
const distInput = document.getElementById('dist');
const distVal = document.getElementById('distVal');
const heightInput = document.getElementById('height');
const heightVal = document.getElementById('heightVal');
const yawInput = document.getElementById('yaw');
const yawVal = document.getElementById('yawVal');
const btnKeep = document.getElementById('btnKeep');
const btnFlag = document.getElementById('btnFlag');
const btnExport = document.getElementById('btnExport');
const exportArea = document.getElementById('exportArea');
const toast = document.getElementById('toast');

// ------- verdict store (localStorage-backed) -------
const STORAGE_KEY = 'continuum.clipVerdicts.v1';
const verdicts = (function () {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
  catch { return {}; }
})();
function saveVerdicts() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(verdicts)); } catch {}
}

// ------- toast helper -------
let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

// ------- three.js scene -------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();

// Neutral floor grid for reference lines
const grid = new THREE.GridHelper(20, 20, 0x555577, 0x2a2a3a);
grid.position.y = 0;
scene.add(grid);

// Ambient + key light for even inspection
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.2);
key.position.set(3, 6, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
fill.position.set(-4, 3, -3);
scene.add(fill);

// Small +Z axis marker so orientation is obvious
const axisMarker = new THREE.Mesh(
  new THREE.ConeGeometry(0.08, 0.25, 8),
  new THREE.MeshBasicMaterial({ color: 0xff4488 })
);
axisMarker.position.set(0, 0.15, 1.2);
axisMarker.rotation.x = -Math.PI / 2;
scene.add(axisMarker);

const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);

function resize() {
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(r.width));
  const h = Math.max(1, Math.floor(r.height));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
requestAnimationFrame(resize);

// ------- camera control from sliders -------
let camDist = parseFloat(distInput.value);
let camHeight = parseFloat(heightInput.value);
let camYaw = parseFloat(yawInput.value);
function updateCamera() {
  camera.position.set(
    Math.sin(camYaw) * camDist,
    camHeight,
    Math.cos(camYaw) * camDist
  );
  camera.lookAt(0, 1.2, 0);
}
updateCamera();

distInput.addEventListener('input', () => {
  camDist = parseFloat(distInput.value);
  distVal.textContent = camDist.toFixed(1);
  updateCamera();
});
heightInput.addEventListener('input', () => {
  camHeight = parseFloat(heightInput.value);
  heightVal.textContent = camHeight.toFixed(2);
  updateCamera();
});
yawInput.addEventListener('input', () => {
  camYaw = parseFloat(yawInput.value);
  yawVal.textContent = camYaw.toFixed(2);
  updateCamera();
});

// ------- also allow mouse drag to orbit (feels natural) -------
let dragging = false;
let dragX = 0, dragY = 0;
canvas.addEventListener('mousedown', (e) => {
  dragging = true; dragX = e.clientX; dragY = e.clientY;
});
window.addEventListener('mouseup', () => { dragging = false; });
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - dragX;
  const dy = e.clientY - dragY;
  camYaw = Math.max(-Math.PI, Math.min(Math.PI, camYaw - dx * 0.005));
  camHeight = Math.max(0, Math.min(4, camHeight + dy * 0.01));
  yawInput.value = camYaw;
  heightInput.value = camHeight;
  yawVal.textContent = camYaw.toFixed(2);
  heightVal.textContent = camHeight.toFixed(2);
  updateCamera();
  dragX = e.clientX; dragY = e.clientY;
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  camDist = Math.max(2, Math.min(10, camDist + e.deltaY * 0.005));
  distInput.value = camDist;
  distVal.textContent = camDist.toFixed(1);
  updateCamera();
}, { passive: false });

// ------- load the GLB -------
const draco = new DRACOLoader();
draco.setDecoderPath('../three-libs/draco/');
draco.setDecoderConfig({ type: 'js' });
const loader = new GLTFLoader();
loader.setDRACOLoader(draco);

let mixer = null;
let model = null;
let currentAction = null;
let currentClipName = null;
const actions = new Map();
let currentSpeed = 1;

loader.load(
  '../assets/chiefmonkey6.glb',
  (gltf) => {
    model = gltf.scene;
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });
    model.position.set(0, 0, 0);
    scene.add(model);

    mixer = new THREE.AnimationMixer(model);
    gltf.animations.forEach((clip) => {
      const a = mixer.clipAction(clip);
      a.setLoop(THREE.LoopRepeat, Infinity);
      actions.set(clip.name, { action: a, clip });
    });

    renderClipList(gltf.animations);
    clipCount.textContent = gltf.animations.length + ' clips';

    // Auto-play first clip
    if (gltf.animations.length > 0) {
      playClip(gltf.animations[0].name);
    }
  },
  undefined,
  (err) => {
    console.error('GLB load failed', err);
    showToast('GLB failed to load - check console');
  }
);

function renderClipList(anims) {
  clipList.innerHTML = '';
  anims.forEach((clip, i) => {
    const item = document.createElement('div');
    item.className = 'clip-item';
    item.dataset.clipName = clip.name;
    const num = document.createElement('span');
    num.className = 'clip-num';
    num.textContent = String(i + 1).padStart(2, '0');
    const name = document.createElement('span');
    name.className = 'clip-name';
    name.textContent = clip.name;
    const flag = document.createElement('span');
    flag.className = 'clip-flag';
    updateFlagUI(flag, clip.name);
    item.append(num, name, flag);
    item.addEventListener('click', () => playClip(clip.name));
    clipList.appendChild(item);
  });
}

function updateFlagUI(flagEl, clipName) {
  const v = verdicts[clipName];
  if (v === 'keep') {
    flagEl.textContent = '✓';
    flagEl.className = 'clip-flag ok';
  } else if (v === 'flag') {
    flagEl.textContent = '✗';
    flagEl.className = 'clip-flag';
  } else {
    flagEl.textContent = '';
  }
}

function playClip(name) {
  currentClipName = name;
  const entry = actions.get(name);
  if (!entry) return;

  if (currentAction) currentAction.fadeOut(0.2);
  entry.action.reset().fadeIn(0.2).play();
  entry.action.setEffectiveTimeScale(currentSpeed);
  currentAction = entry.action;

  // Highlight in list
  document.querySelectorAll('.clip-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.clipName === name);
  });
}

speedInput.addEventListener('input', () => {
  currentSpeed = parseFloat(speedInput.value);
  speedVal.textContent = currentSpeed.toFixed(2) + 'x';
  if (currentAction) currentAction.setEffectiveTimeScale(currentSpeed);
});

btnKeep.addEventListener('click', () => {
  if (!currentClipName) return;
  verdicts[currentClipName] = 'keep';
  saveVerdicts();
  const flagEl = document.querySelector(`.clip-item[data-clip-name="${CSS.escape(currentClipName)}"] .clip-flag`);
  if (flagEl) updateFlagUI(flagEl, currentClipName);
  showToast('Kept: ' + currentClipName);
});

btnFlag.addEventListener('click', () => {
  if (!currentClipName) return;
  verdicts[currentClipName] = 'flag';
  saveVerdicts();
  const flagEl = document.querySelector(`.clip-item[data-clip-name="${CSS.escape(currentClipName)}"] .clip-flag`);
  if (flagEl) updateFlagUI(flagEl, currentClipName);
  showToast('Flagged: ' + currentClipName);
});

btnExport.addEventListener('click', async () => {
  const names = Array.from(actions.keys());
  const kept = names.filter((n) => verdicts[n] === 'keep');
  const flagged = names.filter((n) => verdicts[n] === 'flag');
  const untouched = names.filter((n) => !verdicts[n]);

  const lines = [];
  lines.push('# Clip audit — chiefmonkey6.glb');
  lines.push('');
  lines.push('## KEEP (' + kept.length + ')');
  kept.forEach((n) => lines.push('- ' + n));
  lines.push('');
  lines.push('## FLAG (' + flagged.length + ')');
  flagged.forEach((n) => lines.push('- ' + n));
  lines.push('');
  lines.push('## Not audited (' + untouched.length + ')');
  untouched.forEach((n) => lines.push('- ' + n));

  const text = lines.join('\n');
  exportArea.textContent = text;
  exportArea.style.display = 'block';

  try {
    await navigator.clipboard.writeText(text);
    showToast('Report copied to clipboard');
  } catch {
    showToast('Copy failed — select the text below and copy manually');
  }
});

// ------- main render loop -------
const clock = new THREE.Clock();
function loop() {
  const dt = clock.getDelta();
  if (mixer) mixer.update(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
loop();
