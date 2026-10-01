/**
 * tests/noise-properties.test.mjs — structural properties of the noise
 * generator: lattice periodicity, degenerate parameters, validation guards
 * and parameter sweeps. Complements noise.test.mjs, which checks behaviour
 * under *normal* settings.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createHeightField, createPerlin2D, fbm, mulberry32 } from '../src/noise.js';

const BASE = { octaves: 5, frequency: 3, persistence: 0.5, lacunarity: 2 };

/** A spread of sample points, deliberately avoiding integer lattice points. */
const SAMPLES = (() => {
  const rand = mulberry32(0xc0ffee);
  const pts = [];
  for (let i = 0; i < 200; i++) {
    pts.push([(rand() - 0.5) * 90 + 0.137, (rand() - 0.5) * 90 + 0.271]);
  }
  return pts;
})();

describe('permutation lattice', () => {
  // The lattice hash (floor(x) & 255) makes the period exact. Adding 256 to a
  // non-integer re-quantises its fractional part (larger exponent, coarser ulp),
  // so the samples are only equal to within double rounding — compare with a
  // tolerance rather than bit-for-bit.
  const PERIOD_EPS = 1e-9;

  it('is 256-periodic in X', () => {
    const noise = createPerlin2D(77);
    for (const [x, y] of SAMPLES) {
      const d = Math.abs(noise(x + 256, y) - noise(x, y));
      assert.ok(d < PERIOD_EPS, `x period broken at ${x},${y} (delta ${d})`);
    }
  });

  it('is 256-periodic in Y', () => {
    const noise = createPerlin2D(77);
    for (const [x, y] of SAMPLES) {
      const d = Math.abs(noise(x, y + 256) - noise(x, y));
      assert.ok(d < PERIOD_EPS, `y period broken at ${x},${y} (delta ${d})`);
    }
  });

  it('is periodic on the diagonal too', () => {
    const noise = createPerlin2D(77);
    for (const [x, y] of SAMPLES.slice(0, 50)) {
      const d = Math.abs(noise(x - 256, y + 256) - noise(x, y));
      assert.ok(d < PERIOD_EPS, `diagonal period broken at ${x},${y} (delta ${d})`);
    }
  });

  it('does NOT repeat at period 1 — the permutation table really shuffles', () => {
    const noise = createPerlin2D(77);
    let different = 0;
    for (const [x, y] of SAMPLES) {
      if (noise(x + 1, y) !== noise(x, y)) different++;
    }
    assert.ok(different > 190, `only ${different}/200 samples changed under a unit shift`);
  });

  it('different seeds permute the same 8 gradients differently', () => {
    const a = createPerlin2D(1);
    const b = createPerlin2D(2);
    let different = 0;
    for (const [x, y] of SAMPLES) {
      if (a(x, y) !== b(x, y)) different++;
    }
    assert.ok(different > 150, `only ${different}/200 samples differ between seeds`);
  });

  it('has usable dynamic range (not a near-constant field)', () => {
    const noise = createPerlin2D(9);
    let sum = 0;
    let sumSq = 0;
    for (const [x, y] of SAMPLES) {
      const v = noise(x, y);
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / SAMPLES.length;
    const variance = sumSq / SAMPLES.length - mean * mean;
    assert.ok(variance > 0.05, `variance ${variance} too low`);
    assert.ok(Math.abs(mean) < 0.4, `mean ${mean} skewed`);
  });
});

describe('degenerate fBm parameters', () => {
  for (const octaves of [0, -1, -8, NaN, Infinity, -Infinity]) {
    it(`octaves = ${octaves} returns 0 instead of NaN`, () => {
      const noise = createPerlin2D(4);
      const v = fbm(noise, 3.3, 1.1, { ...BASE, octaves });
      assert.equal(v, 0, `expected flat ground, got ${v}`);
      assert.ok(Number.isFinite(v));
    });
  }

  it('floors fractional octave counts', () => {
    const noise = createPerlin2D(4);
    const a = fbm(noise, 2.5, 7.5, { ...BASE, octaves: 3.9 });
    const b = fbm(noise, 2.5, 7.5, { ...BASE, octaves: 3 });
    assert.equal(a, b);
  });

  it('persistence 1 weights every octave equally (plain average)', () => {
    const noise = createPerlin2D(12);
    const opts = { ...BASE, octaves: 6, persistence: 1 };
    const x = 4.4;
    const y = 9.1;

    let expected = 0;
    let freq = opts.frequency;
    for (let o = 0; o < 6; o++) {
      expected += noise(x * freq, y * freq);
      freq *= opts.lacunarity;
    }
    expected /= 6;

    assert.equal(fbm(noise, x, y, opts), expected);
  });

  it('frequency 0 collapses to a constant flat field', () => {
    const noise = createPerlin2D(4);
    const opts = { ...BASE, frequency: 0 };
    const values = new Set();
    for (const [x, y] of SAMPLES) values.add(fbm(noise, x, y, opts));
    assert.equal(values.size, 1, `expected one constant, got ${values.size}`);
    assert.equal([...values][0], 0);
  });

  it('lacunarity 0 stays finite (later octaves sample the origin)', () => {
    const noise = createPerlin2D(4);
    for (const [x, y] of SAMPLES.slice(0, 40)) {
      const v = fbm(noise, x, y, { ...BASE, lacunarity: 0 });
      assert.ok(Number.isFinite(v), `NaN/Infinity at ${x},${y}`);
    }
  });

  it('stays inside the noise envelope for hostile persistence values', () => {
    const noise = createPerlin2D(21);
    for (const persistence of [0, 0.25, 0.5, 1, 2, 5]) {
      for (const [x, y] of SAMPLES.slice(0, 40)) {
        const v = fbm(noise, x, y, { ...BASE, persistence, octaves: 7 });
        assert.ok(
          Math.abs(v) <= 1.45,
          `persistence ${persistence} escaped envelope: ${v}`
        );
      }
    }
  });

  it('lack of normalisation would have been caught: norm never divides by zero', () => {
    // Any configuration that used to produce NaN must now be finite.
    const noise = createPerlin2D(21);
    const hostile = [
      { octaves: 0, frequency: 3, persistence: 0.5, lacunarity: 2 },
      { octaves: 4, frequency: 0, persistence: 0, lacunarity: 0 },
      { octaves: 1, frequency: 1e9, persistence: 0, lacunarity: 1 },
      { octaves: 3, frequency: -2, persistence: 0.5, lacunarity: -2 },
    ];
    for (const opts of hostile) {
      for (const [x, y] of SAMPLES.slice(0, 20)) {
        const v = fbm(noise, x, y, opts);
        assert.ok(
          Number.isFinite(v),
          `non-finite result for ${JSON.stringify(opts)} at ${x},${y}`
        );
      }
    }
  });
});

describe('createHeightField validation', () => {
  for (const resolution of [1, 0, -3, 2.5, NaN, Infinity, '64', null]) {
    it(`rejects resolution ${resolution}`, () => {
      assert.throws(
        () => createHeightField({ resolution }),
        /resolution must be an integer >= 2/
      );
    });
  }

  it('uses the default resolution when none is given', () => {
    // `undefined` triggers the destructuring default rather than the guard.
    const field = createHeightField({ resolution: undefined });
    assert.equal(field.resolution, 128);
    assert.equal(field.data.length, 128 * 128);
  });

  for (const amplitude of [NaN, Infinity, -Infinity, '26', {}, null]) {
    it(`rejects amplitude ${amplitude}`, () => {
      assert.throws(() => createHeightField({ amplitude }), /amplitude must be finite/);
    });
  }

  for (const noiseScale of [NaN, Infinity, '3']) {
    it(`rejects noiseScale ${noiseScale}`, () => {
      assert.throws(() => createHeightField({ noiseScale }), /noiseScale must be finite/);
    });
  }

  it('accepts the minimum resolution of 2', () => {
    const field = createHeightField({ resolution: 2, seed: 5 });
    assert.equal(field.data.length, 4);
    assert.ok([...field.data].every(Number.isFinite));
    assert.equal(field.min, Math.min(...field.data));
    assert.equal(field.max, Math.max(...field.data));
  });

  it('amplitude 0 yields perfectly flat ground', () => {
    const field = createHeightField({ resolution: 40, seed: 8, amplitude: 0 });
    assert.ok([...field.data].every((v) => v === 0), 'flat field has non-zero heights');
    assert.equal(field.min, 0);
    assert.equal(field.max, 0);
  });

  it('noiseScale 0 samples the origin, so the field is constant', () => {
    const field = createHeightField({ resolution: 32, seed: 8, noiseScale: 0 });
    assert.ok([...field.data].every((v) => v === field.data[0]), 'not constant');
    assert.equal(field.min, field.max);
  });

  it('extreme-but-finite noiseScale still produces a valid field', () => {
    for (const noiseScale of [1e-6, 1e3]) {
      const field = createHeightField({ resolution: 16, noiseScale });
      assert.ok([...field.data].every(Number.isFinite), `scale ${noiseScale}`);
      assert.ok(field.min <= field.max);
    }
  });
});

describe('parameter sweeps', () => {
  const fingerprint = (field) => [...field.data.slice(0, 6)].join(',');

  it('every seed in a sweep gives a different landscape', () => {
    const seen = new Map();
    for (let seed = 0; seed < 10; seed++) {
      const field = createHeightField({ resolution: 32, seed });
      const fp = fingerprint(field);
      assert.ok(!seen.has(fp), `seed ${seed} collides with seed ${seen.get(fp)}`);
      seen.set(fp, seed);
    }
  });

  it('every octave count in a sweep changes the landscape', () => {
    const seen = new Set();
    for (const octaves of [1, 2, 3, 4, 5, 6, 7]) {
      const fp = fingerprint(createHeightField({ resolution: 32, seed: 3, octaves }));
      assert.ok(!seen.has(fp), `octaves ${octaves} produced a duplicate`);
      seen.add(fp);
    }
  });

  it('every noise scale in a sweep changes the landscape', () => {
    const seen = new Set();
    for (const noiseScale of [0.5, 1, 2, 3, 5, 8, 16]) {
      const fp = fingerprint(
        createHeightField({ resolution: 32, seed: 3, noiseScale })
      );
      assert.ok(!seen.has(fp), `noiseScale ${noiseScale} produced a duplicate`);
      seen.add(fp);
    }
  });

  it('higher noise scales roughen the field monotonically', () => {
    const meanStep = (noiseScale) => {
      const N = 96;
      const f = createHeightField({ resolution: N, seed: 6, noiseScale });
      let sum = 0;
      for (let j = 0; j < N; j++) {
        for (let i = 1; i < N; i++) {
          sum += Math.abs(f.data[j * N + i] - f.data[j * N + i - 1]);
        }
      }
      return sum / (N * (N - 1));
    };
    const steps = [1, 2, 4, 8].map(meanStep);
    for (let i = 1; i < steps.length; i++) {
      assert.ok(steps[i] > steps[i - 1], `roughness did not grow: ${steps}`);
    }
  });

  it('amplitude scales the field linearly at every value tested', () => {
    for (const amplitude of [1, 5, 13, 26, 100]) {
      const f = createHeightField({ resolution: 32, seed: 11, amplitude });
      const unit = createHeightField({ resolution: 32, seed: 11, amplitude: 1 });
      for (let i = 0; i < f.data.length; i++) {
        assert.ok(
          Math.abs(f.data[i] - unit.data[i] * amplitude) < 1e-4,
          `amplitude ${amplitude} index ${i}`
        );
      }
      assert.ok(f.max <= amplitude * 1.45 + 1e-4, `amplitude ${amplitude} max ${f.max}`);
    }
  });
});

describe('fuzz: random parameter sets stay well formed', () => {
  const rand = mulberry32(0xfeed);

  for (let caseId = 0; caseId < 8; caseId++) {
    it(`random config #${caseId}`, () => {
      const params = {
        seed: Math.floor(rand() * 1e6),
        resolution: 8 + Math.floor(rand() * 56),
        noiseScale: rand() * 12,
        octaves: 1 + Math.floor(rand() * 7),
        persistence: rand(),
        lacunarity: 1 + rand() * 3,
        amplitude: rand() * 80,
      };

      const field = createHeightField(params);
      assert.equal(field.data.length, params.resolution ** 2);

      let min = Infinity;
      let max = -Infinity;
      for (const v of field.data) {
        assert.ok(Number.isFinite(v), 'non-finite height');
        assert.ok(
          Math.abs(v) <= params.amplitude * 1.45 + 1e-4,
          `${v} outside amplitude envelope ${params.amplitude}`
        );
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      assert.equal(field.min, min, 'min does not match data');
      assert.equal(field.max, max, 'max does not match data');

      // determinism under identical parameters
      const again = createHeightField(params);
      assert.deepEqual(Array.from(again.data), Array.from(field.data));
    });
  }
});
