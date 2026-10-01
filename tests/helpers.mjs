/**
 * tests/helpers.mjs — shared harness for the browser-backed tests.
 *
 * Each browser test file starts its own static server on a distinct port so
 * files can run concurrently, launches a cached headless Chromium, loads the
 * app, and tears everything down.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function chromePath() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const candidates = [
    process.env.CHROME_PATH,
    `${home}/.cache/ms-playwright/chromium-1228/chrome-linux/chrome`,
    `${home}/.cache/ms-playwright/chromium-1217/chrome-linux/chrome`,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);

  const path = candidates.find((c) => existsSync(c));
  if (!path) {
    throw new Error(
      'No Chromium found. Set CHROME_PATH or install a Playwright browser.'
    );
  }
  return path;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startServer(port) {
  const proc = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
    cwd: ROOT,
    stdio: 'ignore',
  });

  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (i === 59) {
      proc.kill();
      throw new Error(`static server on :${port} never came up`);
    }
    await sleep(100);
  }

  return {
    url,
    close: () => proc.kill(),
  };
}

export async function launchBrowser() {
  const { chromium } = await import('playwright-core');
  return chromium.launch({
    executablePath: chromePath(),
    args: [
      '--no-sandbox',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
    ],
  });
}

/**
 * Boots the app and returns the page plus a list of console/page errors.
 * `waitReady` resolves once the first mesh rebuild has completed.
 */
export async function openApp(port) {
  const server = await startServer(port);
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('requestfailed', (r) =>
    errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`)
  );

  await page.goto(server.url, { waitUntil: 'load' });
  await page.waitForFunction(
    () => window.__APP && document.getElementById('statVerts').textContent !== '–',
    undefined,
    { timeout: 20000 }
  );

  return {
    page,
    errors,
    url: server.url,
    close: async () => {
      await browser.close();
      server.close();
    },
  };
}

/** Reads back the WebGL framebuffer and summarises what was drawn. */
export function readFrame() {
  const { renderer, scene, camera } = window.__APP;
  renderer.render(scene, camera);
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

  // readPixels origin is bottom-left; sample just inside the top-left corner.
  const skyAt = ((h - 2) * w + 2) * 4;
  const sky = [px[skyAt], px[skyAt + 1], px[skyAt + 2]];

  let terrain = 0;
  let total = 0;
  let green = 0;
  let bright = 0;
  let lumMin = 255;
  let lumMax = 0;
  let lumSum = 0;

  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      const o = (y * w + x) * 4;
      const r = px[o];
      const g = px[o + 1];
      const b = px[o + 2];
      total++;
      const isSky =
        Math.abs(r - sky[0]) < 12 &&
        Math.abs(g - sky[1]) < 12 &&
        Math.abs(b - sky[2]) < 12;
      if (isSky) continue;
      terrain++;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumMin = Math.min(lumMin, lum);
      lumMax = Math.max(lumMax, lum);
      lumSum += lum;
      if (g > r + 8 && g > b + 8) green++;
      if (r > 200 && g > 200 && b > 200) bright++;
    }
  }

  return {
    sky,
    terrain,
    total,
    green,
    bright,
    lumMin,
    lumMax,
    lumMean: terrain ? lumSum / terrain : 0,
    w,
    h,
  };
}
