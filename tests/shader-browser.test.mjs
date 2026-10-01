/**
 * tests/shader-browser.test.mjs — the custom shader on a real GPU context.
 *
 * Compiles the GLSL the way three.js does (with its attribute/uniform
 * prefix), links it, then drives the material with a probe quad so the
 * height ramp, the slope mask and the lighting terms can be asserted on
 * actual framebuffer pixels.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { openApp } from './helpers.mjs';

const PORT = 8121;

let app;

before(async () => {
  app = await openApp(PORT);
}, { timeout: 60000 });

after(async () => {
  await app?.close();
});

const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

describe('GLSL compilation', () => {
  it('compiles both stages standalone with three.js’ shader prefix', async () => {
    const result = await app.page.evaluate(() => {
      const { material } = window.__APP;
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return { error: 'no webgl context' };

      // three prepends these declarations for a ShaderMaterial.
      const vertexPrefix = `
precision highp float;
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat3 normalMatrix;
uniform vec3 cameraPosition;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
`;
      const fragmentPrefix = `
precision highp float;
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
`;

      const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return {
          shader,
          ok: gl.getShaderParameter(shader, gl.COMPILE_STATUS),
          log: gl.getShaderInfoLog(shader),
        };
      };

      const vert = compile(gl.VERTEX_SHADER, vertexPrefix + material.vertexShader);
      const frag = compile(gl.FRAGMENT_SHADER, fragmentPrefix + material.fragmentShader);

      let linkOk = false;
      let linkLog = '';
      if (vert.ok && frag.ok) {
        const program = gl.createProgram();
        gl.attachShader(program, vert.shader);
        gl.attachShader(program, frag.shader);
        gl.linkProgram(program);
        linkOk = gl.getProgramParameter(program, gl.LINK_STATUS);
        linkLog = gl.getProgramInfoLog(program);
      }

      return { vertOk: vert.ok, vertLog: vert.log, fragOk: frag.ok, fragLog: frag.log, linkOk, linkLog };
    });

    assert.ok(!result.error, result.error);
    assert.equal(result.vertOk, true, `vertex: ${result.vertLog}`);
    assert.equal(result.fragOk, true, `fragment: ${result.fragLog}`);
    assert.equal(result.linkOk, true, `link: ${result.linkLog}`);
  });

  it('renders without three.js shader-error reports', async () => {
    const debug = await app.page.evaluate(() => {
      const { renderer, scene, camera, material } = window.__APP;
      renderer.debug.checkShaderErrors = true;
      renderer.render(scene, camera);
      return {
        checkShaderErrors: renderer.debug.checkShaderErrors,
        usedOurMaterial: renderer.properties !== undefined && material.isShaderMaterial === true,
        programs: (renderer.info.programs ?? []).length,
      };
    });
    assert.equal(debug.checkShaderErrors, true, 'shader errors would go unreported');
    assert.equal(debug.usedOurMaterial, true);
    assert.deepEqual(
      app.errors.filter((e) => /shader error|gl_|THREE\.WebGLProgram/i.test(e)),
      [],
      app.errors.join('\n')
    );
  });
});

describe('height -> uniform plumbing', () => {
  it('feeds the shader the same range shown in the stats panel', async () => {
    const data = await app.page.evaluate(() => {
      const { material } = window.__APP;
      return {
        min: material.uniforms.uMinHeight.value,
        max: material.uniforms.uMaxHeight.value,
        label: document.getElementById('statHeight').textContent,
      };
    });
    const [labelMin, labelMax] = data.label.split('..').map((v) => parseFloat(v));
    assert.ok(Math.abs(data.min - labelMin) < 0.1, `${data.min} vs ${labelMin}`);
    assert.ok(Math.abs(data.max - labelMax) < 0.1, `${data.max} vs ${labelMax}`);
  });

  it('updates the uniforms when the terrain is rebuilt', async () => {
    const before = await app.page.evaluate(() => {
      const { material } = window.__APP;
      return { min: material.uniforms.uMinHeight.value, max: material.uniforms.uMaxHeight.value };
    });

    const after = await app.page.evaluate(async () => {
      const el = document.getElementById('amplitude');
      el.value = '55';
      el.dispatchEvent(new Event('input'));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const { material } = window.__APP;
      return { min: material.uniforms.uMinHeight.value, max: material.uniforms.uMaxHeight.value };
    });

    assert.notEqual(after.min, before.min, 'uMinHeight unchanged');
    assert.notEqual(after.max, before.max, 'uMaxHeight unchanged');
    assert.ok(after.max - after.min > before.max - before.min, 'range should have grown');

    await app.page.evaluate(() => {
      const el = document.getElementById('amplitude');
      el.value = '26';
      el.dispatchEvent(new Event('input'));
    });
  });
});

describe('fragment shader behaviour (probe quad)', () => {
  const DEFAULT_ROWS = [0.03, 0.68, 0.97];

  /**
   * Renders a lit quad spanning y = 0..30 with a constant vertex normal and
   * samples it down the centre column.
   *
   *   opts.normal   normal shared by all four corners (default flat ground —
   *                 the slope mask keys off N.y, so probes must be explicit)
   *   opts.sun      direction TOWARD the sun
   *   opts.range    [min, max] height range handed to the shader
   *   opts.cameraZ  camera distance — this is what drives the fog term
   *   opts.uniforms extra uniform overrides, e.g. { uSpecular: 0.3 }
   *   opts.rows     normalised heights to sample
   *
   * Returns { bottom, middle, top } for the default rows, else the raw array.
   */
  const probe = (opts) =>
    app.page.evaluate(
      ({ normal, sun, range, cameraZ, uniforms, rows }) => {
        const { THREE, renderer, material } = window.__APP;

        // Remember every uniform we poke so the real app state is restored.
        const saved = [];
        const override = (key, value) => {
          saved.push([key, material.uniforms[key].value]);
          material.uniforms[key].value = value;
        };
        override('uMinHeight', range[0]);
        override('uMaxHeight', range[1]);
        for (const [key, value] of Object.entries(uniforms)) override(key, value);

        const savedSun = material.uniforms.uSunDir.value.clone();
        material.uniforms.uSunDir.value.copy(new THREE.Vector3(...sun));

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          'position',
          new THREE.BufferAttribute(
            new Float32Array([-20, 0, 0, 20, 0, 0, -20, 30, 0, 20, 30, 0]),
            3
          )
        );
        geometry.setAttribute(
          'normal',
          new THREE.BufferAttribute(
            new Float32Array([...normal, ...normal, ...normal, ...normal]),
            3
          )
        );
        geometry.setAttribute(
          'uv',
          new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2)
        );
        geometry.setIndex([0, 1, 2, 2, 1, 3]);

        const mesh = new THREE.Mesh(geometry, material);
        const scene = new THREE.Scene();
        scene.add(mesh);
        // Far plane must clear the fogged camera distances used by the probes.
        const camera = new THREE.OrthographicCamera(-20, 20, 30, 0, 0.1, 5000);
        camera.position.set(0, 0, cameraZ);

        renderer.setRenderTarget(null);
        renderer.render(scene, camera);

        const gl = renderer.getContext();
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

        const samples = rows.map((fy) => {
          const y = Math.min(h - 1, Math.max(0, Math.round(fy * (h - 1))));
          const o = (y * w + Math.floor(w / 2)) * 4;
          return [px[o], px[o + 1], px[o + 2]];
        });

        geometry.dispose();
        for (let i = saved.length - 1; i >= 0; i--) {
          material.uniforms[saved[i][0]].value = saved[i][1];
        }
        material.uniforms.uSunDir.value.copy(savedSun);
        return samples;
      },
      opts
    );

  const sampleProbe = async (opts) => {
    const merged = {
      normal: [0, 1, 0],
      sun: [0.5, 0.8, 0.3],
      range: [0, 30],
      cameraZ: 100,
      uniforms: {},
      rows: DEFAULT_ROWS,
      ...opts,
    };
    const out = await probe(merged);
    return opts.rows ? out : { bottom: out[0], middle: out[1], top: out[2] };
  };

  it('colours bottom valley / middle rock / top snow', async () => {
    // Normal (0,1,0) = flat ground (the shader's slope mask keys off N.y).
    const rows = await sampleProbe({ normal: [0, 1, 0], sun: [0.5, 0.8, 0.3] });
    const [br, bg, bb] = rows.bottom;
    const [mr, mg, mb] = rows.middle;
    const [tr, tg, tb] = rows.top;

    // valley: green dominates
    assert.ok(bg > br + 10 && bg > bb, `bottom not green: [${br},${bg},${bb}]`);
    // rock band: red channel leads
    assert.ok(mr > mg, `middle not rock: [${mr},${mg},${mb}]`);
    // snow: bright and near-neutral
    assert.ok(Math.min(tr, tg, tb) > 140, `top not bright: [${tr},${tg},${tb}]`);
    assert.ok(
      Math.max(tr, tg, tb) - Math.min(tr, tg, tb) < 60,
      `top not snow-neutral: [${tr},${tg},${tb}]`
    );
    // monotonic brightness with height
    assert.ok(lum(rows.top) > lum(rows.middle), 'top should be brighter than middle');
    assert.ok(lum(rows.middle) > lum(rows.bottom), 'middle should be brighter than bottom');
  });

  it('forces steep slopes to rock even at low altitude (slope mask)', async () => {
    // Same height, two normals: a flat ground normal vs a vertical wall.
    const flat = await sampleProbe({ normal: [0, 1, 0], sun: [0.5, 0.8, 0.3] });
    const wall = await sampleProbe({ normal: [1, 0, 0], sun: [0.5, 0.8, 0.3] });

    const [fr, fg] = flat.bottom;
    const [wr, wg] = wall.bottom;

    assert.ok(fg > fr, `flat ground should be green: [${fr},${fg}]`);
    assert.ok(wr > wg, `vertical wall should be rock: [${wr},${wg}]`);
    assert.ok(lum(wall.bottom) > lum(flat.bottom), 'the wall faces the sun, so it is lit');
  });

  it('brightness follows dot(N, L): sun-facing vs sun-away', async () => {
    // Deliberately a vertical wall normal (0,0,1): it keeps the slope mask
    // constant so this comparison isolates the lighting term. The half-vector
    // is intentionally NOT exactly -V — see the guard in shaders.js.
    const towards = await sampleProbe({ normal: [0, 0, 1], sun: [0, 0, 1] });
    const away = await sampleProbe({ normal: [0, 0, 1], sun: [0.6, 0.2, -1] });

    const lit = lum(towards.bottom);
    const dark = lum(away.bottom);

    assert.ok(dark > 0, 'shadow side must still receive ambient light');
    assert.ok(lit > dark * 2, `lit ${lit} should dwarf shadowed ${dark}`);
    assert.ok(lum(towards.top) > lum(away.top), 'same holds at the peaks');
  });

  it('produces finite, non-black output when the sun opposes the view', async () => {
    const rows = await sampleProbe({ normal: [0, 0, 1], sun: [0, 0, -1] });
    for (const [label, rgb] of Object.entries(rows)) {
      const [r, g, b] = rgb;
      assert.ok([r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255),
        `${label} not a valid byte colour: ${rgb}`);
      assert.ok(lum(rgb) > 0, `${label} came out black — possible NaN`);
    }
  });

  it('ramps through six distinct stops as height climbs', async () => {
    const samples = await sampleProbe({ rows: [0.02, 0.2, 0.45, 0.68, 0.8, 0.97] });
    const L = samples.map(lum);

    // valley floor -> grass climbs
    assert.ok(L[0] < L[1] && L[1] < L[2], `valley->grass not climbing: ${L}`);
    // rock band -> snow cap climbs
    assert.ok(L[3] < L[4] && L[4] < L[5], `rock->snow not climbing: ${L}`);
    // the cap outshines every lower stop
    assert.ok(L[5] > L[2], `snow should outshine mid-grass: ${L}`);
    // no two stops collapse onto the same colour
    assert.equal(
      new Set(samples.map((c) => c.join(','))).size,
      6,
      `stops collapsed: ${samples.map((c) => c.join('/'))}`
    );
  });

  it('re-maps the whole ramp when the height range changes (Y drives colour)', async () => {
    const base = { normal: [0, 1, 0], sun: [0.5, 0.8, 0.3] };
    const narrow = await sampleProbe(base); // range 0..30 -> t = 0.97 up top
    const wide = await sampleProbe({ ...base, range: [0, 60] }); // same altitude, t ≈ 0.49

    assert.ok(Math.min(...narrow.top) > 140, `narrow range should be snow: ${narrow.top}`);
    assert.ok(Math.min(...wide.top) < 140, `wide range should not be snow: ${wide.top}`);
    assert.ok(
      wide.top[1] > wide.top[0],
      `wide range top should read as grass/rock: ${wide.top}`
    );
    // The valley floor is t≈0 under both ranges, so it must not move.
    assert.ok(
      Math.abs(wide.bottom[1] - narrow.bottom[1]) < 12,
      `valley drifted: ${narrow.bottom} vs ${wide.bottom}`
    );
  });

  it('specular term tracks the half-vector (uShininess on)', async () => {
    // N = (0,0,1) freezes the slope mask. Both suns keep N·L = 0.9799; only
    // one of them mirrors the view vector, so H ∥ N only there.
    const base = {
      normal: [0, 0, 1],
      rows: [0.68],
      uniforms: { uSpecular: 0.3, uShininess: 40 },
    };
    const aligned = await sampleProbe({ ...base, sun: [0, 0.1999, 0.9799] });
    const swung = await sampleProbe({ ...base, sun: [0.1995, 0, 0.9799] });
    const d = lum(aligned[0]) - lum(swung[0]);

    assert.ok(
      d > 8,
      `aligned ${lum(aligned[0])} vs swung ${lum(swung[0])} — specular not responding to H`
    );
  });

  it('vanishes when uSpecular is zeroed (isolation check)', async () => {
    const base = {
      normal: [0, 0, 1],
      rows: [0.68],
      uniforms: { uShininess: 40 },
      sun: [0, 0.1999, 0.9799],
    };
    const lit = await sampleProbe({ ...base, uniforms: { uShininess: 40, uSpecular: 0.3 } });
    const matte = await sampleProbe({ ...base, uniforms: { uShininess: 40, uSpecular: 0 } });

    const d = lum(lit[0]) - lum(matte[0]);
    assert.ok(d > 20, `specular should lift the highlight by far more than ${d}`);
  });

  it('fades distant fragments into the sky colour (distance fog)', async () => {
    const opts = { normal: [0, 1, 0], sun: [0.5, 0.8, 0.3], rows: [0.4] };
    const near = await sampleProbe({ ...opts, cameraZ: 100 });
    const far = await sampleProbe({ ...opts, cameraZ: 700 });
    const SKY = [157, 192, 224]; // uFogColor 0x9dc0e0

    const dist = (c) => Math.hypot(c[0] - SKY[0], c[1] - SKY[1], c[2] - SKY[2]);
    assert.ok(dist(far[0]) < 30, `far sample ${far[0]} not fogged toward ${SKY}`);
    assert.ok(dist(near[0]) > 60, `near sample ${near[0]} should be un-fogged`);
    assert.ok(far[0][2] > far[0][0], `fogged fragment should be blue-dominant: ${far[0]}`);
  });

  it('dims flat ground when the sun sinks to the horizon (N·L term)', async () => {
    const opts = { normal: [0, 1, 0], rows: [0.4] };
    const noon = await sampleProbe({ ...opts, sun: [0, 1, 0] });
    const dusk = await sampleProbe({ ...opts, sun: [1, 0, 0] });

    const bright = lum(noon[0]);
    const dim = lum(dusk[0]);
    assert.ok(bright > dim * 2, `noon ${bright} vs dusk ${dim} — Lambert term not applied`);
    assert.ok(dim > 0, 'the horizon sun must still leave ambient light');
  });
});
