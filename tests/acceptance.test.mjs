/**
 * tests/acceptance.test.mjs — the bounty's rubric, encoded as checks.
 *
 * Each describe block maps to one requirement from the brief:
 *   1. programmatic mesh generation (no built-in terrain tools)
 *   2. normals calculated correctly
 *   3. colour/shading driven by Y-height
 *   4. a ~2 minute Loom walkthrough explaining the maths
 *   5. a repository someone can clone and run
 *
 * These deliberately re-state criteria other files cover in more detail: this
 * file is the one a reviewer can read top to bottom and map to the rubric.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import * as THREE from 'three';

import { createHeightField } from '../src/noise.js';
import {
  buildGrid,
  buildNormalLines,
  buildTerrainGeometry,
  computeVertexNormals,
} from '../src/terrain.js';
import { createTerrainMaterial, setSunAngles } from '../src/shaders.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const srcFiles = () =>
  ['noise.js', 'terrain.js', 'shaders.js', 'main.js'].map((f) => ({
    name: f,
    text: read(`src/${f}`),
  }));

const SIZE = 240;

describe('criterion 1 — the mesh is generated programmatically', () => {
  it('a plain heightfield becomes positions, UVs and indices with no geometry factory', () => {
    const field = createHeightField({ resolution: 33, seed: 2024 });
    const { positions, uvs, indices, vertexCount } = buildGrid(field, SIZE);

    assert.equal(vertexCount, 33 * 33);
    assert.ok(positions instanceof Float32Array);
    assert.ok(uvs instanceof Float32Array);
    assert.ok(indices instanceof Uint32Array);
    assert.equal(indices.length, 32 * 32 * 6);

    // Y comes from the heightmap, XZ from the grid formula — the whole point.
    for (let idx = 0; idx < vertexCount; idx++) {
      assert.equal(positions[idx * 3 + 1], field.data[idx]);
    }
  });

  it('never reaches for a built-in terrain or plane helper', () => {
    const banned = [
      'PlaneGeometry',
      'TerrainGeometry',
      'MarchingCubes',
      'computeVertexNormals(',
      'SimplexNoise',
      'ImprovedNoise',
    ];
    for (const { name, text } of srcFiles()) {
      for (const api of banned) {
        if (api === 'computeVertexNormals(') {
          // our own definition is the deliverable; a *method* call would not be
          assert.doesNotMatch(text, /\.computeVertexNormals\s*\(/, name);
          continue;
        }
        assert.ok(
          !new RegExp(`(?<!\\w)${api}\\b`).test(text),
          `${name} uses built-in ${api}`
        );
      }
    }
  });

  it('only imports three.js plus its own modules', () => {
    for (const { name, text } of srcFiles()) {
      for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        const local = spec.startsWith('./') || spec.startsWith('../');
        assert.ok(
          local || spec === 'three' || spec.startsWith('three/'),
          `${name} imports ${spec}`
        );
      }
    }
  });

  it('writes every attribute explicitly rather than relying on defaults', () => {
    const terrain = read('src/terrain.js');
    for (const attr of ['position', 'uv', 'normal']) {
      assert.match(terrain, new RegExp(`setAttribute\\s*\\(\\s*['"]${attr}['"]`));
    }
    assert.match(terrain, /setIndex\s*\(/);
    assert.match(terrain, /cross|e1x\s*\*\s*e2y\s*-/, 'no explicit cross product');
  });
});

describe('criterion 2 — normals are calculated correctly', () => {
  it('every normal on the default scene config is finite, unit length and upward', () => {
    const field = createHeightField({ resolution: 128, seed: 1337, amplitude: 26 });
    const { positions, indices, vertexCount } = buildGrid(field, SIZE);
    const normals = computeVertexNormals(positions, indices);

    assert.equal(normals.length, vertexCount * 3);
    for (let v = 0; v < vertexCount; v++) {
      const o = v * 3;
      const len = Math.hypot(normals[o], normals[o + 1], normals[o + 2]);
      assert.ok(Number.isFinite(len), `vertex ${v} not finite`);
      assert.ok(Math.abs(len - 1) < 1e-6, `vertex ${v} length ${len}`);
      assert.ok(normals[o + 1] > 0, `vertex ${v} points downwards`);
    }
  });

  it('matches the analytic normal of the height field', () => {
    const N = 128;
    const field = createHeightField({ resolution: N, seed: 2024, amplitude: 34 });
    const { positions, indices } = buildGrid(field, SIZE);
    const normals = computeVertexNormals(positions, indices);
    const dx = SIZE / (N - 1);

    let sum = 0;
    let count = 0;
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        const idx = j * N + i;
        const dhdx = (field.data[idx + 1] - field.data[idx - 1]) / (2 * dx);
        const dhdz = (field.data[idx + N] - field.data[idx - N]) / (2 * dx);
        const len = Math.hypot(-dhdx, 1, -dhdz);
        const dot =
          (normals[idx * 3] * -dhdx +
            normals[idx * 3 + 1] +
            normals[idx * 3 + 2] * -dhdz) /
          len;
        sum += dot;
        count++;
      }
    }
    const mean = sum / count;
    assert.ok(mean > 0.99, `mean dot ${mean} against the analytic normal`);
  });

  it('the normal debug view is available so the maths can be shown on video', () => {
    const f = createHeightField({ resolution: 16 });
    const { positions, indices } = buildGrid(f, SIZE);
    const normals = computeVertexNormals(positions, indices);
    const lines = buildNormalLines(positions, normals, 2.5);
    assert.equal(lines.geometry.getAttribute('position').count, 16 * 16 * 2);
    assert.match(read('index.html'), /id="showNormals"/);
  });

  it('shading actually consumes the normals (N·L and a half-vector in the shader)', () => {
    const frag = createTerrainMaterial().fragmentShader;
    assert.match(frag, /dot\s*\(\s*N\s*,\s*uSunDir/);
    assert.match(frag, /dot\s*\(\s*N\s*,\s*H\s*\)/);
  });
});

describe('criterion 3 — colour and shading follow Y height', () => {
  const material = createTerrainMaterial();

  it('the vertex shader carries world-space Y to the fragment stage', () => {
    const vs = material.vertexShader;
    assert.match(vs, /vec4\s+worldPos\s*=\s*modelMatrix\s*\*\s*vec4\s*\(\s*position/);
    assert.match(vs, /vWorldPos\s*=\s*worldPos\.xyz/);
    assert.match(vs, /varying\s+vec3\s+vWorldPos/);
  });

  it('the fragment shader normalises Y with the terrain height range', () => {
    const frag = material.fragmentShader;
    assert.match(frag, /vWorldPos\.y\s*-\s*uMinHeight/);
    assert.match(frag, /uMaxHeight\s*-\s*uMinHeight/);
    assert.match(frag, /clamp\s*\(/);
  });

  it('ramps through valley → grass → rock → snow in height order', () => {
    const frag = material.fragmentShader;
    // Inspect the ramp() body specifically, not the uniform declarations.
    const body = frag.slice(frag.indexOf('vec3 ramp('), frag.indexOf('void main()'));
    const stops = ['uValley', 'uGrass', 'uRock', 'uSnow'];
    let cursor = 0;
    for (const stop of stops) {
      const at = body.indexOf(stop);
      assert.ok(at > cursor, `${stop} appears out of order in the ramp`);
      cursor = at;
    }
    assert.match(body, /smoothstep/);
  });

  it('exposes the height range and four ramp colours as uniforms', () => {
    const { uniforms } = material;
    for (const key of ['uMinHeight', 'uMaxHeight', 'uValley', 'uGrass', 'uRock', 'uSnow']) {
      assert.ok(uniforms[key], `missing ${key}`);
    }
    assert.ok(uniforms.uMinHeight.value < uniforms.uMaxHeight.value);
    for (const key of ['uValley', 'uGrass', 'uRock', 'uSnow']) {
      assert.ok(uniforms[key].value instanceof THREE.Color, `${key} not a colour`);
    }
  });

  it('slopes are re-tinted to rock so cliffs read as rock at any altitude', () => {
    assert.match(material.fragmentShader, /1\.0\s*-\s*clamp\s*\(\s*N\.y/);
    assert.match(material.fragmentShader, /mix\s*\(\s*albedo\s*,\s*uRock/);
  });

  it('lighting combines ambient, Lambert and a specular term', () => {
    const { uniforms, fragmentShader } = material;
    assert.match(fragmentShader, /uAmbient/);
    assert.match(fragmentShader, /uSunColor/);
    assert.match(fragmentShader, /uShininess/);
    assert.ok(uniforms.uShininess.value > 0);
    assert.ok(uniforms.uSpecular.value >= 0);
  });

  it('the sun vector is a live uniform the UI can aim', () => {
    const { uniforms } = material;
    setSunAngles(uniforms, 123, 55);
    const d = uniforms.uSunDir.value;
    assert.ok(Math.abs(d.length() - 1) < 1e-12);
    assert.ok(Math.abs(d.y - Math.sin((55 * Math.PI) / 180)) < 1e-12);
  });

  it('is hand-written GLSL shipped through a ShaderMaterial', () => {
    assert.equal(material.type, 'ShaderMaterial');
    assert.match(material.vertexShader, /void\s+main\s*\(\s*\)/);
    assert.match(material.fragmentShader, /void\s+main\s*\(\s*\)/);
    assert.match(material.fragmentShader, /gl_FragColor/);
    assert.doesNotMatch(material.fragmentShader, /uniform\s+sampler/, 'no textures');
  });
});

describe('criterion 4 — the maths is explained for the Loom walkthrough', () => {
  const readme = read('README.md');

  it('documents each stage of the pipeline', () => {
    for (const section of [
      '## Run it',
      '## Acceptance criteria',
      '## How it works',
      '## Controls',
      '## Tests',
      '## Project layout',
    ]) {
      assert.ok(readme.includes(section), `README is missing "${section}"`);
    }
  });

  it('explains the noise, the mesh and the normal formulas', () => {
    assert.match(readme, /fBm|fractional Brownian/i);
    assert.match(readme, /e1\s*×\s*e2|cross/i);
    assert.match(readme, /normalize/);
    assert.match(readme, /smoothstep|clamp/i);
  });

  it('ships a timed script with at least six beats that fits inside 2:30', () => {
    const beats = [...readme.matchAll(/\*\*(\d+):(\d{2}) — /g)].map(
      (m) => Number(m[1]) * 60 + Number(m[2])
    );
    assert.ok(beats.length >= 6, `only ${beats.length} beats found`);
    for (let i = 1; i < beats.length; i++) {
      assert.ok(beats[i] > beats[i - 1], `beat ${i + 1} is not later than beat ${i}`);
    }
    assert.ok(beats[0] === 0, 'the script should start at 0:00');
    assert.ok(beats[beats.length - 1] <= 150, 'script must fit a ~2 min Loom');
  });

  it('points at the runnable command in the wrap-up beat', () => {
    assert.match(readme, /npm test/);
    assert.match(readme, /Loom/i);
  });
});

describe('criterion 5 — it is a runnable repository', () => {
  it('has start and test scripts', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.scripts.start);
    assert.ok(pkg.scripts.test);
    assert.equal(pkg.type, 'module');
  });

  it('ignores node_modules', () => {
    assert.match(read('.gitignore'), /node_modules/);
  });

  it('includes a licence file', () => {
    assert.ok(existsSync(join(ROOT, 'LICENSE')), 'LICENSE missing');
    assert.match(read('LICENSE'), /MIT License/);
  });

  it('boots from index.html with an import map and one module entry', () => {
    const html = read('index.html');
    assert.match(html, /type="importmap"/);
    assert.match(html, /src="\.\/src\/main\.js"/);
    assert.match(html, /cdn\.jsdelivr\.net\/npm\/three/);
    assert.match(html, /id="seed"/);
    assert.match(html, /id="resolution"/);
  });

  it('the full pipeline runs end to end without throwing', () => {
    const field = createHeightField({ resolution: 64, seed: 42 });
    const { geometry, vertexCount, triangleCount } = buildTerrainGeometry(field, SIZE);
    assert.equal(vertexCount, 64 * 64);
    assert.equal(triangleCount, 2 * 63 * 63);
    assert.ok(geometry.boundingSphere.radius > 0);

    const material = createTerrainMaterial();
    material.uniforms.uMinHeight.value = field.min;
    material.uniforms.uMaxHeight.value = field.max;
    assert.ok(material.uniforms.uMaxHeight.value > material.uniforms.uMinHeight.value);
  });
});
