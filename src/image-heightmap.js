/**
 * image-heightmap.js — the second heightmap input: a grayscale image.
 *
 * The brief accepts a heightmap as "an image or a generated 2D noise array":
 * noise.js builds the array, and this module turns picture pixels into the
 * *same* `{ data, resolution, min, max, amplitude }` field shape. Everything
 * downstream — buildGrid, computeVertexNormals, the Y-driven shader — is
 * therefore shared untouched, so an image terrain and a noise terrain are
 * built by identical mesh code (no special cases, no second renderer).
 *
 * Two halves:
 *   heightFieldFromRGBA()  pure pixel maths, unit-tested in Node
 *   boot() (auto-runs)     file picker, geometry swap, rebuild watcher
 *
 * The swap goes through the `window.__APP` handle that main.js already
 * exposes, so none of the four demo files (noise / terrain / shaders / main)
 * is modified: main.js keeps owning the scene, this module only replaces the
 * geometry object it points at — and re-points it whenever main.js rebuilds.
 *
 * Height convention: mid-grey = 0 = sea level, black sinks to -amplitude,
 * white rises to +amplitude — symmetric around zero exactly like the noise
 * field, so the shader's min/max normalisation behaves identically for both.
 */

import { buildTerrainGeometry, buildNormalLines } from './terrain.js';

/** BT.601 luma weights: a heightmap's "altitude" is pixel brightness. */
const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;

/** Cap on decoded source pixels: the finest grid is 256², so 1024² of source */
const MAX_SOURCE_DIM = 1024;

const lerp = (a, b, t) => a + (b - a) * t;

/** Brightness of one pixel in 0..1. Alpha is ignored: altitude ≠ opacity. */
function luminance(pixels, offset) {
  return (
    (pixels[offset] * LUMA_R +
      pixels[offset + 1] * LUMA_G +
      pixels[offset + 2] * LUMA_B) /
    255
  );
}

/**
 * Resamples a `width` x `height` RGBA image into a `resolution²` heightfield
 * and maps brightness to world height: `(luma - 0.5) * 2 * amplitude`.
 *
 * Sampling is bilinear on the unit square — the same normalisation the noise
 * path uses (`i / (resolution - 1)`), so a 64×64 photo and a 4000×4000 photo
 * both land on the identical grid and stay resolution-independent.
 *
 * Returns exactly the shape `createHeightField()` returns; callers cannot
 * tell which input produced the field.
 */
export function heightFieldFromRGBA(
  pixels,
  width,
  height,
  { resolution, amplitude } = {}
) {
  if (!Number.isInteger(resolution) || resolution < 2) {
    throw new RangeError(`resolution must be an integer >= 2 (got ${resolution})`);
  }
  if (!Number.isFinite(amplitude)) {
    throw new RangeError(`amplitude must be finite (got ${amplitude})`);
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`image dimensions must be positive integers (got ${width}x${height})`);
  }
  if (!pixels || pixels.length !== width * height * 4) {
    throw new RangeError(
      `pixel buffer must hold width*height*4 = ${width * height * 4} bytes (got ${pixels?.length})`
    );
  }

  const data = new Float32Array(resolution * resolution);
  const inv = 1 / (resolution - 1);

  let min = Infinity;
  let max = -Infinity;

  for (let j = 0; j < resolution; j++) {
    const sy = j * inv * (height - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(y0 + 1, height - 1);
    const fy = sy - y0;

    for (let i = 0; i < resolution; i++) {
      const sx = i * inv * (width - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, width - 1);
      const fx = sx - x0;

      // Bilinear blend of the four neighbouring pixels' luminance.
      const l00 = luminance(pixels, (y0 * width + x0) * 4);
      const l10 = luminance(pixels, (y0 * width + x1) * 4);
      const l01 = luminance(pixels, (y1 * width + x0) * 4);
      const l11 = luminance(pixels, (y1 * width + x1) * 4);
      const luma = lerp(lerp(l00, l10, fx), lerp(l01, l11, fx), fy);

      const y = (luma - 0.5) * 2 * amplitude;
      const idx = j * resolution + i;
      data[idx] = y;
      // Track the *stored* value (Float32 rounding), exactly as noise.js does,
      // so uMinHeight/uMaxHeight describe what the shader will actually read.
      const stored = data[idx];
      if (stored < min) min = stored;
      if (stored > max) max = stored;
    }
  }

  return { data, resolution, min, max, amplitude };
}

// ---------------------------------------------------------------- page half

let source = null; // { pixels, width, height, name } once an image is loaded
let current = null; // the geometry object this module last placed on the mesh

const $ = (id) => document.getElementById(id);

/** Decodes an <img> into RGBA pixels, capped at MAX_SOURCE_DIM. */
function readImagePixels(img) {
  const naturalW = img.naturalWidth || img.width;
  const naturalH = img.naturalHeight || img.height;
  if (!naturalW || !naturalH) {
    throw new Error('image has no intrinsic size');
  }

  const scale = Math.min(1, MAX_SOURCE_DIM / Math.max(naturalW, naturalH));
  const width = Math.max(1, Math.round(naturalW * scale));
  const height = Math.max(1, Math.round(naturalH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(img, 0, 0, width, height);

  return { pixels: ctx.getImageData(0, 0, width, height).data, width, height };
}

/** World size of the grid, read off the current mesh (it spans ±size/2 on X). */
function currentSize(terrain) {
  const geometry = terrain.geometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox;
  return max.x - min.x;
}

/**
 * Builds mesh + normals from the loaded image at the *current* slider values
 * and swaps it in. Resolution and amplitude therefore keep working in image
 * mode — they re-sample and re-scale the picture.
 */
function apply() {
  const app = window.__APP;
  if (!app || !source) return;

  const { terrain, material, scene, params } = app;
  const t0 = performance.now();

  const size = currentSize(terrain);
  const field = heightFieldFromRGBA(source.pixels, source.width, source.height, {
    resolution: params.resolution,
    amplitude: params.amplitude,
  });
  const { geometry, vertexCount, triangleCount } = buildTerrainGeometry(field, size);

  geometry.userData.heightmapSource = 'image';
  const previous = terrain.geometry;
  terrain.geometry = geometry;
  current = geometry;
  if (previous) previous.dispose();

  // Same two uniforms main.js feeds after createHeightField(): the shader
  // never learns which input produced the heights.
  material.uniforms.uMinHeight.value = field.min;
  material.uniforms.uMaxHeight.value = field.max;

  refaceNormalLines(scene, geometry, size);
  writeStats(field, vertexCount, triangleCount, performance.now() - t0);
}

/**
 * main.js rebuilds the normal-line overlay from *its* geometry, so point the
 * existing overlay at ours. Only the geometry is replaced — main.js still
 * holds this LineSegments object and keeps toggling its `visible` flag.
 */
function refaceNormalLines(scene, geometry, size) {
  const lines = scene.children.find((o) => o.isLineSegments);
  if (!lines) return;

  const fresh = buildNormalLines(
    geometry.getAttribute('position').array,
    geometry.getAttribute('normal').array,
    size / 90 // same length main.js uses (TERRAIN_SIZE / 90)
  );
  lines.geometry.dispose();
  lines.geometry = fresh.geometry;
  fresh.material.dispose();
}

/** Mirrors main.js's stats block so the panel never reports stale numbers. */
function writeStats(field, vertexCount, triangleCount, ms) {
  if (!$('statVerts')) return;
  $('statVerts').textContent = vertexCount.toLocaleString();
  $('statTris').textContent = triangleCount.toLocaleString();
  $('statHeight').textContent = `${field.min.toFixed(1)} .. ${field.max.toFixed(1)}`;
  $('statTime').textContent = `${ms.toFixed(1)} ms`;
}

function mountUI() {
  const panel = $('panel');
  if (!panel || $('imageRow')) return;

  const row = document.createElement('div');
  row.className = 'row';
  row.id = 'imageRow';
  row.innerHTML = [
    '<label>Heightmap image <b id="imageState">noise</b></label>',
    '<input id="imageFile" type="file" accept="image/*" hidden />',
    '<button id="imagePick" type="button">&#8681; Load image heightmap</button>',
    '<button id="imageReset" type="button" hidden>&#8634; Back to generated noise</button>',
    '<p id="imageNote" style="margin:6px 0 0;font-size:10.5px;color:var(--muted);"></p>',
  ].join('');
  panel.insertBefore(row, $('stats'));

  $('imagePick').addEventListener('click', () => $('imageFile').click());
  $('imageReset').addEventListener('click', useNoise);
  $('imageFile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) loadImageFile(file);
    e.target.value = ''; // allow re-picking the same file
  });
}

function loadImageFile(file) {
  updateStatus(`decoding ${file.name}…`);
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    try {
      source = { ...readImagePixels(img), name: file.name };
      apply();
      updateStatus();
    } catch (err) {
      source = null;
      updateStatus(`✗ ${err.message}`);
    }
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    updateStatus(`✗ could not decode ${file.name}`);
  };
  img.src = url;
}

/** Hand control back to main.js: rebuild() regenerates the noise field. */
function useNoise() {
  source = null;
  current = null;
  if (window.__APP) window.__APP.rebuild();
  updateStatus();
}

function updateStatus(message) {
  if (!$('imageState')) return;
  const note = $('imageNote');
  const reset = $('imageReset');

  if (message) {
    $('imageState').textContent = '…';
    note.textContent = message;
    return;
  }

  if (source) {
    const amp = window.__APP ? window.__APP.params.amplitude : 0;
    $('imageState').textContent =
      source.name.length > 17 ? `${source.name.slice(0, 14)}…` : source.name;
    note.textContent = `black → ${-amp}, white → +${amp} · resolution & amplitude sliders still apply`;
    reset.hidden = false;
  } else {
    $('imageState').textContent = 'noise';
    note.textContent = '';
    reset.hidden = true;
  }
}

/**
 * main.js rebuilds the geometry whenever a mesh slider moves (scheduleRebuild
 * → createHeightField). Catch that and re-apply the image field, so slider
 * changes re-sample the picture instead of silently reverting to noise.
 */
function tick() {
  const app = window.__APP;
  if (source && app && app.terrain.geometry !== current) apply();
  requestAnimationFrame(tick);
}

function status() {
  const geometry = window.__APP && window.__APP.terrain.geometry;
  return {
    mode: source ? 'image' : 'noise',
    name: source ? source.name : null,
    geometry: (geometry && geometry.userData.heightmapSource) || 'noise',
  };
}

function boot() {
  if (!window.__APP) {
    requestAnimationFrame(boot); // main.js sets __APP when its module runs
    return;
  }
  mountUI();
  updateStatus();
  requestAnimationFrame(tick);
}

if (typeof window !== 'undefined') {
  window.__IMAGE = { heightFieldFromRGBA, apply, useNoise, status };
  boot();
}
