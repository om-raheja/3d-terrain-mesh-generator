/**
 * noise.js — deterministic value/gradient noise used to build the 2D heightmap.
 *
 * The heightmap is just a 2D scalar field h(x, z). Everything downstream
 * (vertices, normals, colors) is derived from this array, so the noise here
 * is the only "content" in the whole generator.
 */

/** Small, fast, seedable PRNG (mulberry32). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Classic 2D Perlin gradient noise with a seeded permutation table.
 *
 * Returns roughly [-1.4, 1.4]: the classic gradient set is not unit-length
 * (diagonal gradients are √2, axis gradients 1) and the fade/lerp step can
 * overshoot slightly, so the 1.4 scale below trades a tight bound for a
 * nicely distributed one. Zero exactly on integer lattice points.
 */
export function createPerlin2D(seed) {
  const rand = mulberry32(seed);

  // Fisher–Yates shuffle of [0..255], doubled so we can index without masking.
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  // The 8 gradient directions of classic Perlin.
  const GRAD = [
    [1, 1], [-1, 1], [1, -1], [-1, -1],
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ];

  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10); // 6t^5 - 15t^4 + 10t^3
  const lerp = (a, b, t) => a + (b - a) * t;

  function dot(ix, iy, x, y) {
    const g = GRAD[perm[(perm[ix] + iy) & 255] & 7];
    return g[0] * x + g[1] * y;
  }

  return function noise2(x, y) {
    // Unit square containing the point + fractional coords inside it.
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);

    // Fade curves for smooth (C2-continuous) interpolation.
    const u = fade(xf);
    const v = fade(yf);

    // Gradient dot products at the four corners of the cell.
    const n00 = dot(xi, yi, xf, yf);
    const n10 = dot(xi + 1, yi, xf - 1, yf);
    const n01 = dot(xi, yi + 1, xf, yf - 1);
    const n11 = dot(xi + 1, yi + 1, xf - 1, yf - 1);

    // Bilinear blend of the corner gradients.
    return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 1.4;
  };
}

/**
 * Fractional Brownian Motion (fBm): sum octaves of Perlin noise, each octave
 * at `lacunarity`x the frequency and `persistence`x the amplitude of the last.
 *
 *   h = Σ (amplitude_k * noise(freq_k * p)) / Σ amplitude_k
 *
 * Normalising by the total amplitude keeps the result inside the same envelope
 * as a single octave (≈±1.4 with this gradient set) no matter how many
 * octaves are stacked, so `amplitude` stays the only height knob.
 */
export function fbm(noise, x, y, { octaves, frequency, persistence, lacunarity }) {
  let amplitude = 1;
  let sum = 0;
  let norm = 0;
  let freq = frequency;

  for (let o = 0; o < octaves; o++) {
    sum += noise(x * freq, y * freq) * amplitude;
    norm += amplitude;
    amplitude *= persistence;
    freq *= lacunarity;
  }
  return sum / norm;
}

/**
 * Builds the 2D heightmap: an Float32Array of `resolution^2` heights in world
 * units, sampled on the unit square so the mesh can map it onto any size.
 */
export function createHeightField({
  seed = 1337,
  resolution = 128,
  noiseScale = 3,
  octaves = 5,
  persistence = 0.5,
  lacunarity = 2,
  amplitude = 26,
} = {}) {
  const noise = createPerlin2D(seed);
  const data = new Float32Array(resolution * resolution);

  let min = Infinity;
  let max = -Infinity;

  for (let j = 0; j < resolution; j++) {
    for (let i = 0; i < resolution; i++) {
      const u = i / (resolution - 1);
      const v = j / (resolution - 1);

      // Sample fBm in unit-square coordinates; the mesh scales this to world
      // size later, so noiseScale stays resolution-independent.
      const h = fbm(noise, u, v, {
        octaves,
        frequency: noiseScale,
        persistence,
        lacunarity,
      });

      const y = h * amplitude;
      const idx = j * resolution + i;
      data[idx] = y;
      // Track the *stored* value: the array is Float32, so the mesh (and the
      // shader uniforms fed from min/max) see this, not the double above.
      const stored = data[idx];
      if (stored < min) min = stored;
      if (stored > max) max = stored;
    }
  }

  return { data, resolution, min, max, amplitude };
}
