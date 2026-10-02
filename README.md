# 3d-terrain-mesh-generator

A procedural 3D terrain mesh generator built with Three.js.

## Requirements Coverage

- **Programmatic mesh generation:** Vertices, UVs, and triangle indices are generated from a 2D noise height map in `/src/main.js`.
- **Normals and lighting:** Per-vertex normals are calculated manually from triangle cross products and used with directional lighting.
- **Dynamic height-based shading:** Vertex colors are assigned by normalized Y-height (green lowlands, rocky midlands, snowy peaks).

## Run Locally

```bash
npm install
npm run dev
```

Then open the local Vite URL in a browser.

## Build Check

```bash
npm run build
```

## Loom Video (Required)

Add your 2-3 minute explanation video URL here:

- Loom: `REPLACE_WITH_LOOM_LINK`
