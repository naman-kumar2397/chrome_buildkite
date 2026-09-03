// Renders the extension icons and the Chrome Web Store listing icon from one
// source, so the mark in the toolbar, the in-page banner and the store listing
// are the same drawing.
//
//   npm i --no-save playwright
//   CHROME_PATH=/path/to/chrome npm run icons
//
// Outputs:
//   icons/icon16.png, icon48.png, icon128.png   artwork fills the tile (browser UI)
//   store/store-icon-128.png                    96x96 artwork centred in 128x128
//
// The store icon follows Google's sizing guidance: the artwork occupies 96x96
// inside a 128x128 canvas, leaving 16px of transparent padding on every side,
// and carries no drop shadow — the store applies its own treatment.

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

// The same bell used by the popup toolbar and the in-page banner, on a 24 grid.
const BELL = 'M12 2.6a1.15 1.15 0 0 1 1.15 1.15v.62a6.2 6.2 0 0 1 5.05 6.1v3.3l1.3 2.2a.9.9 0 0 1-.78 '
  + '1.36H5.28a.9.9 0 0 1-.78-1.36l1.3-2.2v-3.3a6.2 6.2 0 0 1 5.05-6.1v-.62A1.15 1.15 0 0 1 12 2.6Zm0 '
  + '18.8a2.5 2.5 0 0 1-2.42-1.9h4.84A2.5 2.5 0 0 1 12 21.4Z';

/**
 * A superellipse — the continuous curve Apple uses for app icons, rather than a
 * rounded rectangle. |x/a|^n + |y/b|^n = 1 with n = 4 is very close to theirs,
 * and the corner reads as one sweep instead of an arc spliced onto a straight.
 */
function squirclePath(size, n = 4, steps = 720) {
  const r = size / 2;
  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * 2 * Math.PI;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const x = r + Math.sign(c) * Math.abs(c) ** (2 / n) * r;
    const y = r + Math.sign(s) * Math.abs(s) ** (2 / n) * r;
    pts.push(`${x.toFixed(3)},${y.toFixed(3)}`);
  }
  return `M${pts.join('L')}Z`;
}

/**
 * @param {number} tile   artwork size in px
 * @param {number} canvas full image size in px (tile === canvas means no padding)
 * @param {number} glyph  bell width as a fraction of the tile
 */
function svg(tile, canvas, glyph) {
  const pad = (canvas - tile) / 2;
  const bell = tile * glyph;
  const bx = pad + (tile - bell) / 2;
  // Optically centred: a bell's visual mass sits low, so it is nudged up.
  const by = pad + (tile - bell) / 2 - tile * 0.015;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}"
       viewBox="0 0 ${canvas} ${canvas}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0" stop-color="#4BE07B"/>
        <stop offset="0.52" stop-color="#34C759"/>
        <stop offset="1" stop-color="#17924A"/>
      </linearGradient>
      <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.30"/>
        <stop offset="0.45" stop-color="#ffffff" stop-opacity="0.04"/>
        <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
      </linearGradient>
      <clipPath id="clip">
        <path d="${squirclePath(tile)}" transform="translate(${pad} ${pad})"/>
      </clipPath>
    </defs>

    <g clip-path="url(#clip)">
      <rect x="${pad}" y="${pad}" width="${tile}" height="${tile}" fill="url(#g)"/>
      <rect x="${pad}" y="${pad}" width="${tile}" height="${tile}" fill="url(#sheen)"/>
    </g>

    <g transform="translate(${bx} ${by}) scale(${bell / 24})">
      <path d="${BELL}" fill="#ffffff"/>
    </g>
  </svg>`;
}

const ctx = await chromium.launchPersistentContext('', {
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
  channel: process.env.CHROME_PATH ? undefined : 'chrome',
});

async function render(file, { tile, canvas, glyph }) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: canvas, height: canvas });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}</style>${svg(tile, canvas, glyph)}`,
  );
  await page.waitForTimeout(120);
  await mkdir(path.dirname(path.join(ROOT, file)), { recursive: true });
  await page.screenshot({ path: path.join(ROOT, file), omitBackground: true });
  await page.close();
  console.log(`wrote ${file}  ${canvas}x${canvas}`);
}

// Browser UI: the artwork fills the tile. Smaller sizes get a proportionally
// larger glyph, because fine margins disappear at 16px.
await render('icons/icon16.png', { tile: 16, canvas: 16, glyph: 0.80 });
await render('icons/icon48.png', { tile: 48, canvas: 48, glyph: 0.62 });
await render('icons/icon128.png', { tile: 128, canvas: 128, glyph: 0.58 });

// Store listing: 96x96 of artwork inside 128x128, per Google's guidance.
await render('store/store-icon-128.png', { tile: 96, canvas: 128, glyph: 0.58 });

await ctx.close();
