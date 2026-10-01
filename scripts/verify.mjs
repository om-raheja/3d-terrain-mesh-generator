/**
 * scripts/verify.mjs — automated checks for the terrain bounty.
 *
 *   node scripts/verify.mjs [screenshot-output-path]
 *
 * Part A  geometry math  (no browser): grid topology, winding, unit-length
 *         normals, and a comparison of the computed per-vertex normals against
 *         the analytic normal of the height field (central differences).
 * Part B  render check   (headless Chromium): loads the page, asserts there
 *         are no console errors, reads pixels straight out of the WebGL
 *         framebuffer to prove directional lighting + height colouring are
 *         actually on screen, then re-generates with a new amplitude and
 *         asserts the mesh changed.
 */

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHeightField } from '../src/noise.js';
import { buildTerrainGeometry, computeVertexNormals, buildGrid } from '../src/terrain.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8099;
const SHOT = resolve(process.argv[2] ?? '/tmp/opencode/terrain-verify.png');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push(['PASS', name, detail ?? '']);
  } catch (err) {
    results.push(['FAIL', name, err.message]);
  }
}

// ---------------------------------------------------------------- Part A
const SIZE = 240;

check('grid topology: N*N vertices, (N-1)^2 quads, 2 tris per quad', () => {
  const field = createHeightField({ resolution: 64, seed: 7 });
  const { positions, uvs, indices } = buildGrid(field, SIZE);
  assert.equal(positions.length / 3, 64 * 64, 'vertex count');
  assert.equal(indices.length, 63 * 63 * 6, 'index count');
  assert.equal(uvs.length / 2, 64 * 64, 'uv count');
  assert.ok(uvs.every((v) => v >= 0 && v <= 1), 'uvs outside [0,1]');
  return `${64 * 64} verts, ${indices.length / 3} tris`;
});

check('flat heightmap -> every normal is exactly +Y', () => {
  const field = createHeightField({ resolution: 32, amplitude: 0 });
  const { geometry } = buildTerrainGeometry(field, SIZE);
  const n = geometry.getAttribute('normal').array;
  for (let i = 0; i < n.length; i += 3) {
    assert.ok(Math.abs(n[i]) < 1e-6 && Math.abs(n[i + 1] - 1) < 1e-6 && Math.abs(n[i + 2]) < 1e-6,
      `normal ${[n[i], n[i + 1], n[i + 2]]} is not +Y`);
  }
  return `${n.length / 3} normals`;
});

check('every face is wound CCW from above (no flipped slopes)', () => {
  const field = createHeightField({ resolution: 96, seed: 42, amplitude: 40 });
  const { positions, indices } = buildGrid(field, SIZE);
  let worst = Infinity;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const e1 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
    const e2 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
    const ny = e1[2] * e2[0] - e1[0] * e2[2]; // (e1 x e2).y
    worst = Math.min(worst, ny);
  }
  assert.ok(worst > 0, `flipped face, min face-normal Y = ${worst}`);
  return `min face-normal Y = ${worst.toExponential(2)}`;
});

check('computed vertex normals are unit length', () => {
  const field = createHeightField({ resolution: 128, seed: 99 });
  const { geometry } = buildTerrainGeometry(field, SIZE);
  const n = geometry.getAttribute('normal').array;
  let worst = 0;
  for (let i = 0; i < n.length; i += 3) {
    worst = Math.max(worst, Math.abs(Math.hypot(n[i], n[i + 1], n[i + 2]) - 1));
  }
  assert.ok(worst < 1e-5, `max |length-1| = ${worst}`);
  return `max deviation ${worst.toExponential(2)}`;
});

check('vertex normals match the analytic normal of the height field', () => {
  const res = 128;
  const field = createHeightField({ resolution: res, seed: 2024, amplitude: 34 });
  const { positions, indices } = buildGrid(field, SIZE);
  const normals = computeVertexNormals(positions, indices);
  const dx = SIZE / (res - 1);

  let dotSum = 0;
  let dotMin = 1;
  let count = 0;
  for (let j = 1; j < res - 1; j++) {
    for (let i = 1; i < res - 1; i++) {
      const idx = j * res + i;
      const dhdx = (field.data[idx + 1] - field.data[idx - 1]) / (2 * dx);
      const dhdz = (field.data[idx + res] - field.data[idx - res]) / (2 * dx);
      const len = Math.hypot(-dhdx, 1, -dhdz);
      const ax = -dhdx / len, ay = 1 / len, az = -dhdz / len;

      const o = idx * 3;
      const dot = normals[o] * ax + normals[o + 1] * ay + normals[o + 2] * az;
      dotSum += dot;
      dotMin = Math.min(dotMin, dot);
      count++;
    }
  }
  const mean = dotSum / count;
  assert.ok(mean > 0.99, `mean dot ${mean.toFixed(5)} too low`);
  assert.ok(dotMin > 0.9, `worst vertex dot ${dotMin.toFixed(5)} too low`);
  return `mean dot ${mean.toFixed(4)}, min ${dotMin.toFixed(4)} over ${count} verts`;
});

// ---------------------------------------------------------------- Part B
const server = spawn('python3', ['-m', 'http.server', String(PORT)], {
  cwd: ROOT,
  stdio: 'ignore',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('static server never came up');
}

async function renderChecks() {
  const { chromium } = await import('playwright-core');
  const candidates = [
    `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux/chrome`,
    `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux/chrome`,
  ];
  const executablePath = candidates.find(existsSync);
  assert.ok(executablePath, 'no cached chromium found');

  const browser = await chromium.launch({
    executablePath,
    args: [
      '--no-sandbox',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => window.__APP && document.getElementById('statVerts').textContent !== '–',
    undefined,
    { timeout: 20000 }
  );

  check('no console/page errors while loading', () => {
    assert.deepEqual(errors, [], errors.join('\n'));
    return 'clean';
  });

  const stats = await page.evaluate(() => ({
    verts: document.getElementById('statVerts').textContent,
    tris: document.getElementById('statTris').textContent,
    height: document.getElementById('statHeight').textContent,
    time: document.getElementById('statTime').textContent,
  }));
  check('mesh stats are populated', () => {
    assert.notEqual(stats.verts, '–');
    assert.ok(parseInt(stats.verts.replace(/,/g, ''), 10) > 1000, 'too few vertices');
    assert.ok(parseInt(stats.tris.replace(/,/g, ''), 10) > 2000, 'too few triangles');
    return `${stats.verts} verts / ${stats.tris} tris in ${stats.time}`;
  });

  const pixels = await page.evaluate(() => {
    const { renderer, scene, camera } = window.__APP;
    renderer.render(scene, camera);
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

    // readPixels origin is bottom-left; sample the top-left corner for sky.
    const skyAt = ((h - 2) * w + 2) * 4;
    const sky = [px[skyAt], px[skyAt + 1], px[skyAt + 2]];

    let terrain = 0, total = 0, green = 0, bright = 0;
    let lumMin = 255, lumMax = 0;
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w; x += 3) {
        const o = (y * w + x) * 4;
        const r = px[o], g = px[o + 1], b = px[o + 2];
        total++;
        const isSky =
          Math.abs(r - sky[0]) < 12 &&
          Math.abs(g - sky[1]) < 12 &&
          Math.abs(b - sky[2]) < 12;
        if (isSky) continue;
        terrain++;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        lumMin = Math.min(lumMin, lum);
        lumMax = Math.max(lumMax, lum);
        if (g > r + 8 && g > b + 8) green++;
        if (r > 200 && g > 200 && b > 200) bright++;
      }
    }
    return { sky, terrain, total, green, bright, lumMin, lumMax };
  });

  check('terrain actually covers the viewport', () => {
    const frac = pixels.terrain / pixels.total;
    assert.ok(frac > 0.05, `terrain covers only ${(frac * 100).toFixed(1)}% of pixels`);
    return `${(frac * 100).toFixed(1)}% of frame`;
  });

  check('directional lighting varies brightness across slopes', () => {
    const range = pixels.lumMax - pixels.lumMin;
    assert.ok(range > 40, `luminance range ${range.toFixed(1)} too flat`);
    return `luminance ${pixels.lumMin.toFixed(0)}..${pixels.lumMax.toFixed(0)}`;
  });

  check('height colouring: green valleys present', () => {
    assert.ok(pixels.green > 50, `only ${pixels.green} green pixels`);
    return `${pixels.green} green pixels`;
  });

  check('height colouring: bright snow peaks present', () => {
    assert.ok(pixels.bright > 10, `only ${pixels.bright} near-white pixels`);
    return `${pixels.bright} snow pixels`;
  });

  mkdirSync(dirname(SHOT), { recursive: true });
  await page.screenshot({ path: SHOT });

  const before = stats.height;
  const after = await page.evaluate(() => {
    window.__APP.params.amplitude = 58;
    window.__APP.params.seed = 4242;
    window.__APP.rebuild();
    return document.getElementById('statHeight').textContent;
  });
  check('regenerating with new params rebuilds the mesh', () => {
    assert.notEqual(after, before, `height range unchanged (${after})`);
    return `${before} -> ${after}`;
  });

  await page.check('#wireframe');
  await page.check('#showNormals');
  await page.waitForTimeout(300);
  const toggles = await page.evaluate(() => ({
    wireframe: window.__APP.material.wireframe,
    normalLines: window.__APP.scene.children.some((o) => o.isLineSegments && o.visible),
  }));
  check('wireframe + normal-line toggles apply to the scene', () => {
    assert.equal(toggles.wireframe, true, 'material.wireframe not set');
    assert.equal(toggles.normalLines, true, 'normal LineSegments not visible');
    return 'both active';
  });
  await page.screenshot({ path: SHOT.replace(/\.png$/, '-normals.png') });
  await page.uncheck('#wireframe');
  await page.uncheck('#showNormals');

  await page.evaluate(() => {
    const el = document.getElementById('resolution');
    el.value = '256';
    el.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(
    () => document.getElementById('statVerts').textContent === '65,536',
    undefined,
    { timeout: 15000 }
  );
  const hiRes = await page.evaluate(() => ({
    time: document.getElementById('statTime').textContent,
    tris: document.getElementById('statTris').textContent,
  }));
  check('256x256 rebuild completes within budget', () => {
    const ms = parseFloat(hiRes.time);
    assert.ok(ms < 500, `build took ${ms} ms`);
    return `${hiRes.tris} tris in ${hiRes.time}`;
  });

  check('no console/page errors after interaction', () => {
    assert.deepEqual(errors, [], errors.join('\n'));
    return 'clean';
  });

  await browser.close();
  return SHOT;
}

let failed = false;
try {
  await waitForServer();
  await renderChecks();
} catch (err) {
  results.push(['FAIL', 'render harness', err.message]);
  failed = true;
} finally {
  server.kill();
}

for (const [status, name, detail] of results) {
  if (status === 'FAIL') failed = true;
  console.log(`${status === 'PASS' ? '  ok  ' : 'FAIL  '} ${name}${detail ? `  —  ${detail}` : ''}`);
}

const passed = results.filter((r) => r[0] === 'PASS').length;
console.log(`\n${passed}/${results.length} checks passed${failed ? '  (FAILURES)' : ''}`);
console.log(`screenshot: ${SHOT}`);
process.exit(failed ? 1 : 0);
