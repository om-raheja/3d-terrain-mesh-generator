#!/usr/bin/env node
/**
 * Copy the deployable site into dist/ for the Cloudflare Worker.
 *
 * The site itself has no build step: `npm start` serves the repo root as-is.
 * This copy exists only because `wrangler dev` watches its asset directory —
 * pointing that at the repo root makes it watch Wrangler's own `.wrangler/`
 * state files, which are rewritten continuously and put dev into an infinite
 * reload loop. dist/ contains exactly the files the site loads (see
 * index.html: `./src/main.js` → noise/terrain/shaders), so there is nothing
 * to filter and nothing hand-edited: it is gitignored and rebuilt on every
 * `npm run dev` / `npm run deploy`.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/** Everything the browser fetches, plus the screenshot referenced by docs. */
const INCLUDE = ['index.html', 'src', 'docs'];

function measure(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = measure(path);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files += 1;
      bytes += statSync(path).size;
    }
  }
  return { files, bytes };
}

const missing = INCLUDE.filter((entry) => !existsSync(join(ROOT, entry)));
if (missing.length > 0) {
  console.error(`build-assets: missing required ${missing.length === 1 ? 'entry' : 'entries'}: ${missing.join(', ')}`);
  process.exit(1);
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

for (const entry of INCLUDE) {
  cpSync(join(ROOT, entry), join(DIST, entry), { recursive: true });
}

const { files, bytes } = measure(DIST);
console.log(`build-assets: dist/ <- ${INCLUDE.join(', ')} (${files} files, ${(bytes / 1024).toFixed(1)} kB)`);
