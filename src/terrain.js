/**
 * terrain.js — turns the 2D heightmap into a renderable triangle mesh.
 *
 * Nothing here uses a built-in terrain system: positions, UVs, indices and
 * normals are all written by hand so the whole pipeline is inspectable.
 *
 * Grid convention
 * ---------------
 *   resolution N  ->  N x N vertices, (N-1) x (N-1) quads
 *   vertex (i, j) ->  index  j * N + i
 *   world X       ->  (i / (N-1) - 0.5) * size      (left -> right)
 *   world Z       ->  (j / (N-1) - 0.5) * size      (near -> far)
 *   world Y       ->  heightmap[j * N + i]          (up)
 */

import * as THREE from 'three';

/**
 * Generates positions, UVs and indices for an N x N grid.
 *
 * Each quad is split into two triangles wound counter-clockwise when viewed
 * from above (+Y), so every face normal initially points at the sky and the
 * mesh is front-facing from a normal camera angle.
 *
 *   b --- d        b = (i,   j+1)
 *   | \   |        d = (i+1, j+1)
 *   |  \  |        a = (i,   j  )
 *   a --- c        c = (i+1, j  )
 *
 *   triangles:  (a, b, c)  and  (c, b, d)
 */
export function buildGrid(field, size = 200) {
  const N = field?.resolution;
  if (!Number.isInteger(N) || N < 2) {
    throw new RangeError(`grid resolution must be an integer >= 2 (got ${N})`);
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new RangeError(`terrain size must be a positive finite number (got ${size})`);
  }
  if (!field.data || field.data.length !== N * N) {
    throw new RangeError(
      `height field must hold exactly ${N * N} samples (got ${field.data?.length})`
    );
  }

  const vertexCount = N * N;

  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const inv = 1 / (N - 1);

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const idx = j * N + i;
      const height = field.data[idx];
      // One NaN here would poison an entire ring of normals, so fail loudly.
      if (!Number.isFinite(height)) {
        throw new TypeError(`height field contains a non-finite value at index ${idx}`);
      }
      positions[idx * 3 + 0] = (i * inv - 0.5) * size;        // X
      positions[idx * 3 + 1] = height;                         // Y = height
      positions[idx * 3 + 2] = (j * inv - 0.5) * size;        // Z
      uvs[idx * 2 + 0] = i * inv;                              // U 0..1
      uvs[idx * 2 + 1] = j * inv;                              // V 0..1
    }
  }

  const quadCount = (N - 1) * (N - 1);
  const indices = new Uint32Array(quadCount * 6);
  let k = 0;
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i;
      const b = (j + 1) * N + i;
      const c = j * N + i + 1;
      const d = (j + 1) * N + i + 1;
      indices[k++] = a; indices[k++] = b; indices[k++] = c;
      indices[k++] = c; indices[k++] = b; indices[k++] = d;
    }
  }

  return { positions, uvs, indices, vertexCount };
}

/**
 * Computes one unit normal per vertex from the triangle soup.
 *
 * For each triangle:
 *   e1 = v1 - v0
 *   e2 = v2 - v0
 *   faceNormal = e1 x e2          (right-hand rule; |n| = 2 * triangle area)
 *
 * That un-normalised cross product is accumulated into all three corner
 * vertices — this is area weighting, big triangles contribute more — and the
 * accumulated vector is normalised at the end:
 *
 *   vertexNormal = normalize( Σ faceNormal )
 *
 * Because the grid shares vertex indices between neighbouring quads, this
 * averages across every face that touches a vertex, which is exactly the
 * smooth-shaded normal directional lighting needs to see slopes vs. flats.
 */
export function computeVertexNormals(positions, indices) {
  const vertexCount = positions.length / 3;
  const normals = new Float32Array(vertexCount * 3);

  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t] * 3;
    const ib = indices[t + 1] * 3;
    const ic = indices[t + 2] * 3;

    const e1x = positions[ib] - positions[ia];
    const e1y = positions[ib + 1] - positions[ia + 1];
    const e1z = positions[ib + 2] - positions[ia + 2];

    const e2x = positions[ic] - positions[ia];
    const e2y = positions[ic + 1] - positions[ia + 1];
    const e2z = positions[ic + 2] - positions[ia + 2];

    // cross(e1, e2)
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    // Accumulate (area weighted) into the three corners.
    normals[ia] += nx; normals[ia + 1] += ny; normals[ia + 2] += nz;
    normals[ib] += nx; normals[ib + 1] += ny; normals[ib + 2] += nz;
    normals[ic] += nx; normals[ic + 1] += ny; normals[ic + 2] += nz;
  }

  for (let v = 0; v < vertexCount; v++) {
    const o = v * 3;
    const len = Math.hypot(normals[o], normals[o + 1], normals[o + 2]);
    if (len > 0) {
      normals[o] /= len;
      normals[o + 1] /= len;
      normals[o + 2] /= len;
    } else {
      // Every face touching this vertex was degenerate (zero area). Rather
      // than emitting a zero-length normal — which would shade black —
      // default to pointing straight up.
      normals[o + 1] = 1;
    }
  }

  return normals;
}

/** Assembles the BufferGeometry: position + uv + index + normal attributes. */
export function buildTerrainGeometry(field, size = 200) {
  const { positions, uvs, indices, vertexCount } = buildGrid(field, size);
  const normals = computeVertexNormals(positions, indices);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();

  return { geometry, vertexCount, triangleCount: indices.length / 3 };
}

/**
 * Debug visualisation: a line segment per vertex pointing along its normal.
 * Handy for proving the normals actually match the slopes.
 */
export function buildNormalLines(positions, normals, length = 2.5) {
  const count = positions.length / 3;
  const arr = new Float32Array(count * 6);

  for (let v = 0; v < count; v++) {
    const p = v * 3;
    const l = v * 6;
    arr[l] = positions[p];
    arr[l + 1] = positions[p + 1];
    arr[l + 2] = positions[p + 2];
    arr[l + 3] = positions[p] + normals[p] * length;
    arr[l + 4] = positions[p + 1] + normals[p + 1] * length;
    arr[l + 5] = positions[p + 2] + normals[p + 2] * length;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xff4fd8 }));
}
