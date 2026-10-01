/**
 * main.js — scene setup, UI wiring and the rebuild loop.
 *
 * Pipeline (re-run every time a parameter changes):
 *   seed/params -> 2D heightmap (noise.js)
 *               -> vertices + UVs + indices (terrain.js)
 *               -> vertex normals from face cross products (terrain.js)
 *               -> custom height-based shader (shaders.js)
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createHeightField } from './noise.js';
import { buildTerrainGeometry, buildNormalLines } from './terrain.js';
import { createTerrainMaterial, setSunAngles } from './shaders.js';

const TERRAIN_SIZE = 240;

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY = new THREE.Color(0x9dc0e0);
scene.background = SKY;

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.1,
  3000
);
camera.position.set(155, 128, 218);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.target.set(0, 4, 0);
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 30;
controls.maxDistance = 900;

// ---------------------------------------------------------------- terrain
const material = createTerrainMaterial();
material.uniforms.uFogColor.value.copy(SKY);

const terrain = new THREE.Mesh(new THREE.BufferGeometry(), material);
scene.add(terrain);

let normalLines = null;

const params = {
  seed: 1337,
  resolution: 128,
  noiseScale: 3,
  octaves: 5,
  persistence: 0.5,
  amplitude: 26,
  sunAzimuth: 45,
  sunElevation: 42,
  wireframe: false,
  showNormals: false,
  animateSun: false,
};

const $ = (id) => document.getElementById(id);

function rebuild() {
  const t0 = performance.now();

  const field = createHeightField(params);
  const { geometry, vertexCount, triangleCount } = buildTerrainGeometry(
    field,
    TERRAIN_SIZE
  );

  terrain.geometry.dispose();
  terrain.geometry = geometry;

  // The shader colours by world-space Y, so it only needs the new range.
  material.uniforms.uMinHeight.value = field.min;
  material.uniforms.uMaxHeight.value = field.max;

  if (normalLines) {
    scene.remove(normalLines);
    normalLines.geometry.dispose();
    normalLines.material.dispose();
  }
  const pos = geometry.getAttribute('position').array;
  const nrm = geometry.getAttribute('normal').array;
  normalLines = buildNormalLines(pos, nrm, TERRAIN_SIZE / 90);
  normalLines.visible = params.showNormals;
  scene.add(normalLines);

  const ms = performance.now() - t0;
  $('statVerts').textContent = vertexCount.toLocaleString();
  $('statTris').textContent = triangleCount.toLocaleString();
  $('statHeight').textContent = `${field.min.toFixed(1)} .. ${field.max.toFixed(1)}`;
  $('statTime').textContent = `${ms.toFixed(1)} ms`;
}

function applyLighting() {
  setSunAngles(material.uniforms, params.sunAzimuth, params.sunElevation);
}

// Coalesce rapid slider drags into one rebuild per frame. During startup the
// initial paint() pass only records values; rebuild() is called explicitly
// once at the end instead.
let rebuildQueued = false;
let ready = false;
function scheduleRebuild() {
  if (!ready || rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(() => {
    rebuildQueued = false;
    rebuild();
  });
}

// ---------------------------------------------------------------- UI
const sliders = [
  ['seed', (v) => (params.seed = +v)],
  ['resolution', (v) => (params.resolution = +v)],
  ['noiseScale', (v) => (params.noiseScale = +v)],
  ['octaves', (v) => (params.octaves = +v)],
  ['persistence', (v) => (params.persistence = +v)],
  ['amplitude', (v) => (params.amplitude = +v)],
  ['sunAzimuth', (v) => (params.sunAzimuth = +v)],
  ['sunElevation', (v) => (params.sunElevation = +v)],
];

for (const [id, apply] of sliders) {
  const input = $(id);
  const label = $(`${id}Val`);
  const paint = () => {
    apply(input.value);
    label.textContent =
      id === 'sunAzimuth' || id === 'sunElevation'
        ? `${input.value}°`
        : id === 'noiseScale' || id === 'persistence'
          ? Number(input.value).toFixed(2)
          : input.value;
    if (id === 'sunAzimuth' || id === 'sunElevation') applyLighting();
    else scheduleRebuild();
  };
  input.addEventListener('input', paint);
  paint();
}

for (const [id, key] of [
  ['wireframe', 'wireframe'],
  ['showNormals', 'showNormals'],
  ['animateSun', 'animateSun'],
]) {
  $(id).addEventListener('change', (e) => {
    params[key] = e.target.checked;
    if (key === 'wireframe') material.wireframe = params.wireframe;
    if (key === 'showNormals' && normalLines) normalLines.visible = params.showNormals;
  });
}

$('autorotate').addEventListener('change', (e) => {
  controls.autoRotate = e.target.checked;
  controls.autoRotateSpeed = 0.6;
});
controls.autoRotate = true;
controls.autoRotateSpeed = 0.6;

$('regenerate').addEventListener('click', () => {
  const seed = Math.floor(Math.random() * 10000);
  $('seed').value = seed;
  $('seedVal').textContent = seed;
  params.seed = seed;
  rebuild();
});

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();

  if (params.animateSun) {
    params.sunAzimuth = (params.sunAzimuth + dt * 12) % 360;
    $('sunAzimuth').value = params.sunAzimuth;
    $('sunAzimuthVal').textContent = `${Math.round(params.sunAzimuth)}°`;
    applyLighting();
  }

  controls.update();
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Debug handle: handy in the console while narrating the Loom walkthrough,
// and used by scripts/verify.mjs to assert the shader actually drew something.
window.__APP = { renderer, scene, camera, material, terrain, params, controls, rebuild, THREE };

ready = true;
rebuild();
applyLighting();
animate();
