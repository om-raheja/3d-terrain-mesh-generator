/**
 * tests/geometry-properties.test.mjs — mesh topology, resolution sweeps,
 * numerical quality of the normals, input validation and fuzzing.
 *
 * Complements geometry.test.mjs (happy-path layout checks) and
 * normals.test.mjs (accuracy against closed forms).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createHeightField, mulberry32 } from '../src/noise.js';
import {
  buildGrid,
  buildNormalLines,
  buildTerrainGeometry,
  computeVertexNormals,
} from '../src/terrain.js';

const SIZE = 240;

const field = (resolution, seed = 1, amplitude = 30) =>
  createHeightField({ resolution, seed, amplitude });

/** Counts how many triangles touch each undirected edge. */
function edgeMultiplicities(indices) {
  const counts = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [indices[t], indices[t + 1], indices[t + 2]];
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

describe('edge topology (watertightness)', () => {
  for (const N of [4, 8, 17, 32, 64]) {
    it(`${N}x${N}: every edge is shared by at most two triangles`, () => {
      const { indices } = buildGrid(field(N), SIZE);
      const counts = edgeMultiplicities(indices);
      for (const [edge, n] of counts) {
        assert.ok(n === 1 || n === 2, `edge ${edge} used by ${n} triangles`);
      }
    });

    it(`${N}x${N}: exactly ${4 * (N - 1)} boundary edges`, () => {
      const { indices } = buildGrid(field(N), SIZE);
      const counts = edgeMultiplicities(indices);
      const boundary = [...counts.values()].filter((n) => n === 1).length;
      const interior = [...counts.values()].filter((n) => n === 2).length;

      // Grid combinatorics: axis-aligned edges + one b–c diagonal per quad.
      const expectedTotal = 2 * N * (N - 1) + (N - 1) ** 2;
      assert.equal(counts.size, expectedTotal, 'unexpected number of unique edges');
      assert.equal(boundary, 4 * (N - 1));
      assert.equal(interior, expectedTotal - 4 * (N - 1));
    });

    it(`${N}x${N}: every quad diagonal is used by exactly two triangles`, () => {
      const N2 = N;
      const { indices } = buildGrid(field(N2), SIZE);
      const counts = edgeMultiplicities(indices);
      // Triangles (a,b,c) and (c,b,d) share the b–c diagonal.
      const diagonal = (i, j) => {
        const base = (j * (N2 - 1) + i) * 6;
        const [, b, c] = indices.slice(base, base + 3);
        return b < c ? `${b}|${c}` : `${c}|${b}`;
      };
      assert.equal(counts.get(diagonal(0, 0)), 2, 'first quad diagonal');
      assert.equal(counts.get(diagonal(N2 - 2, N2 - 2)), 2, 'last quad diagonal');
      assert.equal(counts.get(diagonal(0, N2 - 2)), 2, 'far-corner quad diagonal');
    });
  }
});

describe('triangle winding', () => {
  for (const [N, seed] of [
    [8, 2],
    [23, 99],
    [40, 7],
  ]) {
    it(`${N}² seed ${seed}: all triangles face +Y under the right-hand rule`, () => {
      const { positions, indices } = buildGrid(field(N, seed), SIZE);
      let minNy = Infinity;
      for (let t = 0; t < indices.length; t += 3) {
        const p = (k) => [
          positions[indices[t + k] * 3],
          positions[indices[t + k] * 3 + 1],
          positions[indices[t + k] * 3 + 2],
        ];
        const [ax, ay, az] = p(0);
        const [bx, by, bz] = p(1);
        const [cx, cy, cz] = p(2);
        const e1 = [bx - ax, by - ay, bz - az];
        const e2 = [cx - ax, cy - ay, cz - az];
        const ny = e1[2] * e2[0] - e1[0] * e2[2];
        minNy = Math.min(minNy, ny);
        assert.ok(ny > 0, `triangle ${t / 3} faces down (ny=${ny})`);
      }
      assert.ok(minNy > 0);
    });
  }

  it('every quad lays down the documented a-b-c-d corners and splits on b–c', () => {
    const N = 16;
    const { positions, indices } = buildGrid(field(N), SIZE);
    assert.equal(indices.length, (N - 1) * (N - 1) * 6);
    const iOf = (v) => v % N;
    const jOf = (v) => Math.floor(v / N);
    const quads = N - 1;

    for (let q = 0; q < quads * quads; q++) {
      const t = q * 6;
      const j = Math.floor(q / quads);
      const i = q % quads;
      const a = indices[t];
      const b = indices[t + 1];
      const c = indices[t + 2];
      const d = indices[t + 5];

      // triangle 1 = (a, b, c), triangle 2 = (c, b, d)
      assert.equal(indices[t + 3], c, `quad ${q}: second triangle must restart at c`);
      assert.equal(indices[t + 4], b, `quad ${q}: both triangles share b`);
      assert.equal(d, (j + 1) * N + i + 1, `quad ${q}: d`);

      // exact corner positions in row-major vertex order
      assert.equal(a, j * N + i, `quad ${q}: a`);
      assert.equal(b, (j + 1) * N + i, `quad ${q}: b`);
      assert.equal(c, j * N + i + 1, `quad ${q}: c`);

      // b–c is the cut; a–d is the diagonal the mesh never uses
      assert.equal(iOf(b), iOf(a), 'b sits directly below a in z');
      assert.equal(jOf(b), jOf(a) + 1);
      assert.equal(jOf(c), jOf(a), 'c sits next to a in x');
      assert.equal(iOf(c), iOf(a) + 1);
      assert.notEqual(iOf(a), iOf(d), 'a and d must be opposite corners');
      assert.notEqual(jOf(a), jOf(d), 'a and d must be opposite corners');
    }
    assert.ok(positions.length > 0);
  });
});

describe('resolution sweep', () => {
  for (const N of [2, 3, 4, 5, 7, 8, 16, 17, 33, 64]) {
    it(`resolution ${N}: layout, bounds and finite data`, () => {
      const f = field(N, 3);
      const { positions, uvs, indices, vertexCount } = buildGrid(f, SIZE);

      assert.equal(vertexCount, N * N);
      assert.equal(indices.length, (N - 1) ** 2 * 6);
      assert.ok(positions.every(Number.isFinite), 'non-finite position');
      assert.ok(uvs.every(Number.isFinite), 'non-finite uv');

      // corners land exactly on the world bounds
      assert.equal(positions[0], -SIZE / 2);
      assert.equal(positions[2], -SIZE / 2);
      const last = (N * N - 1) * 3;
      assert.equal(positions[last], SIZE / 2);
      assert.equal(positions[last + 2], SIZE / 2);

      // UV corners
      assert.equal(uvs[0], 0);
      assert.equal(uvs[1], 0);
      assert.equal(uvs[uvs.length - 2], 1);
      assert.equal(uvs[uvs.length - 1], 1);

      // heights round-trip through the position array
      for (let idx = 0; idx < N * N; idx++) {
        assert.equal(positions[idx * 3 + 1], f.data[idx]);
      }
    });
  }
});

describe('index storage', () => {
  it('uses Uint32 indices (Uint16 would clip a 256² grid)', () => {
    const N = 256;
    const { indices } = buildGrid(field(N), SIZE);
    assert.ok(indices instanceof Uint32Array, 'indices must be Uint32Array');
    let highest = 0;
    for (const idx of indices) if (idx > highest) highest = idx;
    assert.equal(highest, N * N - 1, 'highest vertex index not exercised');
    assert.ok(highest >= 65535, 'index range must at least reach the Uint16 ceiling');
  });

  it('every index round-trips through the position buffer', () => {
    const N = 64;
    const { positions, indices } = buildGrid(field(N), SIZE);
    for (const idx of indices) {
      const o = idx * 3;
      assert.ok(Number.isFinite(positions[o]) && Number.isFinite(positions[o + 1]));
    }
  });
});

describe('input validation in buildGrid', () => {
  const good = () => ({ data: new Float32Array(9), resolution: 3 });

  const cases = [
    ['missing field', undefined, SIZE, /resolution must be an integer/],
    ['null field', null, SIZE, /resolution must be an integer/],
    ['resolution 1', { data: new Float32Array(1), resolution: 1 }, SIZE, /resolution must be an integer/],
    ['resolution 0', { data: new Float32Array(0), resolution: 0 }, SIZE, /resolution must be an integer/],
    ['fractional resolution', { data: new Float32Array(9), resolution: 3.5 }, SIZE, /resolution must be an integer/],
    ['short data', { data: new Float32Array(8), resolution: 3 }, SIZE, /must hold exactly 9 samples/],
    ['missing data', { resolution: 3 }, SIZE, /must hold exactly 9 samples/],
    ['NaN height', { data: Float32Array.from([1, 2, 3, 4, NaN, 6, 7, 8, 9]), resolution: 3 }, SIZE, /non-finite value at index 4/],
    ['Infinity height', { data: Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, Infinity]), resolution: 3 }, SIZE, /non-finite value at index 8/],
    ['string height', { data: ['1', '2', '3', '4', '5', '6', '7', '8', '9'], resolution: 3 }, SIZE, /non-finite value/],
    ['size 0', good(), 0, /positive finite number/],
    ['negative size', good(), -10, /positive finite number/],
    ['NaN size', good(), NaN, /positive finite number/],
    ['infinite size', good(), Infinity, /positive finite number/],
    ['string size', good(), '100', /positive finite number/],
  ];

  for (const [label, f, size, pattern] of cases) {
    it(`rejects ${label}`, () => {
      assert.throws(() => buildGrid(f, size), pattern);
    });
  }

  it('accepts a minimal 2x2 field', () => {
    const { positions, indices, vertexCount } = buildGrid(
      { data: Float32Array.from([0, 1, 2, 3]), resolution: 2 },
      10
    );
    assert.equal(vertexCount, 4);
    assert.equal(indices.length, 6);
    assert.ok(positions.every(Number.isFinite));
  });

  it('the error names the offending index for NaN heights', () => {
    const data = new Float32Array(16);
    data[7] = NaN;
    assert.throws(() => buildGrid({ data, resolution: 4 }, 10), /at index 7/);
  });
});

describe('normal quality', () => {
  it('adjacent vertices never have opposing normals (fuzz sweep)', () => {
    const rand = mulberry32(0xbeef);
    for (let caseId = 0; caseId < 5; caseId++) {
      const N = 32 + Math.floor(rand() * 64);
      const f = field(N, Math.floor(rand() * 1e5), 10 + rand() * 60);
      const { positions, indices } = buildGrid(f, SIZE);
      const normals = computeVertexNormals(positions, indices);

      let worst = 1;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const a = (j * N + i) * 3;
          if (i + 1 < N) {
            const b = a + 3;
            const d =
              normals[a] * normals[b] +
              normals[a + 1] * normals[b + 1] +
              normals[a + 2] * normals[b + 2];
            worst = Math.min(worst, d);
          }
          if (j + 1 < N) {
            const b = ((j + 1) * N + i) * 3;
            const d =
              normals[a] * normals[b] +
              normals[a + 1] * normals[b + 1] +
              normals[a + 2] * normals[b + 2];
            worst = Math.min(worst, d);
          }
        }
      }
      // Hostile persistence values create steep micro-slopes, so creases can
      // be sharp — but adjacent normals must never approach perpendicular.
      // Measured worst case across the sweep: 0.371.
      assert.ok(worst > 0.25, `case ${caseId}: adjacent normals ${worst.toFixed(4)} — too jarring`);
    }
  });

  it('a heightfield never produces a downward-facing vertex normal', () => {
    // Even absurd slopes keep ny > 0: the cross product's Y component is the
    // (positive) area of the triangle's projection onto the XZ plane.
    for (const amplitude of [1, 100, 5000]) {
      const f = field(64, 17, amplitude);
      const { positions, indices } = buildGrid(f, SIZE);
      const normals = computeVertexNormals(positions, indices);
      for (let v = 0; v < normals.length / 3; v++) {
        assert.ok(normals[v * 3 + 1] > 0, `amplitude ${amplitude}: vertex ${v} faces down`);
      }
    }
  });

  it('converges to the analytic normal as the grid refines', () => {
    // Smooth sine field with a closed-form gradient: 2nd-order accurate means
    // halving the cell size should cut the error by ~4x (measured ~17x here).
    const P = SIZE / 2;
    const A = 25;
    const B = 15;
    const sineField = (N) => {
      const data = new Float32Array(N * N);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const x = (i / (N - 1) - 0.5) * SIZE;
          const z = (j / (N - 1) - 0.5) * SIZE;
          data[j * N + i] = A * Math.sin((2 * Math.PI * x) / P) + B * Math.cos((2 * Math.PI * z) / P);
        }
      }
      return { data, resolution: N };
    };

    const errorAt = (N) => {
      const f = sineField(N);
      const { positions, indices } = buildGrid(f, SIZE);
      const normals = computeVertexNormals(positions, indices);
      let sum = 0;
      let count = 0;
      for (let j = 1; j < N - 1; j++) {
        for (let i = 1; i < N - 1; i++) {
          const x = (i / (N - 1) - 0.5) * SIZE;
          const z = (j / (N - 1) - 0.5) * SIZE;
          const dhdx = A * ((2 * Math.PI) / P) * Math.cos((2 * Math.PI * x) / P);
          const dhdz = -B * ((2 * Math.PI) / P) * Math.sin((2 * Math.PI * z) / P);
          const len = Math.hypot(-dhdx, 1, -dhdz);
          const o = (j * N + i) * 3;
          const dot =
            (normals[o] * -dhdx + normals[o + 1] + normals[o + 2] * -dhdz) / len;
          sum += 1 - dot;
          count++;
        }
      }
      return sum / count;
    };

    const e64 = errorAt(64);
    const e256 = errorAt(256);
    assert.ok(e64 < 1e-4, `coarse error ${e64} unexpectedly large`);
    assert.ok(e256 < e64 / 10, `refinement did not converge: ${e64} -> ${e256}`);
  });

  it('flattens the normals as the world size grows (same heights, wider cells)', () => {
    const f = field(64, 5, 40);
    const meanNy = (size) => {
      const { positions, indices } = buildGrid(f, size);
      const normals = computeVertexNormals(positions, indices);
      let sum = 0;
      for (let v = 0; v < normals.length / 3; v++) sum += normals[v * 3 + 1];
      return sum / (normals.length / 3);
    };
    const narrow = meanNy(60);
    const wide = meanNy(600);
    assert.ok(wide > narrow + 0.1, `wide cells should be flatter: ${wide} vs ${narrow}`);
    assert.ok(wide > 0.9, `wide terrain should be nearly flat, got ${wide}`);
  });

  it('is unaffected by the order triangles arrive in', () => {
    const N = 24;
    const { positions, indices } = buildGrid(field(N, 12), SIZE);
    const base = computeVertexNormals(positions, indices);

    // Reverse the triangle list and cycle each triangle's corners (a,b,c) ->
    // (b,c,a). Cyclic rotation preserves orientation, so every face normal is
    // unchanged — any dependency on triangle order would be a bug.
    const shuffled = new Uint32Array(indices.length);
    const tris = indices.length / 3;
    for (let t = 0; t < tris; t++) {
      const src = (tris - 1 - t) * 3;
      const dst = t * 3;
      shuffled[dst] = indices[src + 1];
      shuffled[dst + 1] = indices[src + 2];
      shuffled[dst + 2] = indices[src];
    }
    const reordered = computeVertexNormals(positions, shuffled);
    for (let i = 0; i < base.length; i++) {
      assert.ok(Math.abs(base[i] - reordered[i]) < 1e-6, `normal ${i} depends on triangle order`);
    }
  });
});

describe('degenerate input', () => {
  it('all-coincident vertices still yield unit normals (defaults to +Y)', () => {
    const positions = new Float32Array(9); // one triangle, every point at origin
    const indices = new Uint32Array([0, 1, 2]);
    const normals = computeVertexNormals(positions, indices);
    assert.deepEqual([...normals], [0, 1, 0, 0, 1, 0, 0, 1, 0]);
    for (let v = 0; v < 3; v++) {
      const len = Math.hypot(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
      assert.ok(Math.abs(len - 1) < 1e-12, `vertex ${v} normal not unit`);
    }
  });

  it('a completely flat field gets (0,1,0) everywhere, never (0,0,0)', () => {
    const N = 6;
    const { positions, indices } = buildGrid(
      { data: new Float32Array(N * N), resolution: N },
      SIZE
    );
    const normals = computeVertexNormals(positions, indices);
    for (let v = 0; v < normals.length / 3; v++) {
      assert.deepEqual(
        [normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]],
        [0, 1, 0],
        `vertex ${v}`
      );
    }
  });

  it('an empty index buffer does not produce NaN', () => {
    const normals = computeVertexNormals(new Float32Array(9), new Uint32Array(0));
    assert.ok([...normals].every(Number.isFinite));
    // zero-length accumulator still resolves to +Y for every vertex
    assert.deepEqual([...normals], [0, 1, 0, 0, 1, 0, 0, 1, 0]);
  });
});

describe('assembled geometry types', () => {
  it('stores every attribute in a typed array of the right kind', () => {
    const { geometry } = buildTerrainGeometry(field(48), SIZE);
    const pos = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const nrm = geometry.getAttribute('normal');
    assert.ok(pos.array instanceof Float32Array);
    assert.ok(uv.array instanceof Float32Array);
    assert.ok(nrm.array instanceof Float32Array);
    assert.ok(geometry.index.array instanceof Uint32Array);
    assert.equal(geometry.index.array.BYTES_PER_ELEMENT, 4);
  });

  it('handles the largest grid the UI can request', () => {
    const N = 256;
    const { geometry, vertexCount, triangleCount } = buildTerrainGeometry(field(N, 4), SIZE);
    assert.equal(vertexCount, 65536);
    assert.equal(triangleCount, 2 * (N - 1) ** 2);
    assert.equal(geometry.getAttribute('position').count, 65536);
    assert.equal(geometry.index.count, triangleCount * 3);
    assert.ok(geometry.boundingSphere.radius > 0);
    assert.ok([...geometry.getAttribute('normal').array].every(Number.isFinite));
  });

  it('bounding sphere grows with world size', () => {
    const f = field(64, 2);
    const small = buildTerrainGeometry(f, 100).geometry.boundingSphere.radius;
    const large = buildTerrainGeometry(f, 400).geometry.boundingSphere.radius;
    assert.ok(large > small * 2, `${large} should dwarf ${small}`);
  });
});

describe('normal debug lines', () => {
  it('honours the requested segment length, including zero', () => {
    const { positions } = buildGrid(field(8, 6), SIZE);
    const normals = new Float32Array(positions.length);
    for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1;

    for (const length of [0, 0.5, 1, 10, 100]) {
      const lines = buildNormalLines(positions, normals, length);
      const arr = lines.geometry.getAttribute('position').array;
      for (let v = 0; v < positions.length / 3; v += 7) {
        const l = v * 6;
        const dy = arr[l + 4] - arr[l + 1];
        assert.ok(Math.abs(dy - length) < 1e-3, `length ${length}: dy ${dy}`);
      }
    }
  });

  it('emits 2 × vertexCount points at every resolution', () => {
    for (const N of [2, 8, 64]) {
      const { positions } = buildGrid(field(N), SIZE);
      const normals = new Float32Array(positions.length).fill(0);
      for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1;
      const lines = buildNormalLines(positions, normals, 2);
      assert.equal(
        lines.geometry.getAttribute('position').count,
        2 * N * N,
        `resolution ${N}`
      );
    }
  });

  it('uses a visible (non-black) line colour', () => {
    const lines = buildNormalLines(new Float32Array(3), new Float32Array([0, 1, 0]), 1);
    const { r, g, b } = lines.material.color;
    assert.ok(r + g + b > 0.5, 'normal lines would be invisible');
    assert.equal(lines.material.depthTest, true);
  });

  it('builds independent geometry per call (no aliasing)', () => {
    const { positions } = buildGrid(field(4, 1), SIZE);
    const normals = new Float32Array(positions.length);
    for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1;
    const a = buildNormalLines(positions, normals, 1);
    const b = buildNormalLines(positions, normals, 1);
    assert.notEqual(a.geometry, b.geometry, 'geometries must not alias');
    assert.notEqual(a.geometry.getAttribute('position').array, b.geometry.getAttribute('position').array);
  });
});

describe('fuzz: full pipeline stays healthy', () => {
  const rand = mulberry32(0xabcdef);

  for (let caseId = 0; caseId < 6; caseId++) {
    it(`random pipeline #${caseId}`, () => {
      const N = 8 + Math.floor(rand() * 48);
      const f = createHeightField({
        seed: Math.floor(rand() * 1e6),
        resolution: N,
        amplitude: rand() * 120,
        noiseScale: rand() * 10,
        octaves: 1 + Math.floor(rand() * 7),
        persistence: rand(),
      });

      const { geometry, vertexCount, triangleCount } = buildTerrainGeometry(f, 240);
      const pos = geometry.getAttribute('position');
      const uv = geometry.getAttribute('uv');
      const nrm = geometry.getAttribute('normal');

      assert.equal(vertexCount, N * N);
      assert.equal(triangleCount, 2 * (N - 1) ** 2);
      assert.equal(pos.count, N * N);
      assert.equal(uv.count, N * N);
      assert.equal(nrm.count, N * N);

      for (let v = 0; v < vertexCount; v++) {
        for (let k = 0; k < 3; k++) {
          assert.ok(Number.isFinite(pos.array[v * 3 + k]), `position NaN at ${v}`);
          assert.ok(Number.isFinite(nrm.array[v * 3 + k]), `normal NaN at ${v}`);
        }
        assert.ok(nrm.array[v * 3 + 1] > 0, `normal faces down at ${v}`);
        const len = Math.hypot(
          nrm.array[v * 3],
          nrm.array[v * 3 + 1],
          nrm.array[v * 3 + 2]
        );
        assert.ok(Math.abs(len - 1) < 1e-6, `normal not unit at ${v}`);
        assert.ok(uv.array[v * 2] >= 0 && uv.array[v * 2] <= 1, 'u out of range');
        assert.ok(uv.array[v * 2 + 1] >= 0 && uv.array[v * 2 + 1] <= 1, 'v out of range');
      }
    });
  }
});
