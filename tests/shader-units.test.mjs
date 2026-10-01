/**
 * tests/shader-units.test.mjs — material construction and the sun-direction
 * math, all running in Node (no GPU needed).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';

import { createTerrainMaterial, setSunAngles } from '../src/shaders.js';

const EXPECTED_UNIFORMS = [
  'uMinHeight',
  'uMaxHeight',
  'uSunDir',
  'uSunColor',
  'uAmbient',
  'uValley',
  'uGrass',
  'uRock',
  'uSnow',
  'uFogColor',
  'uFogRange',
  'uShininess',
  'uSpecular',
];

describe('material construction', () => {
  it('builds a custom ShaderMaterial, not a built-in material', () => {
    const material = createTerrainMaterial();
    assert.equal(material.type, 'ShaderMaterial');
    for (const builtin of [
      'MeshStandardMaterial',
      'MeshPhongMaterial',
      'MeshLambertMaterial',
      'MeshBasicMaterial',
    ]) {
      assert.notEqual(material.type, builtin);
    }
    assert.equal(material.isShaderMaterial, true);
    assert.notEqual(material.isRawShaderMaterial, true, 'built-in attribute prefix needed');
  });

  it('exposes every uniform the shader needs', () => {
    const { uniforms } = createTerrainMaterial();
    for (const name of EXPECTED_UNIFORMS) {
      assert.ok(uniforms[name], `missing uniform ${name}`);
      assert.ok('value' in uniforms[name], `uniform ${name} has no value`);
    }
    assert.equal(Object.keys(uniforms).length, EXPECTED_UNIFORMS.length);
  });

  it('starts with a sane min/max height range', () => {
    const { uniforms } = createTerrainMaterial();
    assert.ok(uniforms.uMinHeight.value < uniforms.uMaxHeight.value);
  });

  it('keeps fog near < far', () => {
    const { uniforms } = createTerrainMaterial();
    const [near, far] = uniforms.uFogRange.value;
    assert.ok(near > 0 && far > near, `fog range ${near}, ${far}`);
  });

  it('uses finite, non-negative colour values', () => {
    const { uniforms } = createTerrainMaterial();
    for (const name of ['uSunColor', 'uAmbient', 'uValley', 'uGrass', 'uRock', 'uSnow', 'uFogColor']) {
      const c = uniforms[name].value;
      assert.ok(c instanceof THREE.Color, `${name} not a THREE.Color`);
      for (const channel of ['r', 'g', 'b']) {
        assert.ok(Number.isFinite(c[channel]), `${name}.${channel} not finite`);
        assert.ok(c[channel] >= 0 && c[channel] <= 5, `${name}.${channel} = ${c[channel]}`);
      }
    }
  });

  it('starts with wireframe off and is toggleable', () => {
    const material = createTerrainMaterial();
    assert.equal(material.wireframe, false);
    material.wireframe = true;
    assert.equal(material.wireframe, true);
  });
});

describe('shader source contract', () => {
  const material = createTerrainMaterial();
  const vert = material.vertexShader;
  const frag = material.fragmentShader;

  const VARYINGS = ['vWorldPos', 'vNormal', 'vUv'];

  it('declares the same varyings in both stages (linkable)', () => {
    for (const v of VARYINGS) {
      const declV = new RegExp(`varying\\s+vec[234]\\s+${v}\\s*;`);
      assert.match(vert, declV, `vertex missing ${v}`);
      assert.match(frag, declV, `fragment missing ${v}`);
    }
    const vertVaryings = [...vert.matchAll(/varying\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1]).sort();
    const fragVaryings = [...frag.matchAll(/varying\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1]).sort();
    assert.deepEqual(vertVaryings, fragVaryings, 'varying sets differ');
  });

  it('reads the standard three.js vertex attributes', () => {
    assert.match(vert, /\bposition\b/);
    assert.match(vert, /\bnormal\b/);
    assert.match(vert, /\buv\b/);
  });

  it('projects with the model/view/projection matrices', () => {
    assert.match(vert, /projectionMatrix\s*\*\s*viewMatrix/);
    assert.match(vert, /modelMatrix\s*\*\s*vec4\s*\(\s*position/);
  });

  it('normalises world Y into 0..1 before colouring', () => {
    assert.match(frag, /vWorldPos\.y\s*-\s*uMinHeight/);
    assert.match(frag, /uMaxHeight\s*-\s*uMinHeight/);
    assert.match(frag, /clamp\s*\(/);
  });

  it('ramps colour through all four stops', () => {
    assert.match(frag, /vec3\s+c\s*=\s*uValley\s*;/, 'ramp never starts at the valley colour');
    for (const stop of ['uGrass', 'uRock', 'uSnow']) {
      assert.match(
        frag,
        new RegExp(`mix\\s*\\(\\s*c\\s*,\\s*${stop}`),
        `ramp never mixes in ${stop}`
      );
    }
    assert.match(frag, /smoothstep\s*\(/);
  });

  it('tints steep slopes to rock using the normal', () => {
    assert.match(frag, /1\.0\s*-\s*clamp\s*\(\s*N\.y/);
    assert.match(frag, /mix\s*\(\s*albedo\s*,\s*uRock/);
  });

  it('lights with Lambert diffuse and Blinn-Phong specular', () => {
    assert.match(frag, /max\s*\(\s*dot\s*\(\s*N\s*,\s*uSunDir\s*\)\s*,\s*0\.0\s*\)/);
    assert.match(frag, /halfway\s*=\s*uSunDir\s*\+\s*V/, 'half-vector missing');
    assert.match(
      frag,
      /halfway\s*\/\s*max\s*\(\s*length\s*\(\s*halfway\s*\)\s*,/,
      'half-vector must be guarded against a zero-length sum'
    );
    assert.match(frag, /pow\s*\(\s*max\s*\(\s*dot\s*\(\s*N\s*,\s*H\s*\)/);
  });

  it('guards every normalisation that could see a zero-length input', () => {
    assert.match(frag, /V\s*\/=\s*max\s*\(\s*length\s*\(\s*V\s*\)/, 'view vector');
    assert.match(frag, /H\s*=\s*halfway\s*\/\s*max/, 'half vector');
  });

  it('views from the real camera position', () => {
    assert.match(frag, /cameraPosition\s*-\s*vWorldPos/);
  });

  it('gamma-encodes the final colour', () => {
    assert.match(frag, /1\.0\s*\/\s*2\.2/);
  });

  it('is fully procedural: no textures sampled', () => {
    assert.doesNotMatch(frag, /uniform\s+sampler/);
    assert.doesNotMatch(vert, /uniform\s+sampler/);
  });

  it('reads the height uniforms it colours with', () => {
    for (const u of ['uMinHeight', 'uMaxHeight', 'uSunDir', 'uSunColor']) {
      assert.match(frag, new RegExp(`\\b${u}\\b`), `fragment never uses ${u}`);
    }
  });
});

describe('setSunAngles', () => {
  it('elevation 90 points straight up', () => {
    const { uniforms } = createTerrainMaterial();
    setSunAngles(uniforms, 0, 90);
    const d = uniforms.uSunDir.value;
    assert.ok(Math.abs(d.x) < 1e-12 && Math.abs(d.z) < 1e-12);
    assert.ok(Math.abs(d.y - 1) < 1e-12);
  });

  it('elevation 0 is horizontal, azimuth measured from +X', () => {
    const { uniforms } = createTerrainMaterial();
    setSunAngles(uniforms, 0, 0);
    let d = uniforms.uSunDir.value;
    assert.ok(Math.abs(d.x - 1) < 1e-12, `x ${d.x}`);

    setSunAngles(uniforms, 90, 0);
    d = uniforms.uSunDir.value;
    assert.ok(Math.abs(d.z - 1) < 1e-12, `z ${d.z}`);

    setSunAngles(uniforms, 180, 0);
    d = uniforms.uSunDir.value;
    assert.ok(Math.abs(d.x + 1) < 1e-12, `x ${d.x}`);

    setSunAngles(uniforms, 270, 0);
    d = uniforms.uSunDir.value;
    assert.ok(Math.abs(d.z + 1) < 1e-12, `z ${d.z}`);
  });

  it('tilts between horizontal and vertical at 45 degrees', () => {
    const { uniforms } = createTerrainMaterial();
    setSunAngles(uniforms, 0, 45);
    const d = uniforms.uSunDir.value;
    const s = Math.SQRT1_2;
    assert.ok(Math.abs(d.x - s) < 1e-12, `x ${d.x}`);
    assert.ok(Math.abs(d.y - s) < 1e-12, `y ${d.y}`);
  });

  it('always produces a unit vector (property sweep)', () => {
    const { uniforms } = createTerrainMaterial();
    for (let az = 0; az < 360; az += 7) {
      for (let el = 0; el <= 90; el += 5) {
        setSunAngles(uniforms, az, el);
        const d = uniforms.uSunDir.value;
        assert.ok(
          Math.abs(d.length() - 1) < 1e-12,
          `az=${az} el=${el} length ${d.length()}`
        );
        assert.ok(d.y >= -1e-12, `az=${az} el=${el} points below horizon`);
      }
    }
  });

  it('mutates the existing uniform (no reallocation)', () => {
    const { uniforms } = createTerrainMaterial();
    const before = uniforms.uSunDir.value;
    setSunAngles(uniforms, 33, 44);
    assert.equal(uniforms.uSunDir.value, before, 'uniform object was replaced');
  });

  it('is reversible: returning to the same angles gives the same vector', () => {
    const { uniforms } = createTerrainMaterial();
    setSunAngles(uniforms, 45, 42);
    const first = uniforms.uSunDir.value.clone();
    setSunAngles(uniforms, 200, 10);
    setSunAngles(uniforms, 45, 42);
    assert.ok(uniforms.uSunDir.value.distanceTo(first) < 1e-12);
  });
});
