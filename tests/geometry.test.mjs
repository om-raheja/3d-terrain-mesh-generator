/**
 * tests/geometry.test.mjs — vertex / UV / index generation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createHeightField } from '../src/noise.js';
import { buildGrid, buildNormalLines, buildTerrainGeometry } from '../src/terrain.js';

const SIZE = 240;

const field = (resolution, seed = 1) =>
  createHeightField({ resolution, seed, amplitude: 30 });

describe('grid topology', () => {
  for (const resolution of [16, 65, 128, 256]) {
    it(`${resolution}x${resolution} -> ${resolution ** 2} verts, ${2 * (resolution - 1) ** 2} tris`, () => {
      const { positions, uvs, indices } = buildGrid(field(resolution), SIZE);
      assert.equal(positions.length / 3, resolution ** 2);
      assert.equal(uvs.length / 2, resolution ** 2);
      assert.equal(indices.length, (resolution - 1) ** 2 * 6);
    });
  }

  it('every index is inside the vertex buffer', () => {
    const N = 64;
    const { indices, vertexCount } = buildGrid(field(N), SIZE);
    for (const i of indices) {
      assert.ok(i >= 0 && i < vertexCount, `index ${i} out of bounds`);
    }
  });

  it('no triangle is degenerate', () => {
    const N = 48;
    const { positions, indices } = buildGrid(field(N), SIZE);
    const cellArea = (SIZE / (N - 1)) ** 2 / 2;
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
      const p = (k) => [positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2]];
      const [ax, ay, az] = p(a);
      const [bx, by, bz] = p(b);
      const [cx, cy, cz] = p(c);
      const area =
        0.5 *
        Math.hypot(
          (by - ay) * (cz - az) - (bz - az) * (cy - ay),
          (bz - az) * (cx - ax) - (bx - ax) * (cz - az),
          (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
        );
      assert.ok(area > cellArea * 0.01, `degenerate triangle ${area} at ${t / 3}`);
    }
  });

  it('neighbouring quads share an edge (watertight index layout)', () => {
    const N = 20;
    const { indices } = buildGrid(field(N), SIZE);
    const quad = (i, j) => {
      const base = (j * (N - 1) + i) * 6;
      return indices.slice(base, base + 6);
    };
    // horizontal neighbour shares vertex c of the left quad with a of the right
    assert.equal(quad(0, 0)[2], quad(1, 0)[0]);
    // vertical neighbour shares b of the top quad with a of the bottom quad
    assert.equal(quad(0, 0)[1], quad(0, 1)[0]);
    // diagonal neighbour shares d
    assert.equal(quad(0, 0)[5], quad(1, 1)[0]);
  });

  it('is a pure function of the field (no mutation, deterministic output)', () => {
    const f = field(48, 9);
    const before = Array.from(f.data);
    const one = buildGrid(f, SIZE);
    const two = buildGrid(field(48, 9), SIZE);
    assert.deepEqual(Array.from(f.data), before, 'field data mutated');
    assert.deepEqual(Array.from(one.positions), Array.from(two.positions));
    assert.deepEqual(Array.from(one.indices), Array.from(two.indices));
  });
});

describe('vertex placement', () => {
  it('Y comes straight from the heightmap', () => {
    const N = 40;
    const f = field(N, 3);
    const { positions } = buildGrid(f, SIZE);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        assert.equal(positions[(j * N + i) * 3 + 1], f.data[j * N + i]);
      }
    }
  });

  it('spans exactly [-size/2, size/2] in X and Z', () => {
    const N = 33;
    const { positions } = buildGrid(field(N), SIZE);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let k = 0; k < positions.length; k += 3) {
      minX = Math.min(minX, positions[k]);
      maxX = Math.max(maxX, positions[k]);
      minZ = Math.min(minZ, positions[k + 2]);
      maxZ = Math.max(maxZ, positions[k + 2]);
    }
    assert.ok(Math.abs(minX + SIZE / 2) < 1e-9);
    assert.ok(Math.abs(maxX - SIZE / 2) < 1e-9);
    assert.ok(Math.abs(minZ + SIZE / 2) < 1e-9);
    assert.ok(Math.abs(maxZ - SIZE / 2) < 1e-9);
  });

  it('maps grid corner (0,0) to the -X/-Z world corner', () => {
    const { positions } = buildGrid(field(16), SIZE);
    assert.equal(positions[0], -SIZE / 2);
    assert.equal(positions[2], -SIZE / 2);
  });
});

describe('UVs', () => {
  it('are all inside [0,1]', () => {
    const { uvs } = buildGrid(field(64), SIZE);
    for (const v of uvs) assert.ok(v >= 0 && v <= 1, `uv ${v}`);
  });

  it('put (0,0) on vertex 0 and (1,1) on the last vertex', () => {
    const N = 64;
    const { uvs } = buildGrid(field(N), SIZE);
    assert.deepEqual([uvs[0], uvs[1]], [0, 0]);
    const last = (N * N - 1) * 2;
    assert.equal(uvs[last], 1);
    assert.equal(uvs[last + 1], 1);
  });

  it('advance monotonically with i and j', () => {
    const N = 32;
    const { uvs } = buildGrid(field(N), SIZE);
    for (let j = 0; j < N; j++) {
      for (let i = 1; i < N; i++) {
        assert.ok(uvs[(j * N + i) * 2] > uvs[(j * N + i - 1) * 2], 'U not monotonic in i');
      }
    }
    for (let i = 0; i < N; i++) {
      for (let j = 1; j < N; j++) {
        assert.ok(uvs[(j * N + i) * 2 + 1] > uvs[((j - 1) * N + i) * 2 + 1], 'V not monotonic in j');
      }
    }
  });

  it('cover the full 0..1 range uniformly (even spacing)', () => {
    const N = 33;
    const { uvs } = buildGrid(field(N), SIZE);
    const step = 1 / (N - 1);
    for (let i = 0; i < N; i++) {
      assert.ok(Math.abs(uvs[i * 2] - i * step) < 1e-9, `U[${i}] spacing`);
    }
  });
});

describe('buildTerrainGeometry', () => {
  it('assembles position/uv/normal/index attributes with matching sizes', () => {
    const N = 64;
    const { geometry, vertexCount, triangleCount } = buildTerrainGeometry(field(N), SIZE);
    assert.equal(vertexCount, N * N);
    assert.equal(triangleCount, (N - 1) ** 2 * 2);

    const pos = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const nrm = geometry.getAttribute('normal');
    assert.equal(pos.itemSize, 3);
    assert.equal(uv.itemSize, 2);
    assert.equal(nrm.itemSize, 3);
    assert.equal(pos.count, vertexCount);
    assert.equal(uv.count, vertexCount);
    assert.equal(nrm.count, vertexCount);
    assert.equal(geometry.index.count, triangleCount * 3);
  });

  it('computes a bounding sphere that encloses the mesh', () => {
    const { geometry } = buildTerrainGeometry(field(48), SIZE);
    const sphere = geometry.boundingSphere;
    assert.ok(sphere, 'bounding sphere missing');
    const pos = geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i += 7) {
      const d = Math.hypot(
        pos.getX(i) - sphere.center.x,
        pos.getY(i) - sphere.center.y,
        pos.getZ(i) - sphere.center.z
      );
      assert.ok(d <= sphere.radius + 1e-3, `vertex ${i} outside bounding sphere`);
    }
  });

  it('rejects nothing: works at the minimum resolution', () => {
    const { geometry, vertexCount, triangleCount } = buildTerrainGeometry(field(2), SIZE);
    assert.equal(vertexCount, 4);
    assert.equal(triangleCount, 2);
    assert.equal(geometry.index.count, 6);
  });
});

describe('buildNormalLines', () => {
  it('emits one segment per vertex', () => {
    const N = 24;
    const { positions } = buildGrid(field(N), SIZE);
    const normals = new Float32Array(positions.length).fill(0);
    for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1;

    const lines = buildNormalLines(positions, normals, 2.5);
    const arr = lines.geometry.getAttribute('position');
    assert.equal(arr.count, N * N * 2);
  });

  it('draws each segment from the vertex along its normal', () => {
    const positions = new Float32Array([1, 2, 3]);
    const normals = new Float32Array([0, 1, 0]);
    const lines = buildNormalLines(positions, normals, 4);
    const arr = Array.from(lines.geometry.getAttribute('position').array);
    assert.deepEqual(arr.slice(0, 3), [1, 2, 3]);
    assert.deepEqual(arr.slice(3, 6), [1, 6, 3]);
  });

  it('uses a visible line material', () => {
    const lines = buildNormalLines(new Float32Array(3), new Float32Array([0, 1, 0]), 1);
    assert.equal(lines.type, 'LineSegments');
    assert.equal(lines.material.type, 'LineBasicMaterial');
  });
});
