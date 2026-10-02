/**
 * tests/image-browser.test.mjs — end-to-end image heightmap loading.
 *
 * Drives the real page in headless Chromium: uploads an SVG gradient through
 * the file picker, then checks that mesh, uniforms, normal overlay and stats
 * all switched to image-derived values — and that handing control back to the
 * noise path works. Everything runs against the unchanged demo files; the
 * feature lives entirely in src/image-heightmap.js.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { openApp, readFrame } from './helpers.mjs';

const PORT = 8123;

/** Vertical black → white gradient; decodable as an image by any browser. */
const GRADIENT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000000"/>
      <stop offset="1" stop-color="#ffffff"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" fill="url(#g)"/>
</svg>`;

const upload = (page) =>
  page.setInputFiles('#imageFile', {
    name: 'gradient.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(GRADIENT_SVG),
  });

const untilImage = (page) =>
  page.waitForFunction(
    () => {
      const s = window.__IMAGE && window.__IMAGE.status();
      return s && s.mode === 'image' && s.geometry === 'image';
    },
    undefined,
    { timeout: 10000 }
  );

describe('image heightmap in the browser', () => {
  let app;

  before(async () => {
    app = await openApp(PORT);
  });

  after(async () => {
    if (app) await app.close();
  });

  it('mounts the picker into the existing panel', async () => {
    const { page } = app;
    await page.waitForSelector('#imagePick', { timeout: 5000 });

    const ui = await page.evaluate(() => ({
      file: !!document.getElementById('imageFile'),
      resetHidden: document.getElementById('imageReset').hidden,
      state: document.getElementById('imageState').textContent,
      statsStillLast:
        document.getElementById('stats').previousElementSibling.id === 'imageRow',
      noiseControls: ['seed', 'resolution', 'amplitude', 'regenerate'].every((id) =>
        document.getElementById(id)
      ),
    }));

    assert.equal(ui.file, true);
    assert.equal(ui.resetHidden, true, 'revert button starts hidden');
    assert.equal(ui.state, 'noise');
    assert.equal(ui.statsStillLast, true, 'picker sits above the stats block');
    assert.equal(ui.noiseControls, true, 'demo panel untouched');
  });

  it('swaps in an image-derived mesh at the current slider values', async () => {
    const { page } = app;
    const before = await page.evaluate(() => window.__IMAGE.status());
    assert.equal(before.mode, 'noise', 'starts on the generated noise array');

    await upload(page);
    await untilImage(page);

    const after = await page.evaluate(() => {
      const { terrain, material, params } = window.__APP;
      const geometry = terrain.geometry;
      return {
        source: geometry.userData.heightmapSource,
        verts: geometry.getAttribute('position').count,
        normals: geometry.getAttribute('normal').count,
        min: material.uniforms.uMinHeight.value,
        max: material.uniforms.uMaxHeight.value,
        statVerts: document.getElementById('statVerts').textContent,
        statHeight: document.getElementById('statHeight').textContent,
        resolution: params.resolution,
        amplitude: params.amplitude,
        label: document.getElementById('imageState').textContent,
        resetHidden: document.getElementById('imageReset').hidden,
      };
    });

    assert.equal(after.source, 'image');
    assert.equal(after.verts, after.resolution ** 2, 'grid density still follows the slider');
    assert.equal(after.normals, after.verts, 'one computed normal per image vertex');
    assert.ok(Math.abs(after.min + after.amplitude) < 0.5, `min ${after.min} ≈ -A`);
    assert.ok(Math.abs(after.max - after.amplitude) < 0.5, `max ${after.max} ≈ +A`);
    assert.equal(after.statVerts, (after.resolution ** 2).toLocaleString());
    assert.match(after.statHeight, /^-2[456]\.\d .. 2[456]\.\d$/);
    assert.equal(after.label, 'gradient.svg');
    assert.equal(after.resetHidden, false, 'revert button appears');
    assert.deepEqual(app.errors, [], 'no console/page errors while swapping');
  });

  it('rebuilds the normal overlay for the image mesh', async () => {
    const { page } = app;
    const overlay = await page.evaluate(() => {
      const appRef = window.__APP;
      const lines = appRef.scene.children.find((o) => o.isLineSegments);
      if (!lines) return null;

      const nrm = appRef.terrain.geometry.getAttribute('normal').array;
      let maxTilt = 0;
      for (let v = 0; v < nrm.length; v += 3) {
        maxTilt = Math.max(maxTilt, Math.hypot(nrm[v], nrm[v + 2]));
      }
      return {
        segments: lines.geometry.getAttribute('position').count,
        expected: appRef.terrain.geometry.getAttribute('position').count * 2,
        maxTilt: maxTilt,
        visible: lines.visible,
      };
    });

    assert.ok(overlay, 'normal-line overlay still in the scene');
    assert.equal(overlay.segments, overlay.expected, 'overlay re-pointed at the image mesh');
    assert.equal(overlay.visible, false, 'main.js still owns its visibility toggle');
    assert.ok(overlay.maxTilt > 0.05, 'gradient slopes tilt the normals');
  });

  it('keeps the image mesh when main.js rebuilds', async () => {
    const { page } = app;
    // A mesh slider queues exactly this: rebuild() -> createHeightField noise.
    // The watcher must re-apply the image field instead of silently reverting.
    await page.evaluate(() => window.__APP.rebuild());

    await page.waitForFunction(
      () => {
        const s = window.__IMAGE.status();
        return s.mode === 'image' && s.geometry === 'image';
      },
      undefined,
      { timeout: 5000 }
    );

    const state = await page.evaluate(() => ({
      verts: window.__APP.terrain.geometry.getAttribute('position').count,
      statVerts: document.getElementById('statVerts').textContent,
      resolution: window.__APP.params.resolution,
    }));
    assert.equal(state.verts, state.resolution ** 2);
    assert.equal(state.statVerts, (state.resolution ** 2).toLocaleString());
  });

  it('renders the image terrain with working directional light', async () => {
    const { page } = app;
    const frame = await page.evaluate(readFrame);

    assert.ok(frame.terrain > 1000, `terrain pixels: ${frame.terrain}`);
    assert.ok(frame.lumMax > 170, `white peak should stay bright, lumMax ${frame.lumMax}`);
    assert.ok(frame.lumMin < 90, `black valley should stay dark, lumMin ${frame.lumMin}`);
    assert.deepEqual(app.errors, [], 'clean console after rendering');
  });

  it('hands control back to the generated noise array', async () => {
    const { page } = app;
    await page.click('#imageReset');
    await page.waitForFunction(
      () => window.__IMAGE.status().mode === 'noise',
      undefined,
      { timeout: 5000 }
    );

    const back = await page.evaluate(() => ({
      source: window.__APP.terrain.geometry.userData.heightmapSource || 'noise',
      verts: window.__APP.terrain.geometry.getAttribute('position').count,
      statVerts: document.getElementById('statVerts').textContent,
      state: document.getElementById('imageState').textContent,
      resetHidden: document.getElementById('imageReset').hidden,
      height: document.getElementById('statHeight').textContent,
    }));

    assert.equal(back.source, 'noise');
    assert.equal(back.verts, 128 * 128);
    assert.equal(back.statVerts, (128 * 128).toLocaleString());
    assert.equal(back.state, 'noise');
    assert.equal(back.resetHidden, true);
    // Noise default is -16.5 .. 20.5 — no longer the image's ±26 span.
    assert.ok(!/^-26\.\d .. 26\.\d$/.test(back.height), `reverted stats: ${back.height}`);
    assert.deepEqual(app.errors, [], 'clean console after reverting');
  });
});
