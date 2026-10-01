/**
 * tests/source.test.mjs — anti-cheat and project-contract checks.
 *
 * Guards the bounty's "we want to see your math" rule: the mesh must come
 * from our own code, not from built-in terrain/plane helpers or Three's
 * normal calculator.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const srcFiles = () =>
  readdirSync(join(ROOT, 'src'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ name: f, text: read(`src/${f}`) }));

describe('no built-in terrain or geometry helpers', () => {
  // Identifiers that must not appear anywhere in src/ (Three's own helpers).
  const BANNED_TYPES = [
    'PlaneGeometry',
    'TerrainGeometry',
    'MarchingCubes',
    'SimplexNoise',
    'ImprovedNoise',
    'terrainUtils',
  ];

  for (const api of BANNED_TYPES) {
    it(`src/ never uses ${api}`, () => {
      for (const { name, text } of srcFiles()) {
        // Word-boundary only: `buildTerrainGeometry` is our own function and
        // merely contains this substring.
        assert.ok(
          !new RegExp(`(?<!\\w)${api}\\b`).test(text),
          `${name} references the built-in ${api}`
        );
      }
    });
  }

  it("src/ never calls Three's computeVertexNormals() as a method", () => {
    for (const { name, text } of srcFiles()) {
      // terrain.js *defines* `function computeVertexNormals(` and calls it
      // bare — that is our own math. Only a method call would be cheating.
      assert.doesNotMatch(
        text,
        /\.\s*computeVertexNormals\s*\(/,
        `${name} calls geometry.computeVertexNormals()`
      );
      assert.doesNotMatch(text, /THREE\.computeVertexNormals/);
    }
  });

  it('never imports a terrain library', () => {
    for (const { name, text } of srcFiles()) {
      const specifiers = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const spec of specifiers) {
        const isLocal = spec.startsWith('./') || spec.startsWith('../');
        if (isLocal) continue; // our own modules (./terrain.js etc.)
        assert.ok(!/terrain|noise|height/i.test(spec), `${name} imports ${spec}`);
        assert.ok(
          spec === 'three' || spec.startsWith('three/'),
          `${name} imports unexpected package ${spec}`
        );
      }
    }
  });

  it('index.html only loads Three.js and OrbitControls', () => {
    const html = read('index.html');
    const urls = [...html.matchAll(/https?:\/\/[^"'`\s]+/g)].map((m) => m[0]);
    for (const url of urls) {
      assert.match(url, /cdn\.jsdelivr\.net\/npm\/three@/, `unexpected remote resource: ${url}`);
    }
  });
});

describe('mesh data is written explicitly', () => {
  const terrain = read('src/terrain.js');

  it('sets position, uv and normal attributes by hand', () => {
    assert.match(terrain, /setAttribute\s*\(\s*['"]position['"]/);
    assert.match(terrain, /setAttribute\s*\(\s*['"]uv['"]/);
    assert.match(terrain, /setAttribute\s*\(\s*['"]normal['"]/);
    assert.match(terrain, /setIndex\s*\(/);
  });

  it('allocates typed arrays directly (no geometry factory)', () => {
    assert.match(terrain, /new\s+Float32Array/);
    assert.match(terrain, /new\s+Uint32Array/);
    assert.doesNotMatch(terrain, /new\s+THREE\.(?!BufferGeometry)\w*Geometry/);
    assert.doesNotMatch(terrain, /BufferGeometry\s*\.\s*create/);
  });

  it('computes normals from cross products', () => {
    assert.match(terrain, /e1y\s*\*\s*e2z\s*-\s*e1z\s*\*\s*e2y/, 'cross product X');
    assert.match(terrain, /e1z\s*\*\s*e2x\s*-\s*e1x\s*\*\s*e2z/, 'cross product Y');
    assert.match(terrain, /e1x\s*\*\s*e2y\s*-\s*e1y\s*\*\s*e2x/, 'cross product Z');
    assert.match(terrain, /Math\.hypot\s*\(/, 'normalisation');
  });

  it('generates two triangles per quad with explicit indices', () => {
    assert.match(terrain, /indices\[k\+\+\]\s*=\s*a/);
    assert.match(terrain, /indices\[k\+\+\]\s*=\s*d/);
    assert.equal([...terrain.matchAll(/indices\[k\+\+\]/g)].length, 6);
  });
});

describe('shading is height driven', () => {
  const shader = read('src/shaders.js');

  it('is a hand-written GLSL ShaderMaterial', () => {
    assert.match(shader, /new\s+THREE\.ShaderMaterial/);
    assert.match(shader, /void\s+main\s*\(\s*\)/);
    assert.match(shader, /gl_FragColor/);
  });

  it('derives colour from world-space Y, not from UVs', () => {
    assert.match(shader, /vWorldPos\.y/);
    const fragmentBlock = shader.slice(shader.indexOf('const fragmentShader'));
    assert.doesNotMatch(fragmentBlock, /vUv\s*\./, 'colour must not be UV-driven');
  });

  it('ships the shader through the material, not a texture', () => {
    assert.doesNotMatch(shader, /map\s*:/);
    assert.doesNotMatch(shader, /TextureLoader/);
  });
});

describe('project contract', () => {
  it('package.json exposes start and test scripts', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.scripts.start, 'start script missing');
    assert.ok(pkg.scripts.test, 'test script missing');
    assert.ok(pkg.devDependencies.three, 'three should be a dev dependency (used by tests)');
  });

  it('index.html has the control panel and import map', () => {
    const html = read('index.html');
    assert.match(html, /type="importmap"/);
    assert.match(html, /type="module"/);
    for (const id of ['seed', 'resolution', 'noiseScale', 'octaves', 'amplitude', 'regenerate']) {
      assert.match(html, new RegExp(`id="${id}"`), `missing control #${id}`);
    }
  });

  it('README documents running, the math and the Loom walkthrough', () => {
    const md = read('README.md');
    for (const section of ['Run it', 'Normals', 'height shader', 'Loom', 'npm test']) {
      assert.ok(md.includes(section), `README is missing "${section}"`);
    }
  });

  it('every source file documents its purpose', () => {
    for (const { name, text } of srcFiles()) {
      assert.ok(
        text.trimStart().startsWith('/**'),
        `${name} lacks a module doc block`
      );
    }
  });

  it('gitignore excludes node_modules', () => {
    assert.match(read('.gitignore'), /node_modules/);
  });
});
