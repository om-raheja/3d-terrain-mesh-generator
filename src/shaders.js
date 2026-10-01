/**
 * shaders.js — the dynamic height-based shading.
 *
 * Two-stage pipeline:
 *   vertex shader   : model -> world space, pass position/normal/uv varyings
 *   fragment shader : normalise the height into t ∈ [0,1], ramp a colour from
 *                     it, tint steep slopes toward rock, light it with a
 *                     Lambert + Blinn-Phong directional term, gamma encode.
 *
 * The colour is a function of world-space Y, so it updates automatically when
 * the heightmap changes — no baked textures, no vertex colours to repaint.
 */

import * as THREE from 'three';

const vertexShader = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec2 vUv;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    // mat3(modelMatrix) is fine here: the terrain mesh has no rotation/skew,
    // only uniform-ish transform. (Normal matrix for a rigid transform = M.)
    vNormal = normalize(mat3(modelMatrix) * normal);
    vUv = uv;

    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform float uMinHeight;      // lowest Y in the mesh
  uniform float uMaxHeight;      // highest Y in the mesh
  uniform vec3  uSunDir;         // unit vector pointing TOWARD the sun
  uniform vec3  uSunColor;
  uniform vec3  uAmbient;
  uniform vec3  uValley;         // colour stops (linear space)
  uniform vec3  uGrass;
  uniform vec3  uRock;
  uniform vec3  uSnow;
  uniform vec3  uFogColor;
  uniform vec2  uFogRange;       // (near, far)
  uniform float uShininess;
  uniform float uSpecular;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec2 vUv;

  // Piecewise colour ramp on normalised height t.
  vec3 ramp(float t) {
    vec3 c = uValley;
    c = mix(c, uGrass, smoothstep(0.10, 0.32, t));
    c = mix(c, uRock,  smoothstep(0.44, 0.64, t));
    c = mix(c, uSnow,  smoothstep(0.74, 0.91, t));
    return c;
  }

  void main() {
    vec3 N = normalize(vNormal);

    // 1. Height -> t ∈ [0,1] so the ramp is resolution/amplitude independent.
    float span = max(uMaxHeight - uMinHeight, 1e-4);
    float t = clamp((vWorldPos.y - uMinHeight) / span, 0.0, 1.0);
    vec3 albedo = ramp(t);

    // 2. Slope mask: N.y = 1 on flat ground, 0 on a vertical wall.
    //    Steep faces get exposed rock regardless of altitude.
    float slope = 1.0 - clamp(N.y, 0.0, 1.0);
    albedo = mix(albedo, uRock * 0.85, smoothstep(0.34, 0.72, slope));

    // 3. Directional (Lambert) diffuse: the dot of surface normal and sun.
    float ndl = max(dot(N, uSunDir), 0.0);

    // 4. Blinn-Phong specular: half-vector between sun and viewer.
    //    Guard the normalisation — when the sun sits exactly opposite the
    //    view direction uSunDir + V has zero length and NaN would spread
    //    through the whole fragment.
    vec3 V = cameraPosition - vWorldPos;
    V /= max(length(V), 1e-5);
    vec3 halfway = uSunDir + V;
    vec3 H = halfway / max(length(halfway), 1e-5);
    float spec = pow(max(dot(N, H), 0.0), uShininess) * uSpecular;

    // 5. Sky-tinted ambient (upward normals get a little more sky light).
    float sky = 0.5 + 0.5 * N.y;
    vec3 ambient = uAmbient * mix(0.75, 1.15, sky);

    vec3 color = albedo * (ambient + uSunColor * ndl) + uSunColor * spec * ndl;

    // 6. Distance fog so the horizon fades into the sky colour.
    float dist = length(cameraPosition - vWorldPos);
    float fog = smoothstep(uFogRange.x, uFogRange.y, dist);
    color = mix(color, uFogColor, fog);

    // 7. Linear -> sRGB (renderer writes straight to the default framebuffer).
    color = pow(max(color, 0.0), vec3(1.0 / 2.2));

    gl_FragColor = vec4(color, 1.0);
  }
`;

const srgb = (hex) => new THREE.Color(hex); // three converts to linear working space

export function createTerrainMaterial() {
  const uniforms = {
    uMinHeight: { value: -1 },
    uMaxHeight: { value: 1 },
    uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
    uSunColor: { value: srgb(0xfff0d0).multiplyScalar(1.35) },
    uAmbient: { value: srgb(0x5878a0).multiplyScalar(0.5) },
    uValley: { value: srgb(0x2a5a44) },
    uGrass: { value: srgb(0x63a04a) },
    uRock: { value: srgb(0x8d7d6a) },
    uSnow: { value: srgb(0xf5f8fb) },
    uFogColor: { value: srgb(0x9dc0e0) },
    uFogRange: { value: new THREE.Vector2(340, 780) },
    uShininess: { value: 48 },
    uSpecular: { value: 0.35 },
  };

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
  });
}

/** Re-aims the sun from azimuth/elevation in degrees. */
export function setSunAngles(uniforms, azimuthDeg, elevationDeg) {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  uniforms.uSunDir.value.set(
    Math.cos(el) * Math.cos(az),
    Math.sin(el),
    Math.cos(el) * Math.sin(az)
  ).normalize();
}
