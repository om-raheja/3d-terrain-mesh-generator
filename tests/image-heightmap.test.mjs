/**
 * tests/image-heightmap.test.mjs — the image → heightfield input path.
 *
 * heightFieldFromRGBA() is pure pixel maths, so it is exercised directly in
 * Node. The pipeline assertions then push an image field through the very
 * same buildGrid / computeVertexNormals / shader code the noise tests use —
 * proving an image is an ordinary heightmap, not a parallel code path.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { heightFieldFromRGBA } from '../src/image-heightmap.js';
import { createHeightField } from '../src/noise.js';
import { buildTerrainGeometry, buildGrid, computeVertexNormals } from '../src/terrain.js';
import { createTerrainMaterial } from '../src/shaders.js';

const AMP = 26;
const opts = (resolution, amplitude = AMP) => ({ resolution, amplitude });

/** A width x height RGBA image filled with one colour. */
function solid(r, g, b, { a = 255, width = 4, height = 4 } = {}) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4 + 0] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = a;
  }
  return { pixels, width, height };
}

/** Vertical black → white gradient: row j holds grey level j/(height-1). */
function ramp({ width = 4, height = 8 } = {}) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let j = 0; j < height; j++) {
    const v = Math.round((j / (height - 1)) * 255);
    for (let i = 0; i < width; i++) {
      const o = (j * width + i) * 4;
      pixels[o] = v;
      pixels[o + 1] = v;
      pixels[o + 2] = v;
      pixels[o + 3] = 255;
    }
  }
  return { pixels, width, height };
}

describe('heightFieldFromRGBA matches the noise field contract', () => {
  it('returns exactly the shape createHeightField returns', () => {
    const { pixels, width, height } = solid(128, 128, 128);
    const image = heightFieldFromRGBA(pixels, width, height, opts(16));
    const noise = createHeightField({ resolution: 16, seed: 7 });

    assert.deepEqual(Object.keys(image).sort(), Object.keys(noise).sort());
    assert.ok(image.data instanceof Float32Array);
    assert.equal(Number.isInteger(image.resolution), true);
    assert.equal(Number.isFinite(image.min), true);
    assert.equal(Number.isFinite(image.max), true);
    assert.equal(image.amplitude, AMP);
  });

  it('allocates resolution^2 samples', () => {
    for (const resolution of [2, 16, 64]) {
      const { pixels, width, height } = solid(10, 20, 30);
      const field = heightFieldFromRGBA(pixels, width, height, opts(resolution));
      assert.equal(field.data.length, resolution * resolution, `${resolution}^2`);
      assert.equal(field.resolution, resolution);
    }
  });

  it('reports min/max over the stored Float32 values', () => {
    const { pixels, width, height } = ramp({ height: 9 });
    const field = heightFieldFromRGBA(pixels, width, height, opts(16));
    assert.equal(field.min, Math.min(...field.data));
    assert.equal(field.max, Math.max(...field.data));
  });

  it('accepts a flat image (min === max) without producing NaN', () => {
    const { pixels, width, height } = solid(200, 200, 200);
    const field = heightFieldFromRGBA(pixels, width, height, opts(8));
    assert.equal(field.min, field.max);
    assert.equal(field.data.every((y) => Number.isFinite(y)), true);
  });
});

describe('brightness maps to height', () => {
  it('white rises to +amplitude', () => {
    const { pixels, width, height } = solid(255, 255, 255);
    const field = heightFieldFromRGBA(pixels, width, height, opts(4));
    assert.equal(field.min, AMP);
    assert.equal(field.max, AMP);
  });

  it('black sinks to -amplitude', () => {
    const { pixels, width, height } = solid(0, 0, 0);
    const field = heightFieldFromRGBA(pixels, width, height, opts(4));
    assert.equal(field.min, -AMP);
    assert.equal(field.max, -AMP);
  });

  it('mid-grey sits at sea level', () => {
    const { pixels, width, height } = solid(128, 128, 128);
    const field = heightFieldFromRGBA(pixels, width, height, opts(4));
    assert.ok(Math.abs(field.min) < 0.25, `grey should be ~0, got ${field.min}`);
    assert.equal(field.min, field.max);
  });

  it('uses BT.601 luma: green reads higher than red', () => {
    const red = solid(255, 0, 0);
    const green = solid(0, 255, 0);
    const redY = heightFieldFromRGBA(red.pixels, red.width, red.height, opts(4)).min;
    const greenY = heightFieldFromRGBA(green.pixels, green.width, green.height, opts(4)).min;
    // (0.587 - 0.299) * 2 * amplitude
    const expected = (0.587 - 0.299) * 2 * AMP;
    assert.ok(Math.abs(greenY - redY - expected) < 1e-3, `${greenY - redY} vs ${expected}`);
    assert.ok(redY < 0, 'red is darker than grey');
    assert.ok(greenY > 0, 'green is brighter than grey');
  });

  it('ignores the alpha channel (altitude is not opacity)', () => {
    const opaque = solid(40, 90, 200, { a: 255 });
    const clear = solid(40, 90, 200, { a: 0 });
    const a = heightFieldFromRGBA(opaque.pixels, opaque.width, opaque.height, opts(16));
    const b = heightFieldFromRGBA(clear.pixels, clear.width, clear.height, opts(16));
    assert.deepEqual(Array.from(a.data), Array.from(b.data));
  });

  it('a black→white ramp rises monotonically across rows', () => {
    const { pixels, width, height } = ramp({ height: 8 });
    const resolution = 8;
    const field = heightFieldFromRGBA(pixels, width, height, opts(resolution));
    for (let j = 1; j < resolution; j++) {
      for (let i = 0; i < resolution; i++) {
        const prev = field.data[(j - 1) * resolution + i];
        const now = field.data[j * resolution + i];
        assert.ok(now > prev, `row ${j} col ${i}: ${now} should exceed ${prev}`);
      }
    }
    assert.ok(field.min < -AMP + 1, 'darkest row approaches -amplitude');
    assert.ok(field.max > AMP - 1, 'brightest row approaches +amplitude');
  });
});

describe('resampling any source onto the grid', () => {
  it('interpolates a 2x2 source bilinearly', () => {
    // top row black, bottom row white → rows land on -A, 0, +A at res 3.
    const pixels = new Uint8ClampedArray([
      0, 0, 0, 255, 0, 0, 0, 255,
      255, 255, 255, 255, 255, 255, 255, 255,
    ]);
    const field = heightFieldFromRGBA(pixels, 2, 2, opts(3));
    const row = (j) => [field.data[j * 3], field.data[j * 3 + 1], field.data[j * 3 + 2]];
    for (const y of row(0)) assert.ok(Math.abs(y - -AMP) < 1e-4, `top ${y}`);
    for (const y of row(1)) assert.ok(Math.abs(y) < 1e-4, `middle ${y}`);
    for (const y of row(2)) assert.ok(Math.abs(y - AMP) < 1e-4, `bottom ${y}`);
  });

  it('stretches a non-square source (8x2) onto a square grid', () => {
    const { pixels, width, height } = solid(128, 128, 128, { width: 8, height: 2 });
    const field = heightFieldFromRGBA(pixels, width, height, opts(32));
    assert.equal(field.data.length, 32 * 32);
    assert.equal(field.data.every((y) => Number.isFinite(y)), true);
  });

  it('downsamples a large source (64x64 → 8)', () => {
    const { pixels, width, height } = ramp({ width: 64, height: 64 });
    const field = heightFieldFromRGBA(pixels, width, height, opts(8));
    assert.equal(field.data.length, 64);
    assert.ok(field.max > field.min, 'ramp survives downsampling');
  });

  it('accepts a single-pixel source', () => {
    const { pixels, width, height } = solid(0, 0, 0, { width: 1, height: 1 });
    const field = heightFieldFromRGBA(pixels, width, height, opts(8));
    assert.equal(field.data.length, 64);
    assert.equal(field.max, -AMP);
  });

  it('is deterministic', () => {
    const { pixels, width, height } = ramp({ width: 5, height: 3 });
    const a = heightFieldFromRGBA(pixels, width, height, opts(24));
    const b = heightFieldFromRGBA(pixels, width, height, opts(24));
    assert.deepEqual(Array.from(a.data), Array.from(b.data));
    assert.equal(a.min, b.min);
    assert.equal(a.max, b.max);
  });
});

describe('validation fails loudly', () => {
  const { pixels, width, height } = solid(0, 0, 0);

  it('rejects a resolution below 2', () => {
    assert.throws(() => heightFieldFromRGBA(pixels, width, height, opts(1)), RangeError);
  });

  it('rejects a non-integer resolution', () => {
    assert.throws(() => heightFieldFromRGBA(pixels, width, height, opts(2.5)), RangeError);
  });

  it('rejects a non-finite amplitude', () => {
    assert.throws(() => heightFieldFromRGBA(pixels, width, height, opts(4, NaN)), RangeError);
    assert.throws(() => heightFieldFromRGBA(pixels, width, height, opts(4, Infinity)), RangeError);
    assert.throws(() => heightFieldFromRGBA(pixels, width, height, { resolution: 4 }), RangeError);
  });

  it('rejects zero or negative image dimensions', () => {
    assert.throws(() => heightFieldFromRGBA(pixels, 0, height, opts(4)), RangeError);
    assert.throws(() => heightFieldFromRGBA(pixels, width, -2, opts(4)), RangeError);
  });

  it('rejects a pixel buffer of the wrong length', () => {
    assert.throws(() => heightFieldFromRGBA(pixels.subarray(0, 3), 1, 1, opts(4)), RangeError);
    assert.throws(() => heightFieldFromRGBA(null, width, height, opts(4)), RangeError);
  });
});

describe('an image field drives the same mesh + shader pipeline', () => {
  it('builds vertices, UVs and triangles through buildTerrainGeometry', () => {
    const { pixels, width, height } = ramp({ height: 8 });
    const field = heightFieldFromRGBA(pixels, width, height, opts(16));
    const { geometry, vertexCount, triangleCount } = buildTerrainGeometry(field, 240);

    assert.equal(vertexCount, 16 * 16);
    assert.equal(triangleCount, 2 * 15 * 15);
    assert.equal(geometry.getAttribute('position').count, 256);
    assert.equal(geometry.getAttribute('uv').count, 256);
    assert.equal(geometry.getAttribute('normal').count, 256);
    assert.ok(geometry.boundingSphere.radius > 0);
  });

  it('puts the image heights straight into vertex Y', () => {
    const { pixels, width, height } = ramp({ height: 8 });
    const field = heightFieldFromRGBA(pixels, width, height, opts(16));
    const { positions } = buildGrid(field, 240);
    for (let i = 0; i < field.data.length; i++) {
      assert.equal(positions[i * 3 + 1], field.data[i], `vertex ${i}`);
    }
  });

  it('a flat image gives every normal +Y (a valid lighting basis)', () => {
    const { pixels, width, height } = solid(128, 128, 128);
    const field = heightFieldFromRGBA(pixels, width, height, opts(16));
    const normals = computeVertexNormals(
      buildGrid(field, 240).positions,
      buildGrid(field, 240).indices
    );
    for (let v = 0; v < normals.length; v += 3) {
      assert.ok(Math.abs(normals[v]) < 1e-6, `x at ${v}: ${normals[v]}`);
      assert.ok(Math.abs(normals[v + 1] - 1) < 1e-6, `y at ${v}: ${normals[v + 1]}`);
      assert.ok(Math.abs(normals[v + 2]) < 1e-6, `z at ${v}: ${normals[v + 2]}`);
    }
  });

  it('a ramped image tilts normals off +Y (lighting can see the slope)', () => {
    const { pixels, width, height } = ramp({ height: 8 });
    const field = heightFieldFromRGBA(pixels, width, height, opts(32));
    const { positions, indices } = buildGrid(field, 240);
    const normals = computeVertexNormals(positions, indices);

    let maxTilt = 0;
    for (let v = 0; v < normals.length; v += 3) {
      maxTilt = Math.max(maxTilt, Math.hypot(normals[v], normals[v + 2]));
    }
    assert.ok(maxTilt > 0.05, `expected slopes to tilt normals, max tilt ${maxTilt}`);
    assert.ok(maxTilt < 1, 'normals stay unit length, never fully horizontal');
  });

  it('feeds the shader the image range, so t spans valley→snow', () => {
    const { pixels, width, height } = ramp({ height: 8 });
    const field = heightFieldFromRGBA(pixels, width, height, opts(16));

    const material = createTerrainMaterial();
    material.uniforms.uMinHeight.value = field.min;
    material.uniforms.uMaxHeight.value = field.max;

    const span = Math.max(
      material.uniforms.uMaxHeight.value - material.uniforms.uMinHeight.value,
      1e-4
    );
    const at = (y) => Math.min(1, Math.max(0, (y - material.uniforms.uMinHeight.value) / span));

    assert.equal(at(field.min), 0); // darkest pixels → uValley
    assert.equal(at(field.max), 1); // brightest pixels → uSnow
    assert.ok(material.uniforms.uMaxHeight.value > material.uniforms.uMinHeight.value);
  });
});
