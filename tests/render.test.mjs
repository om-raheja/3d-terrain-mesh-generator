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

/**
 * Sets a mesh slider and waits for the rebuild it queues.
 *
 * main.js coalesces slider drags into one rebuild per animation frame, so a
 * fixed sleep can read a stale stats panel when the machine is busy. The app
 * registers its own rAF during the input dispatch, which runs before ours —
 * two frames later the rebuild has certainly completed.
 */
async function setSliderAndWait(id, value) {
  await setSlider(id, value);
  await app.page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })
  );
}

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
    await setSliderAndWait('seed', 4242);
    const first = await stats();
    await setSliderAndWait('seed', 1);
    await setSliderAndWait('seed', 4242);
    const again = await stats();
    assert.equal(first.height, again.height);
  });

  it('changes landscape when the seed changes', async () => {
    await setSliderAndWait('seed', 4242);
    const a = await stats();
    await setSliderAndWait('seed', 4243);
    const b = await stats();
    assert.notEqual(a.height, b.height);
  });

  it('scales the height range linearly with amplitude', async () => {
    await setSliderAndWait('amplitude', 26);
    const base = await stats();

    await setSliderAndWait('amplitude', 52);
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

    await setSliderAndWait('noiseScale', 1);
    const smooth = await roughness();
    await setSliderAndWait('noiseScale', 8);
    const rough = await roughness();
    assert.ok(rough > smooth * 1.5, `rough ${rough} vs smooth ${smooth}`);
  });

  it('octaves add detail without changing the grid size', async () => {
    await setSliderAndWait('octaves', 1);
    const simple = await stats();
    await setSliderAndWait('octaves', 7);
    const detailed = await stats();

    assert.equal(simple.verts, detailed.verts, 'vertex count must not depend on octaves');
    assert.notEqual(simple.height, detailed.height, 'more octaves should change relief');
  });

  it('the new-seed button picks a different seed', async () => {
    const before = await stats();
    for (let attempt = 0; attempt < 3; attempt++) {
      await app.page.click('#regenerate');
      await app.page.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          })
      );
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

describe('lighting drives the framebuffer', () => {
  it('raising the sun brightens the frame; lowering it dims the frame', async () => {
    await settleCamera();
    await setSlider('sunElevation', 85);
    await app.page.waitForTimeout(150);
    const high = await app.page.evaluate(readFrame);

    await setSlider('sunElevation', 5);
    await app.page.waitForTimeout(150);
    const low = await app.page.evaluate(readFrame);

    const delta = high.lumMean - low.lumMean;
    assert.ok(delta > 3, `elevation 85° mean ${high.lumMean} vs 5° mean ${low.lumMean}`);
    assert.ok(high.lumMax > low.lumMax, 'the brightest pixel should also rise');
    await app.page.check('#autorotate');
  });

  it('front-lighting beats back-lighting on the visible slopes', async () => {
    // Camera sits at (155, 128, 218) -> azimuth ≈ 55° points at the viewer.
    await settleCamera();
    const light = async (azimuth) => {
      await setSlider('sunAzimuth', azimuth);
      await app.page.waitForTimeout(150);
      return app.page.evaluate(readFrame);
    };

    const front = await light(55); // sun behind the camera
    const back = await light(235); // sun behind the terrain
    const delta = front.lumMean - back.lumMean;

    assert.ok(delta > 3, `front-lit ${front.lumMean} vs back-lit ${back.lumMean}`);
    assert.ok(front.lumMax > back.lumMax, 'front-lit peaks should be brighter');
    await setSlider('sunAzimuth', 45);
    await app.page.check('#autorotate');
  });
});

describe('live mesh integrity', () => {
  it('leaves no pending WebGL errors after a render', async () => {
    const err = await app.page.evaluate(() => {
      const { renderer, scene, camera } = window.__APP;
      const gl = renderer.getContext();
      // Drain anything a previous test left behind (bounded so a sticky
      // context-loss flag can never spin forever).
      for (let guard = 0; guard < 32 && gl.getError() !== gl.NO_ERROR; guard++) {
        /* reading clears the flag */
      }
      renderer.render(scene, camera);
      return gl.getError();
    });
    assert.equal(err, 0, `gl.getError() returned ${err}`);
  });

  it('stats height range matches the mesh bounding box', async () => {
    const s = await stats();
    const box = await app.page.evaluate(() => {
      const g = window.__APP.terrain.geometry;
      g.computeBoundingBox();
      return [g.boundingBox.min.y, g.boundingBox.max.y];
    });
    assert.ok(
      Math.abs(box[0] - s.heightNums[0]) < 0.15,
      `bbox min ${box[0]} vs stats ${s.heightNums[0]}`
    );
    assert.ok(
      Math.abs(box[1] - s.heightNums[1]) < 0.15,
      `bbox max ${box[1]} vs stats ${s.heightNums[1]}`
    );
    assert.ok(box[0] <= box[1]);
  });

  it('live normals are unit length, upward and complete', async () => {
    const r = await app.page.evaluate(() => {
      const g = window.__APP.terrain.geometry;
      const pos = g.getAttribute('position');
      const nrm = g.getAttribute('normal');
      let nonUnit = 0;
      let downward = 0;
      let nonFinite = 0;
      let worst = 0;
      for (let v = 0; v < nrm.count; v++) {
        const x = nrm.getX(v);
        const y = nrm.getY(v);
        const z = nrm.getZ(v);
        const len = Math.hypot(x, y, z);
        if (!Number.isFinite(len)) {
          nonFinite++;
          continue;
        }
        if (Math.abs(len - 1) > 1e-5) nonUnit++;
        worst = Math.max(worst, Math.abs(len - 1));
        if (y <= 0) downward++;
      }
      return { count: nrm.count, posCount: pos.count, nonUnit, downward, nonFinite, worst };
    });

    assert.equal(r.nonFinite, 0, `${r.nonFinite} non-finite normals`);
    assert.equal(r.nonUnit, 0, `${r.nonUnit} normals off unit (worst ${r.worst})`);
    assert.equal(r.downward, 0, 'a heightfield normal must keep pointing up');
    assert.equal(r.count, r.posCount, 'normal attribute shorter than position');
  });

  it('live UVs span exactly 0..1 with corner anchors', async () => {
    const r = await app.page.evaluate(() => {
      const g = window.__APP.terrain.geometry;
      const uv = g.getAttribute('uv');
      const n = uv.count;
      let out = 0;
      let minU = 1;
      let maxU = 0;
      let minV = 1;
      let maxV = 0;
      for (let i = 0; i < n; i++) {
        const u = uv.getX(i);
        const v = uv.getY(i);
        if (u < 0 || u > 1 || v < 0 || v > 1) out++;
        minU = Math.min(minU, u);
        maxU = Math.max(maxU, u);
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      }
      return {
        n,
        N: Math.round(Math.sqrt(n)),
        out,
        minU,
        maxU,
        minV,
        maxV,
        first: [uv.getX(0), uv.getY(0)],
        last: [uv.getX(n - 1), uv.getY(n - 1)],
      };
    });

    assert.equal(r.out, 0, `${r.out} UVs outside 0..1`);
    assert.equal(r.n, r.N * r.N, 'UV count is not N²');
    assert.ok(Math.abs(r.minU) < 1e-6 && Math.abs(r.maxU - 1) < 1e-6, `u span ${r.minU}..${r.maxU}`);
    assert.ok(Math.abs(r.minV) < 1e-6 && Math.abs(r.maxV - 1) < 1e-6, `v span ${r.minV}..${r.maxV}`);
    assert.deepEqual(r.first, [0, 0], 'first vertex must anchor the UV origin');
    assert.deepEqual(r.last, [1, 1], 'last vertex must anchor the UV corner');
  });
});

describe('robustness under stress', () => {
  it('stays inside a build budget at every resolution', async () => {
    const budgets = [
      [16, 60],
      [64, 250],
      [128, 500],
      [256, 800],
    ];
    for (const [res, budget] of budgets) {
      await setSlider('resolution', res);
      await app.page.waitForFunction(
        (v) =>
          document.getElementById('statVerts').textContent.replace(/,/g, '') === String(v),
        res * res,
        { timeout: 15000 }
      );
      const s = await stats();
      assert.equal(s.verts, res * res, `resolution ${res}: wrong vertex count`);
      assert.ok(
        s.time > 0 && s.time < budget,
        `${res}² build took ${s.time} ms (budget ${budget} ms)`
      );
    }
  });

  it('survives every slider at its extremes', async () => {
    const cases = [
      ['seed', 0],
      ['seed', 9999],
      ['octaves', 1],
      ['octaves', 7],
      ['persistence', 0.2],
      ['persistence', 0.8],
      ['noiseScale', 0.5],
      ['noiseScale', 10],
      ['amplitude', 4],
      ['amplitude', 60],
      ['sunAzimuth', 0],
      ['sunAzimuth', 360],
      ['sunElevation', 5],
      ['sunElevation', 85],
    ];

    for (const [id, value] of cases) {
      await setSliderAndWait(id, value);
      const s = await stats();
      assert.equal(s.verts, 128 * 128, `${id}=${value} changed the vertex count`);
      assert.ok(
        Number.isFinite(s.heightNums[0]) && Number.isFinite(s.heightNums[1]),
        `${id}=${value}: non-finite height range ${s.height}`
      );
      assert.ok(
        s.heightNums[0] < s.heightNums[1],
        `${id}=${value}: no relief in ${s.height}`
      );
    }
    assert.deepEqual(app.errors, [], app.errors.join('\n'));
  });

  it('all toggles on at once keep rendering cleanly', async () => {
    for (const id of ['wireframe', 'showNormals', 'animateSun']) {
      await app.page.check(`#${id}`);
    }
    await app.page.waitForTimeout(450);

    const state = await app.page.evaluate(readFrame);
    const flags = await app.page.evaluate(() => ({
      wireframe: window.__APP.material.wireframe,
      normals: window.__APP.scene.children.some((o) => o.isLineSegments && o.visible),
      azimuth: window.__APP.params.sunAzimuth,
      err: window.__APP.renderer.getContext().getError(),
    }));

    assert.equal(flags.wireframe, true);
    assert.equal(flags.normals, true);
    assert.equal(flags.err, 0);
    assert.notEqual(flags.azimuth, 45, 'animateSun never moved the sun');
    assert.ok(state.terrain > 0, 'nothing was drawn with every toggle on');
    assert.deepEqual(app.errors, [], app.errors.join('\n'));

    for (const id of ['wireframe', 'showNormals', 'animateSun']) {
      await app.page.uncheck(`#${id}`);
    }
  });

  it('30 random regenerates never lose the GL context', async () => {
    const out = await app.page.evaluate(() => {
      const { renderer, scene, camera, params, rebuild } = window.__APP;
      const gl = renderer.getContext();
      const resolutions = [16, 64, 128, 256];
      const seen = [];
      for (let i = 0; i < 30; i++) {
        params.seed = Math.floor(Math.random() * 10000);
        params.resolution = resolutions[i % resolutions.length];
        seen.push(params.seed);
        rebuild();
        renderer.render(scene, camera);
      }
      return {
        lost: gl.isContextLost(),
        err: gl.getError(),
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        runs: seen.length,
      };
    });

    assert.equal(out.runs, 30);
    assert.equal(out.lost, false, 'GL context was lost during regeneration');
    assert.equal(out.err, 0, `gl.getError() = ${out.err}`);
    assert.ok(out.geometries <= 8, `${out.geometries} geometries alive after 30 rebuilds`);
    assert.equal(out.textures, 0, 'terrain must not allocate textures');
    assert.deepEqual(app.errors, [], app.errors.join('\n'));
  });

  it('renderer.info agrees with the stats panel after a resolution change', async () => {
    await setSlider('resolution', 64);
    await app.page.waitForFunction(
      () => document.getElementById('statVerts').textContent.replace(/,/g, '') === '4096',
      undefined,
      { timeout: 15000 }
    );
    const info = await app.page.evaluate(() => {
      const { renderer, scene, camera } = window.__APP;
      renderer.render(scene, camera);
      return {
        triangles: renderer.info.render.triangles,
        lines: renderer.info.render.lines,
        calls: renderer.info.render.calls,
      };
    });
    const s = await stats();

    assert.equal(info.triangles, s.tris, 'drawn triangles vs advertised triangles');
    assert.equal(info.lines, 0, 'no line draws expected with normal lines off');
    assert.ok(info.calls >= 1, 'no draw call issued');
  });

  it('wireframe swaps triangle draws for line draws', async () => {
    await app.page.check('#wireframe');
    const info = await app.page.evaluate(() => {
      const { renderer, scene, camera } = window.__APP;
      renderer.render(scene, camera);
      return {
        triangles: renderer.info.render.triangles,
        lines: renderer.info.render.lines,
      };
    });

    assert.equal(info.triangles, 0, 'wireframe should not emit triangle draws');
    assert.ok(info.lines > 0, `expected line draws, got ${info.lines}`);
    await app.page.uncheck('#wireframe');
  });

  it('the sun vector stays unit-length across a UI sweep', async () => {
    for (const [az, el] of [
      [0, 5],
      [90, 45],
      [180, 85],
      [235, 42],
      [360, 5],
      [55, 42],
    ]) {
      await setSlider('sunAzimuth', az);
      await setSlider('sunElevation', el);
      await app.page.waitForTimeout(60);
      const len = await app.page.evaluate(
        () => window.__APP.material.uniforms.uSunDir.value.length()
      );
      assert.ok(Math.abs(len - 1) < 1e-6, `az ${az}° el ${el}°: |L| = ${len}`);
    }
  });
});
