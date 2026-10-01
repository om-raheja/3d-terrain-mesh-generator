/**
 * tests/noise.test.mjs — the 2D heightmap generator.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createHeightField, createPerlin2D, fbm, mulberry32 } from '../src/noise.js';

const OCTS = { octaves: 5, frequency: 3, persistence: 0.5, lacunarity: 2 };

describe('mulberry32 PRNG', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const seqA = Array.from({ length: 50 }, a);
    const seqB = Array.from({ length: 50 }, b);
    assert.deepEqual(seqA, seqB);
  });

  it('produces different streams for different seeds', () => {
    const a = Array.from({ length: 20 }, mulberry32(1));
    const b = Array.from({ length: 20 }, mulberry32(2));
    assert.notDeepEqual(a, b);
  });

  it('stays inside [0, 1)', () => {
    const rand = mulberry32(99);
    for (let i = 0; i < 5000; i++) {
      const v = rand();
      assert.ok(v >= 0 && v < 1, `value ${v} out of range`);
    }
  });

  it('is roughly uniform (mean near 0.5)', () => {
    const rand = mulberry32(3);
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) sum += rand();
    assert.ok(Math.abs(sum / n - 0.5) < 0.02, `mean ${sum / n}`);
  });
});

describe('Perlin noise', () => {
  it('is deterministic for the same seed', () => {
    const a = createPerlin2D(42);
    const b = createPerlin2D(42);
    assert.equal(a(1.3, 2.7), b(1.3, 2.7));
    assert.equal(a(0.1, 0.9), b(0.1, 0.9));
  });

  it('changes with the seed', () => {
    const a = createPerlin2D(42);
    const b = createPerlin2D(43);
    assert.notEqual(a(1.3, 2.7), b(1.3, 2.7));
  });

  it('is zero on integer lattice points (classic Perlin property)', () => {
    const noise = createPerlin2D(11);
    for (const [x, y] of [
      [0, 0],
      [3, 7],
      [-5, 12],
      [20, -4],
    ]) {
      assert.ok(
        Math.abs(noise(x, y)) < 1e-9,
        `noise(${x}, ${y}) = ${noise(x, y)}`
      );
    }
  });

  it('stays bounded (gradient set is not unit-length: ±1.4 envelope)', () => {
    const noise = createPerlin2D(5);
    let max = 0;
    for (let x = 0; x < 300; x += 0.17) {
      for (let y = 0; y < 300; y += 0.23) {
        max = Math.max(max, Math.abs(noise(x, y)));
      }
    }
    assert.ok(max > 1.0, `noise looks collapsed, max ${max}`);
    assert.ok(max < 1.45, `max |noise| = ${max} escaped the ±1.4 envelope`);
  });

  it('has near-zero mean over a large sample', () => {
    const noise = createPerlin2D(17);
    let sum = 0;
    let n = 0;
    for (let x = 0; x < 200; x += 0.31) {
      for (let y = 0; y < 200; y += 0.37) {
        sum += noise(x, y);
        n++;
      }
    }
    assert.ok(Math.abs(sum / n) < 0.08, `mean ${sum / n}`);
  });

  it('is continuous (no value jumps between close samples)', () => {
    const noise = createPerlin2D(23);
    let maxStep = 0;
    let prev = noise(0, 3.5);
    for (let x = 0.001; x < 40; x += 0.001) {
      const v = noise(x, 3.5);
      maxStep = Math.max(maxStep, Math.abs(v - prev));
      prev = v;
    }
    assert.ok(maxStep < 0.02, `max step ${maxStep} — discontinuity?`);
  });

  it('interpolates smoothly: same input, same output regardless of history', () => {
    const noise = createPerlin2D(8);
    const first = noise(4.25, 9.75);
    noise(1000, 1000); // wander far away
    assert.equal(noise(4.25, 9.75), first);
  });
});

describe('fBm', () => {
  it('equals the base noise when octaves = 1', () => {
    const noise = createPerlin2D(64);
    const opts = { ...OCTS, octaves: 1 };
    for (const [x, y] of [
      [0.4, 0.9],
      [7.2, 3.1],
    ]) {
      assert.equal(fbm(noise, x, y, opts), noise(x * opts.frequency, y * opts.frequency));
    }
  });

  it('equals the first octave alone when persistence = 0', () => {
    const noise = createPerlin2D(64);
    const opts = { ...OCTS, octaves: 6, persistence: 0 };
    assert.equal(fbm(noise, 2.5, 1.5, opts), noise(2.5 * opts.frequency, 1.5 * opts.frequency));
  });

  it('stays inside the noise envelope regardless of octave count', () => {
    const noise = createPerlin2D(31);
    for (const octaves of [1, 3, 7]) {
      let max = 0;
      for (let x = 0; x < 40; x += 0.4) {
        for (let y = 0; y < 40; y += 0.4) {
          max = Math.max(max, Math.abs(fbm(noise, x, y, { ...OCTS, octaves })));
        }
      }
      // Normalising by the summed amplitude means extra octaves add detail,
      // not magnitude.
      assert.ok(max < 1.45, `octaves=${octaves} max ${max} exceeds the envelope`);
    }
  });

  it('more octaves add high-frequency detail', () => {
    const noise = createPerlin2D(3);
    // With persistence 0.5 and lacunarity 2 each octave's *slope* is constant
    // (amplitude·frequency = 1), so plain total variation deliberately does
    // not grow with octave count — that is the classic 1/f property. What
    // does grow is curvature (amplitude·frequency², doubling per octave), so
    // measure the discrete Laplacian: it is exactly the fine detail a viewer
    // sees as "more octaves".
    const d = 0.001;
    const curvature = (octaves) => {
      let sum = 0;
      for (let x = d; x < 12; x += d) {
        const a = fbm(noise, x - d, 4.5, { ...OCTS, octaves });
        const b = fbm(noise, x, 4.5, { ...OCTS, octaves });
        const c = fbm(noise, x + d, 4.5, { ...OCTS, octaves });
        sum += Math.abs(a - 2 * b + c);
      }
      return sum;
    };
    const c1 = curvature(1);
    const c3 = curvature(3);
    const c7 = curvature(7);
    assert.ok(c1 > 0, 'curvature must be measurable');
    assert.ok(c3 > c1 * 2, `curvature(3)=${c3} vs curvature(1)=${c1}`);
    assert.ok(c7 > c3 * 2, `curvature(7)=${c7} vs curvature(3)=${c3}`);
  });

  it('higher frequency produces more zero crossings', () => {
    const noise = createPerlin2D(12);
    const crossings = (frequency) => {
      let count = 0;
      let prev = fbm(noise, 0, 2, { ...OCTS, octaves: 1, frequency });
      for (let x = 0.05; x < 50; x += 0.05) {
        const v = fbm(noise, x, 2, { ...OCTS, octaves: 1, frequency });
        if (prev < 0 !== v < 0) count++;
        prev = v;
      }
      return count;
    };
    assert.ok(crossings(8) > crossings(2), 'higher frequency should cross zero more often');
  });
});

describe('createHeightField', () => {
  it('allocates resolution^2 samples', () => {
    for (const resolution of [16, 65, 128]) {
      const field = createHeightField({ resolution });
      assert.equal(field.data.length, resolution * resolution);
      assert.equal(field.resolution, resolution);
    }
  });

  it('min/max match the actual extremes of the data', () => {
    const field = createHeightField({ resolution: 96, seed: 4 });
    let min = Infinity;
    let max = -Infinity;
    for (const v of field.data) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    assert.equal(field.min, min);
    assert.equal(field.max, max);
    assert.ok(field.max > field.min, 'terrain must have relief');
  });

  it('is deterministic for identical parameters', () => {
    const a = createHeightField({ resolution: 48, seed: 777 });
    const b = createHeightField({ resolution: 48, seed: 777 });
    assert.deepEqual(Array.from(a.data), Array.from(b.data));
  });

  it('changes when the seed changes', () => {
    const a = createHeightField({ resolution: 48, seed: 777 });
    const b = createHeightField({ resolution: 48, seed: 778 });
    assert.notDeepEqual(Array.from(a.data), Array.from(b.data));
  });

  it('scales linearly with amplitude', () => {
    const a = createHeightField({ resolution: 64, seed: 9, amplitude: 10 });
    const b = createHeightField({ resolution: 64, seed: 9, amplitude: 20 });
    for (let i = 0; i < a.data.length; i++) {
      assert.ok(
        Math.abs(b.data[i] - a.data[i] * 2) < 1e-9,
        `index ${i}: ${b.data[i]} vs ${a.data[i] * 2}`
      );
    }
  });

  it('samples the same continuous function at any resolution', () => {
    // u = 0.25 exists exactly on both grids (i/(N-1)).
    const low = createHeightField({ resolution: 33, seed: 5, amplitude: 30 });
    const high = createHeightField({ resolution: 65, seed: 5, amplitude: 30 });
    const iLow = 0.25 * 32;
    const iHigh = 0.25 * 64;
    assert.equal(iLow, Math.round(iLow));
    assert.equal(iHigh, Math.round(iHigh));
    assert.equal(low.data[8 * 33 + iLow], high.data[16 * 65 + iHigh]);
  });

  it('never exceeds the amplitude envelope', () => {
    const amplitude = 22;
    const field = createHeightField({ resolution: 128, seed: 123, amplitude });
    for (const v of field.data) {
      assert.ok(Math.abs(v) <= amplitude * 1.3, `${v} exceeds envelope`);
    }
  });

  it('has different relief for different noise scales', () => {
    const fine = createHeightField({ resolution: 64, seed: 3, noiseScale: 8 });
    const coarse = createHeightField({ resolution: 64, seed: 3, noiseScale: 1 });
    const roughness = (f) => {
      let sum = 0;
      for (let j = 0; j < 63; j++) {
        for (let i = 0; i < 63; i++) {
          sum += Math.abs(f.data[j * 64 + i + 1] - f.data[j * 64 + i]);
        }
      }
      return sum;
    };
    assert.ok(roughness(fine) > roughness(coarse), 'fine scale should be rougher');
  });

  it('uses a different landscape for every seed in a sweep', () => {
    const seen = new Set();
    for (let seed = 0; seed < 12; seed++) {
      seen.add(Array.from(createHeightField({ resolution: 24, seed }).data.slice(0, 8)).join(','));
    }
    assert.equal(seen.size, 12, 'seeds produced duplicate landscapes');
  });
});
