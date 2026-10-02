import * as THREE from 'three';

const widthSegments = 150;
const depthSegments = 150;
const terrainWidth = 120;
const terrainDepth = 120;
const maxHeight = 20;

const container = document.getElementById('app');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
);
camera.position.set(60, 55, 60);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
directionalLight.position.set(55, 85, 30);
scene.add(directionalLight);

const terrain = createTerrainMesh(
  widthSegments,
  depthSegments,
  terrainWidth,
  terrainDepth,
  maxHeight,
);
terrain.rotation.x = -Math.PI * 0.5;
scene.add(terrain);

function pseudoNoise(x, z) {
  const ridge = Math.sin(x * 0.08) * Math.cos(z * 0.09);
  const hills = Math.sin((x + z) * 0.04) * 0.7;
  const detail = Math.sin(x * 0.3 + z * 0.23) * 0.15;
  return ridge * 0.65 + hills * 0.3 + detail;
}

function createHeightMap(cols, rows, maxY) {
  const map = new Float32Array((cols + 1) * (rows + 1));
  let i = 0;

  for (let z = 0; z <= rows; z += 1) {
    for (let x = 0; x <= cols; x += 1) {
      const n = pseudoNoise(x, z);
      map[i] = n * maxY;
      i += 1;
    }
  }

  return map;
}

function indexFor(x, z, cols) {
  return z * (cols + 1) + x;
}

function calculateVertexNormals(positions, indices) {
  const normals = new Float32Array(positions.length);

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;

    const ax = positions[a];
    const ay = positions[a + 1];
    const az = positions[a + 2];
    const bx = positions[b];
    const by = positions[b + 1];
    const bz = positions[b + 2];
    const cx = positions[c];
    const cy = positions[c + 1];
    const cz = positions[c + 2];

    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;

    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    normals[a] += nx;
    normals[a + 1] += ny;
    normals[a + 2] += nz;
    normals[b] += nx;
    normals[b + 1] += ny;
    normals[b + 2] += nz;
    normals[c] += nx;
    normals[c + 1] += ny;
    normals[c + 2] += nz;
  }

  for (let i = 0; i < normals.length; i += 3) {
    const nx = normals[i];
    const ny = normals[i + 1];
    const nz = normals[i + 2];
    const mag = Math.hypot(nx, ny, nz) || 1;
    normals[i] = nx / mag;
    normals[i + 1] = ny / mag;
    normals[i + 2] = nz / mag;
  }

  return normals;
}

function colorForHeight(y, minY, maxY) {
  const t = THREE.MathUtils.clamp((y - minY) / (maxY - minY || 1), 0, 1);

  if (t < 0.32) {
    return new THREE.Color().lerpColors(
      new THREE.Color(0x1f4d2e),
      new THREE.Color(0x3f7f40),
      t / 0.32,
    );
  }

  if (t < 0.68) {
    return new THREE.Color().lerpColors(
      new THREE.Color(0x5f8f45),
      new THREE.Color(0x8d7a54),
      (t - 0.32) / 0.36,
    );
  }

  return new THREE.Color().lerpColors(
    new THREE.Color(0xb8b7b0),
    new THREE.Color(0xffffff),
    (t - 0.68) / 0.32,
  );
}

function createTerrainMesh(cols, rows, sizeX, sizeZ, maxY) {
  const vertexCount = (cols + 1) * (rows + 1);
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colors = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(cols * rows * 6);

  const heights = createHeightMap(cols, rows, maxY);
  let minY = Infinity;
  let highestY = -Infinity;

  for (let z = 0; z <= rows; z += 1) {
    for (let x = 0; x <= cols; x += 1) {
      const i = indexFor(x, z, cols);
      const y = heights[i];
      minY = Math.min(minY, y);
      highestY = Math.max(highestY, y);

      positions[i * 3] = (x / cols - 0.5) * sizeX;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = (z / rows - 0.5) * sizeZ;

      uvs[i * 2] = x / cols;
      uvs[i * 2 + 1] = z / rows;
    }
  }

  for (let z = 0; z <= rows; z += 1) {
    for (let x = 0; x <= cols; x += 1) {
      const i = indexFor(x, z, cols);
      const y = heights[i];
      const color = colorForHeight(y, minY, highestY);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
  }

  let idx = 0;
  for (let z = 0; z < rows; z += 1) {
    for (let x = 0; x < cols; x += 1) {
      const topLeft = indexFor(x, z, cols);
      const topRight = indexFor(x + 1, z, cols);
      const bottomLeft = indexFor(x, z + 1, cols);
      const bottomRight = indexFor(x + 1, z + 1, cols);

      indices[idx] = topLeft;
      indices[idx + 1] = bottomLeft;
      indices[idx + 2] = topRight;
      indices[idx + 3] = topRight;
      indices[idx + 4] = bottomLeft;
      indices[idx + 5] = bottomRight;
      idx += 6;
    }
  }

  const normals = calculateVertexNormals(positions, indices);

  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });

  return new THREE.Mesh(geometry, material);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  terrain.rotation.z += 0.0008;
  renderer.render(scene, camera);
}

animate();
