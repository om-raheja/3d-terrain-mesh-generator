/**
 * tests/render.test.mjs — end-to-end behaviour of the running app:
 * UI wiring, live regeneration, renderer bookkeeping and framebuffer output.
 */

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { openApp, readFrame } from './helpers.mjs';

const PORT = 8122;
const SHOT = process.env.TERRAIN_SHOT ?? '/tmp/opencode/terrain-suite.png';

const DEFAULTS = {
  seed: 1337,
  resolution: 128,
  noiseScale: 3,
  octaves: 5,
  persistence: 0.5,
  amplitude: 26,
  sunAzimuth: 45,
  sunElevation: 42,
};

let app;

before(async () => {
  app = await openApp(PORT);
}, { timeout: 60000 });

after(async () => {
  mkdirSync(dirname(SHOT), { recursive: true });
  await app?.page.screenshot({ path: SHOT }).catch(() => {});
  await app?.close();
});

const TOGGLES = { wireframe: false, showNormals: false, animateSun: false, autorotate: true };

/** Puts the app back into its documented default state. */
async function resetApp() {
  await app.page.evaluate(
    ({ defaults, toggles }) => {
      for (const [id, value] of Object.entries(defaults)) {
        const el = document.getElementById(id);
        if (el.value !== String(value)) {
          el.value = String(value);
          el.dispatchEvent(new Event('input'));
        }
      }
      for (const [id, want] of Object.entries(toggles)) {
        const el = document.getElementById(id);
        if (el.checked !== want) {
          el.checked = want;
          el.dispatchEvent(new Event('change'));
        }
      }
    },
    { defaults: DEFAULTS, toggles: TOGGLES }
  );
  await app.page.waitForTimeout(180);
}

beforeEach(resetApp);

const setSlider = (id, value) =>
  app.page.evaluate(
    ({ id, value }) => {
      const el = document.getElementById(id);
      el.value = String(value);
      el.dispatchEvent(new Event('input'));
    },
    { id, value }
  );

const stats = () =>
  app.page.evaluate(() => {
    const t = (id) => document.getElementById(id).textContent;
    const num = (id) => parseInt(t(id).replace(/,/g, ''), 10);
    return {
      verts: num('statVerts'),
      tris: num('statTris'),
      time: parseFloat(t('statTime')),
      height: t('statHeight'),
      heightNums: t('statHeight').split('..').map(parseFloat),
      labels: {
        seed: t('seedVal'),
        resolution: t('resolutionVal'),
        noiseScale: t('noiseScaleVal'),
        persistence: t('persistenceVal'),
        sunAzimuth: t('sunAzimuthVal'),
        sunElevation: t('sunElevationVal'),
      },
    };
  });

/**
 * Stops camera auto-rotation and flushes OrbitControls' damping residual in
 * one step, so tests that compare camera state or frames are not racing the
 * inertial tail of a previous rotation.
 */
async function settleCamera() {
  await app.page.evaluate(() => {
    const { controls } = window.__APP;
    const el = document.getElementById('autorotate');
    if (el.checked) {
      el.checked = false;
      el.dispatchEvent(new Event('change'));
    }
    const wasDamped = controls.enableDamping;
    controls.enableDamping = false; // update() then applies and zeroes the delta
    controls.update();
    controls.enableDamping = wasDamped;
  });
  await app.page.waitForTimeout(150);
}

describe('initial load', () => {
  it('produces no console or page errors', () => {
    assert.deepEqual(app.errors, [], app.errors.join('\n'));
  });

  it('builds the documented default mesh (128², 2 tris per quad)', async () => {
    const s = await stats();
    assert.equal(s.verts, 128 * 128);
    assert.equal(s.tris, 2 * 127 * 127);
    assert.ok(s.time > 0 && s.time < 1000, `build time ${s.time}`);
    assert.ok(s.heightNums[0] < s.heightNums[1], 'height range must have relief');
  });

  it('renders through WebGL', async () => {
    const info = await app.page.evaluate(() => {
      const { renderer, scene, camera } = window.__APP;
      renderer.render(scene, camera);
      return {
        triangles: renderer.info.render.triangles,
        calls: renderer.info.render.calls,
        contextLost: renderer.getContext().isContextLost(),
        isWebGL2: renderer.capabilities.isWebGL2,
      };
    });
    assert.equal(info.contextLost, false);
    assert.equal(info.triangles, 2 * 127 * 127, 'drawn triangle count mismatch');
    assert.ok(info.calls >= 1, 'no draw calls issued');
    assert.equal(info.isWebGL2, true, 'expected a WebGL2 context');
  });

  it('exposes the debug handle needed for the Loom walkthrough', async () => {
    const keys = await app.page.evaluate(() => Object.keys(window.__APP).sort());
    for (const key of ['renderer', 'scene', 'camera', 'material', 'terrain', 'params', 'rebuild', 'THREE']) {
      assert.ok(keys.includes(key), `__APP missing ${key}`);
    }
  });

  it('formats every control label', async () => {
    const { labels } = await stats();
    assert.equal(labels.seed, '1337');
    assert.equal(labels.resolution, '128');
    assert.match(labels.noiseScale, /^\d+\.\d{2}$/);
    assert.match(labels.persistence, /^\d+\.\d{2}$/);
    assert.match(labels.sunAzimuth, /^\d+°$/);
    assert.match(labels.sunElevation, /^\d+°$/);
  });
});

describe('live regeneration', () => {
  for (const [resolution, expectedVerts] of [
    [16, 256],
    [64, 4096],
    [128, 16384],
    [256, 65536],
  ]) {
    it(`resolution ${resolution} -> ${expectedVerts} vertices`, async () => {
      await setSlider('resolution', resolution);
      await app.page.waitForFunction(
        (v) => {
          const el = document.getElementById('statVerts');
          return el && parseInt(el.textContent.replace(/,/g, ''), 10) === v;
        },
        expectedVerts,
        { timeout: 15000 }
      );
      const s = await stats();
      assert.equal(s.verts, expectedVerts);
      assert.equal(s.tris, 2 * (resolution - 1) ** 2);
      assert.equal(s.labels.resolution, String(resolution));
    });
  }

  it('rebuilds within the performance budget at 256²', async () => {
    await setSlider('resolution', 256);
    await app.page.waitForFunction(
      () => document.getElementById('statVerts').textContent.replace(/,/g, '') === '65536',
      undefined,
      { timeout: 15000 }
    );
    const s = await stats();
    assert.ok(s.time < 800, `256² build took ${s.time} ms`);
    assert.ok(s.time > 0);
  });

  it('is deterministic: the same seed yields the same height range', async () => {
    await setSlider('seed', 4242);
    await app.page.waitForTimeout(120);
    const first = await stats();
    await setSlider('seed', 1);
    await app.page.waitForTimeout(120);
    await setSlider('seed', 4242);
    await app.page.waitForTimeout(120);
    const again = await stats();
    assert.equal(first.height, again.height);
  });

  it('changes landscape when the seed changes', async () => {
    await setSlider('seed', 4242);
    await app.page.waitForTimeout(120);
    const a = await stats();
    await setSlider('seed', 4243);
    await app.page.waitForTimeout(120);
    const b = await stats();
    assert.notEqual(a.height, b.height);
  });

  it('scales the height range linearly with amplitude', async () => {
    await setSlider('amplitude', 26);
    await app.page.waitForTimeout(150);
    const base = await stats();

    await setSlider('amplitude', 52);
    await app.page.waitForTimeout(150);
    const doubled = await stats();

    const [bMin, bMax] = base.heightNums;
    const [dMin, dMax] = doubled.heightNums;
    assert.ok(Math.abs(dMin - bMin * 2) < 0.3, `${dMin} vs ${bMin * 2}`);
    assert.ok(Math.abs(dMax - bMax * 2) < 0.3, `${dMax} vs ${bMax * 2}`);
  });

  it('noise scale changes the roughness of the result', async () => {
    const roughness = async () =>
      app.page.evaluate(() => {
        const field = window.__APP.terrain.geometry;
        const pos = field.getAttribute('position');
        const N = Math.round(Math.sqrt(pos.count));
        let sum = 0;
        for (let j = 0; j < N - 1; j++) {
          for (let i = 0; i < N - 1; i++) {
            sum += Math.abs(pos.getY(j * N + i + 1) - pos.getY(j * N + i));
          }
        }
        return sum;
      });

    await setSlider('noiseScale', 1);
    await app.page.waitForTimeout(150);
    const smooth = await roughness();
    await setSlider('noiseScale', 8);
    await app.page.waitForTimeout(150);
    const rough = await roughness();
    assert.ok(rough > smooth * 1.5, `rough ${rough} vs smooth ${smooth}`);
  });

  it('octaves add detail without changing the grid size', async () => {
    await setSlider('octaves', 1);
    await app.page.waitForTimeout(150);
    const simple = await stats();
    await setSlider('octaves', 7);
    await app.page.waitForTimeout(150);
    const detailed = await stats();

    assert.equal(simple.verts, detailed.verts, 'vertex count must not depend on octaves');
    assert.notEqual(simple.height, detailed.height, 'more octaves should change relief');
  });

  it('the new-seed button picks a different seed', async () => {
    const before = await stats();
    for (let attempt = 0; attempt < 3; attempt++) {
      await app.page.click('#regenerate');
      await app.page.waitForTimeout(150);
      const after = await stats();
      if (after.labels.seed !== before.labels.seed) return;
    }
    assert.fail('regenerate button never changed the seed');
  });
});

describe('lighting controls', () => {
  it('the azimuth slider re-aims the sun vector', async () => {
    const dir = () =>
      app.page.evaluate(() => {
        const d = window.__APP.material.uniforms.uSunDir.value;
        return [d.x, d.y, d.z];
      });

    const at0 = await dir();
    await setSlider('sunAzimuth', 180);
    await app.page.waitForTimeout(80);
    const at180 = await dir();

    assert.ok(Math.abs(at0[0] - at180[0]) > 0.5, 'x component should flip sign');
    assert.equal(at0[1], at180[1], 'azimuth must not change elevation');
    assert.ok(
      Math.abs(Math.hypot(...at180) - 1) < 1e-9,
      'sun direction must stay normalised'
    );
  });

  it('the elevation slider raises the sun above the horizon', async () => {
    await setSlider('sunAzimuth', 0);
    await setSlider('sunElevation', 5);
    await app.page.waitForTimeout(80);
    const low = await app.page.evaluate(() => window.__APP.material.uniforms.uSunDir.value.y);

    await setSlider('sunElevation', 85);
    await app.page.waitForTimeout(80);
    const high = await app.page.evaluate(() => window.__APP.material.uniforms.uSunDir.value.y);

    assert.ok(high > low, `${high} should exceed ${low}`);
    assert.ok(high > 0.99, `elevation 85° should give y≈1, got ${high}`);
  });

  it('animate-sun sweeps the azimuth over time', async () => {
    await app.page.evaluate(() => {
      const el = document.getElementById('animateSun');
      el.checked = true;
      el.dispatchEvent(new Event('change'));
    });
    const before = await app.page.evaluate(() => window.__APP.params.sunAzimuth);
    await app.page.waitForTimeout(700);
    const after = await app.page.evaluate(() => window.__APP.params.sunAzimuth);
    assert.notEqual(after, before, 'sun did not move');
    assert.ok(Math.abs(after - before) < 180, 'sun should move a plausible amount');
  });
});

describe('toggles', () => {
  it('wireframe flips the material and nothing else', async () => {
    await app.page.check('#wireframe');
    const on = await app.page.evaluate(() => window.__APP.material.wireframe);
    assert.equal(on, true);

    await app.page.uncheck('#wireframe');
    const off = await app.page.evaluate(() => window.__APP.material.wireframe);
    assert.equal(off, false);
  });

  it('normal lines appear with exactly one segment per vertex', async () => {
    await app.page.check('#showNormals');
    const info = await app.page.evaluate(() => {
      const { scene } = window.__APP;
      const lines = scene.children.find((o) => o.isLineSegments);
      if (!lines || !lines.visible) return null;
      const verts = parseInt(
        document.getElementById('statVerts').textContent.replace(/,/g, ''),
        10
      );
      return { segments: lines.geometry.getAttribute('position').count, verts };
    });
    assert.ok(info, 'normal LineSegments not visible');
    assert.equal(info.segments, info.verts * 2, 'expected 2 points per vertex');

    await app.page.uncheck('#showNormals');
    const hidden = await app.page.evaluate(() =>
      window.__APP.scene.children.some((o) => o.isLineSegments && o.visible)
    );
    assert.equal(hidden, false);
  });

  it('camera auto-rotation runs on the animation loop', async () => {
    const pos = async () =>
      app.page.evaluate(() => {
        const p = window.__APP.camera.position;
        return [p.x, p.y, p.z];
      });
    const before = await pos();
    await app.page.waitForTimeout(700);
    const after = await pos();
    const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
    assert.ok(moved > 0.5, `camera only moved ${moved.toFixed(3)} — loop stalled?`);
  });

  it('turning auto-rotate off freezes the camera', async () => {
    await settleCamera();
    const pos = async () => app.page.evaluate(() => window.__APP.camera.position.x);
    const before = await pos();
    await app.page.waitForTimeout(600);
    const after = await pos();
    assert.ok(Math.abs(after - before) < 1e-6, `camera still moving: ${after - before}`);
    await app.page.check('#autorotate');
  });
});

describe('resource management', () => {
  it('disposes geometry across repeated rebuilds (no leak)', async () => {
    const leaked = await app.page.evaluate(() => {
      const { renderer, scene, camera } = window.__APP;
      for (let i = 0; i < 15; i++) {
        window.__APP.params.seed = i;
        window.__APP.rebuild();
        renderer.render(scene, camera); // force GPU allocation for this geometry
      }
      renderer.render(scene, camera);
      return {
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
      };
    });
    assert.ok(leaked.geometries <= 6, `${leaked.geometries} geometries alive after 15 rebuilds`);
    assert.equal(leaked.textures, 0, 'terrain must not allocate textures');
  });

  it('resizing the window resizes the drawing buffer', async () => {
    await app.page.setViewportSize({ width: 1100, height: 700 });
    // Playwright's viewport emulation updates innerWidth but does not reliably
    // dispatch the window resize event in headless, so nudge it.
    await app.page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await app.page.waitForTimeout(150);
    const size = await app.page.evaluate(() => {
      const { renderer } = window.__APP;
      return {
        canvasWidth: renderer.domElement.width,
        canvasHeight: renderer.domElement.height,
        bufferW: renderer.getContext().drawingBufferWidth,
        windowW: window.innerWidth,
        windowH: window.innerHeight,
      };
    });
    assert.equal(size.windowW, 1100);
    assert.equal(size.canvasWidth, size.windowW, 'canvas buffer width not resized');
    assert.equal(size.canvasHeight, size.windowH, 'canvas buffer height not resized');
    assert.equal(size.bufferW, size.windowW, 'drawing buffer not resized');
    await app.page.setViewportSize({ width: 1440, height: 900 });
    await app.page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await app.page.waitForTimeout(150);
  });
});

describe('framebuffer output', () => {
  it('draws lit, height-coloured terrain filling a good part of the frame', async () => {
    const frame = await app.page.evaluate(readFrame);
    assert.ok(frame.terrain / frame.total > 0.05, `terrain covers ${frame.terrain / frame.total}`);
    assert.ok(frame.lumMax - frame.lumMin > 40, `flat luminance ${frame.lumMin}..${frame.lumMax}`);
    assert.ok(frame.green > 50, `only ${frame.green} green valley pixels`);
    assert.ok(frame.bright > 10, `only ${frame.bright} snow pixels`);
  });

  it('greyscale check: sky and terrain are distinguishable', async () => {
    const frame = await app.page.evaluate(readFrame);
    const spread = Math.max(...frame.sky) - Math.min(...frame.sky);
    assert.ok(spread > 40, `sky should be blue-dominant, got ${frame.sky}`);
    assert.ok(frame.lumMin < 120, 'terrain should contain shaded areas darker than the sky');
  });

  it('rendering twice in a row produces the same frame (stable output)', async () => {
    // Freeze the camera first so the comparison is apples to apples.
    await settleCamera();
    const a = await app.page.evaluate(readFrame);
    const b = await app.page.evaluate(readFrame);
    assert.equal(a.terrain, b.terrain, 'terrain pixel count drifted between frames');
    assert.equal(a.green, b.green, 'colouring is not deterministic');
    await app.page.check('#autorotate');
  });
});
