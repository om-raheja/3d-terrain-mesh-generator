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
  /** Renders a unit-lit quad spanning y = 0..30 and samples three rows. */
  const sampleProbe = (normal, sun) =>
    app.page.evaluate(
      ({ normal, sun }) => {
        const { THREE, renderer, material } = window.__APP;
        const savedMin = material.uniforms.uMinHeight.value;
        const savedMax = material.uniforms.uMaxHeight.value;
        const savedSun = material.uniforms.uSunDir.value.clone();

        material.uniforms.uMinHeight.value = 0;
        material.uniforms.uMaxHeight.value = 30;
        material.uniforms.uSunDir.value.copy(new THREE.Vector3(...sun));

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          'position',
          new THREE.BufferAttribute(
            new Float32Array([-20, 0, 0, 20, 0, 0, -20, 30, 0, 20, 30, 0]),
            3
          )
        );
        const n = normal;
        geometry.setAttribute(
          'normal',
          new THREE.BufferAttribute(
            new Float32Array([
              ...n, ...n, ...n, ...n,
            ]),
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
        const camera = new THREE.OrthographicCamera(-20, 20, 30, 0, 0.1, 500);
        camera.position.set(0, 0, 100);

        renderer.setRenderTarget(null);
        renderer.render(scene, camera);

        const gl = renderer.getContext();
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

        const at = (fy) => {
          const y = Math.min(h - 1, Math.max(0, Math.round(fy * (h - 1))));
          const o = (y * w + Math.floor(w / 2)) * 4;
          return [px[o], px[o + 1], px[o + 2]];
        };
        // y = 0.03 -> t 0.03 (valley), y = 0.68 -> t 0.68 (rock, before the
        // snow band starts at 0.74), y = 0.97 -> t 0.97 (snow cap).
        const rows = { bottom: at(0.03), middle: at(0.68), top: at(0.97) };

        geometry.dispose();
        material.uniforms.uMinHeight.value = savedMin;
        material.uniforms.uMaxHeight.value = savedMax;
        material.uniforms.uSunDir.value.copy(savedSun);
        return rows;
      },
      { normal, sun }
    );

  it('colours bottom valley / middle rock / top snow', async () => {
    // Normal (0,1,0) = flat ground (the shader's slope mask keys off N.y).
    const rows = await sampleProbe([0, 1, 0], [0.5, 0.8, 0.3]);
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
    const flat = await sampleProbe([0, 1, 0], [0.5, 0.8, 0.3]);
    const wall = await sampleProbe([1, 0, 0], [0.5, 0.8, 0.3]);

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
    const towards = await sampleProbe([0, 0, 1], [0, 0, 1]);
    const away = await sampleProbe([0, 0, 1], [0.6, 0.2, -1]);

    const lit = lum(towards.bottom);
    const dark = lum(away.bottom);

    assert.ok(dark > 0, 'shadow side must still receive ambient light');
    assert.ok(lit > dark * 2, `lit ${lit} should dwarf shadowed ${dark}`);
    assert.ok(lum(towards.top) > lum(away.top), 'same holds at the peaks');
  });

  it('produces finite, non-black output when the sun opposes the view', async () => {
    const rows = await sampleProbe([0, 0, 1], [0, 0, -1]);
    for (const [label, rgb] of Object.entries(rows)) {
      const [r, g, b] = rgb;
      assert.ok([r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255),
        `${label} not a valid byte colour: ${rgb}`);
      assert.ok(lum(rgb) > 0, `${label} came out black — possible NaN`);
    }
  });
});
