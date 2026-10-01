/**
 * tests/normals.test.mjs — the hand-written normal calculation.
 *
 * Normalises are checked three ways: against known closed-form surfaces
 * (flat / tilted planes), against the analytic normal of the sampled height
 * field via central differences, and against symmetry properties.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createHeightField } from '../src/noise.js';
import {
  buildGrid,
  buildNormalLines,
  buildTerrainGeometry,
  computeVertexNormals,
} from '../src/terrain.js';

const SIZE = 240;

const noiseField = (resolution, seed = 1, amplitude = 30) =>
  createHeightField({ resolution, seed, amplitude });

/** Synthetic planar height field: h = ax + bz, sampled on the grid. */
function planeField(N, a, b) {
  const data = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1) - 0.5) * SIZE;
      const z = (j / (N - 1) - 0.5) * SIZE;
      data[j * N + i] = a * x + b * z;
    }
  }
  return { data, resolution: N };
}

/** Synthetic Gaussian hill centred on the grid. */
function peakField(N) {
  const sigma = 0.12;
  const data = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1) - 0.5;
      const z = j / (N - 1) - 0.5;
      data[j * N + i] = 60 * Math.exp(-(x * x + z * z) / (2 * sigma * sigma));
    }
  }
  return { data, resolution: N };
}

const normalAt = (normals, idx) => [
  normals[idx * 3],
  normals[idx * 3 + 1],
  normals[idx * 3 + 2],
];

describe('basic normal properties', () => {
  it('flat heightmap -> every normal is exactly +Y', () => {
    const N = 32;
    const { positions, indices } = buildGrid({ data: new Float32Array(N * N), resolution: N }, SIZE);
    const normals = computeVertexNormals(positions, indices);
    for (let i = 0; i < normals.length; i += 3) {
      assert.ok(
        Math.abs(normals[i]) < 1e-9 &&
          Math.abs(normals[i + 1] - 1) < 1e-9 &&
          Math.abs(normals[i + 2]) < 1e-9,
        `normal [${normals[i]}, ${normals[i + 1]}, ${normals[i + 2]}]`
      );
    }
  });

  it('every normal is unit length on a rough terrain', () => {
    for (const seed of [1, 17, 2024]) {
      const { geometry } = buildTerrainGeometry(noiseField(96, seed), SIZE);
      const n = geometry.getAttribute('normal').array;
      for (let i = 0; i < n.length; i += 3) {
        const len = Math.hypot(n[i], n[i + 1], n[i + 2]);
        assert.ok(Math.abs(len - 1) < 1e-6, `len ${len} at vertex ${i / 3} (seed ${seed})`);
      }
    }
  });

  it('produces one normal per vertex', () => {
    const N = 40;
    const { positions, indices } = buildGrid(noiseField(N), SIZE);
    assert.equal(computeVertexNormals(positions, indices).length, positions.length);
    assert.equal(indices.length % 3, 0);
  });

  it('is invariant under translation (checked in double precision)', () => {
    const { positions, indices } = buildGrid(noiseField(48, 5), SIZE);
    // Widen to doubles: Float32 storage would quantise the shifted coordinates
    // and hide the property behind rounding error.
    const base = computeVertexNormals(Float64Array.from(positions), indices);

    const shifted = new Float64Array(positions);
    for (let i = 0; i < shifted.length; i += 3) {
      shifted[i] += 10;
      shifted[i + 1] -= 4;
      shifted[i + 2] += 7;
    }
    const moved = computeVertexNormals(shifted, indices);
    for (let i = 0; i < base.length; i++) {
      assert.ok(Math.abs(base[i] - moved[i]) < 1e-9, `normal changed at ${i}`);
    }
  });
});

describe('closed-form surfaces', () => {
  for (const [a, b] of [
    [0, 0],
    [0.3, 0],
    [0, -0.2],
    [0.3, -0.2],
    [-0.75, 0.5],
    [2.5, -1.25],
  ]) {
    it(`plane h = ${a}x + ${b}z -> normal ∝ (-${a}, 1, -${b})`, () => {
      const N = 24;
      const { positions, indices } = buildGrid(planeField(N, a, b), SIZE);
      const normals = computeVertexNormals(positions, indices);

      const len = Math.hypot(a, 1, b);
      const expected = [-a / len, 1 / len, -b / len];

      // Plane heights are stored as Float32, so the surface is only planar to
      // ~1e-8; that bounds how close the computed normal can get.
      for (let v = 0; v < normals.length / 3; v++) {
        const [nx, ny, nz] = normalAt(normals, v);
        const dot = nx * expected[0] + ny * expected[1] + nz * expected[2];
        assert.ok(dot > 1 - 1e-7, `vertex ${v} dot ${dot} vs ${expected}`);
      }
    });
  }

  it('a steep plane still points upward, not sideways', () => {
    const { positions, indices } = buildGrid(planeField(24, 5, 0), SIZE);
    const normals = computeVertexNormals(positions, indices);
    const [, ny] = normalAt(normals, 0);
    assert.ok(ny > 0, `normal Y ${ny}`);
    // Heights here reach ±600, where Float32 position storage costs ~1e-6.
    assert.ok(Math.abs(ny - 1 / Math.hypot(5, 1)) < 1e-6, `ny ${ny}`);
  });
});

describe('Gaussian peak orientation', () => {
  const N = 65;
  const { positions, indices } = buildGrid(peakField(N), SIZE);
  const normals = computeVertexNormals(positions, indices);
  const centre = ((N - 1) / 2) * N + (N - 1) / 2;
  const step = 8; // ~1/8 of the way out: firmly on the slope

  it('is vertical at the summit', () => {
    const [nx, ny, nz] = normalAt(normals, centre);
    // Discrete averaging over the six faces around the peak leaves a tiny
    // tilt, but the lean itself must cancel by symmetry.
    assert.ok(ny > 0.97, `summit normal ${nx}, ${ny}, ${nz}`);
    assert.ok(Math.hypot(nx, nz) < 0.05, `summit should not lean, got ${nx}, ${nz}`);
  });

  it('leans +X on the east flank and -X on the west flank', () => {
    const east = normalAt(normals, centre + step)[0];
    const west = normalAt(normals, centre - step)[0];
    assert.ok(east > 0.05, `east flank normal.x ${east}`);
    assert.ok(west < -0.05, `west flank normal.x ${west}`);
    assert.ok(Math.abs(east + west) < 1e-6, 'flanks should be mirror images');
  });

  it('leans +Z on the south flank and -Z on the north flank', () => {
    const south = normalAt(normals, centre + step * N)[2];
    const north = normalAt(normals, centre - step * N)[2];
    assert.ok(south > 0.05, `south flank normal.z ${south}`);
    assert.ok(north < -0.05, `north flank normal.z ${north}`);
  });
});

describe('agreement with the analytic normal', () => {
  // analytic: normalize(-dh/dx, 1, -dh/dz) from central differences
  for (const [resolution, seed, amplitude] of [
    [64, 1, 30],
    [96, 42, 40],
    [128, 2024, 34],
    [161, 7, 55],
  ]) {
    it(`res=${resolution} seed=${seed}: mean dot > 0.99, min > 0.93`, (t) => {
      const field = noiseField(resolution, seed, amplitude);
      const { positions, indices } = buildGrid(field, SIZE);
      const normals = computeVertexNormals(positions, indices);
      const dx = SIZE / (resolution - 1);

      let sum = 0;
      let min = 1;
      let count = 0;
      for (let j = 1; j < resolution - 1; j++) {
        for (let i = 1; i < resolution - 1; i++) {
          const idx = j * resolution + i;
          const dhdx = (field.data[idx + 1] - field.data[idx - 1]) / (2 * dx);
          const dhdz = (field.data[idx + resolution] - field.data[idx - resolution]) / (2 * dx);
          const len = Math.hypot(-dhdx, 1, -dhdz);
          const [ax, ay, az] = [-dhdx / len, 1 / len, -dhdz / len];
          const [nx, ny, nz] = normalAt(normals, idx);
          const dot = nx * ax + ny * ay + nz * az;
          sum += dot;
          min = Math.min(min, dot);
          count++;
        }
      }
      const mean = sum / count;
      assert.ok(mean > 0.99, `mean dot ${mean}`);
      assert.ok(min > 0.93, `min dot ${min}`);
      t.diagnostic(
        `mean dot ${mean.toFixed(4)}, min ${min.toFixed(4)} over ${count} interior verts`
      );
    });
  }
});

describe('symmetry', () => {
  it('mirroring a plane flips exactly the X component', () => {
    const N = 24;
    const a = 0.4;
    const forward = planeField(N, a, 0.1);
    const backward = { resolution: N, data: new Float32Array(N * N) };
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        backward.data[j * N + i] = forward.data[j * N + (N - 1 - i)];
      }
    }

    const gA = buildGrid(forward, SIZE);
    const gB = buildGrid(backward, SIZE);
    const nA = computeVertexNormals(gA.positions, gA.indices);
    const nB = computeVertexNormals(gB.positions, gB.indices);

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a3 = (j * N + i) * 3;
        const b3 = (j * N + (N - 1 - i)) * 3;
        assert.ok(Math.abs(nA[b3] + nB[a3]) < 1e-5, `X at ${i},${j}`);
        assert.ok(Math.abs(nA[b3 + 1] - nB[a3 + 1]) < 1e-5, `Y at ${i},${j}`);
        assert.ok(Math.abs(nA[b3 + 2] - nB[a3 + 2]) < 1e-5, `Z at ${i},${j}`);
      }
    }
  });

  it('mirroring a rough terrain keeps the normals pointing the mirrored way', () => {
    // The mesh is NOT the mirror-image triangulation: each quad is always cut
    // on the a-d diagonal, and mirroring swaps which diagonal that is. So the
    // two normal fields agree in direction but not bit-for-bit — asserting
    // exact equality here would be asserting something false.
    const N = 48;
    const original = noiseField(N, 4);
    const mirrored = { resolution: N, data: new Float32Array(N * N) };
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        mirrored.data[j * N + i] = original.data[j * N + (N - 1 - i)];
      }
    }

    const gA = buildGrid(original, SIZE);
    const gB = buildGrid(mirrored, SIZE);
    const nA = computeVertexNormals(gA.positions, gA.indices);
    const nB = computeVertexNormals(gB.positions, gB.indices);

    let worst = 1;
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        const a = (j * N + i) * 3;
        const b = (j * N + (N - 1 - i)) * 3;
        // mirrored A normal: x flips, y and z stay
        const dot =
          -nA[b] * nB[a] + nA[b + 1] * nB[a + 1] + nA[b + 2] * nB[a + 2];
        worst = Math.min(worst, dot);
      }
    }
    assert.ok(worst > 0.9, `mirrored normals disagree, worst dot ${worst}`);
  });
});

describe('normal debug lines', () => {
  it('match the normals they visualise', () => {
    const N = 32;
    const { positions, indices } = buildGrid(noiseField(N, 6), SIZE);
    const normals = computeVertexNormals(positions, indices);
    const lines = buildNormalLines(positions, normals, 3);
    const arr = lines.geometry.getAttribute('position').array;

    for (let v = 0; v < positions.length / 3; v += 53) {
      const p = v * 3;
      const l = v * 6;
      const tip = [arr[l + 3], arr[l + 4], arr[l + 5]];
      const base = [arr[l], arr[l + 1], arr[l + 2]];

      // Line buffers are Float32, so compare with a tolerance that covers
      // quantisation of coordinates around ±120.
      for (let k = 0; k < 3; k++) {
        const expected = base[k] + normals[p + k] * 3;
        assert.ok(
          Math.abs(tip[k] - expected) < 1e-4,
          `tip[${k}] ${tip[k]} vs ${expected}`
        );
      }
      const length = Math.hypot(tip[0] - base[0], tip[1] - base[1], tip[2] - base[2]);
      assert.ok(Math.abs(length - 3) < 1e-4, `line length ${length}`);
    }
  });
});
