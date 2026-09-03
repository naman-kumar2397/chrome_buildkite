// Measures text contrast from RENDERED PIXELS, in a real browser.
//
//   npm i --no-save playwright && npx playwright install chromium
//   npm run contrast
//
// CHROME_PATH may point at a Chromium / Chrome for Testing binary instead —
// never Google Chrome, which ignores --load-extension since 137.
//
// Checking a text token against a background token proves nothing here: the
// banner floats over an arbitrary page, the popup toolbar is translucent, and
// the chime buttons sit on colour-mixed tints. All three only resolve at paint
// time. So each element is screenshotted and its own pixels are measured.
//
// Threshold is WCAG AA for normal text (4.5:1). Everything checked is small
// text; nothing here qualifies for the 3:1 large-text allowance.

import { launchExtension } from './lib/browser.mjs';

const AA = 4.5;

const { ctx, extId } = await launchExtension({
  viewport: { width: 1100, height: 620 },
  // Sample at 3x: at 1x, small glyphs are mostly antialiased edge pixels and
  // even a near-extreme percentile understates the true text colour.
  deviceScaleFactor: 3,
});

// A scratch page used only to read pixels back out of a screenshot.
const reader = await ctx.newPage();
await reader.goto('data:text/html,<canvas id=c></canvas>');

/**
 * Contrast of the text in one element, from its rendered pixels.
 * The background is the modal luminance in the box; the foreground is the
 * furthest percentile away from it, which skips antialiased edge pixels.
 */
async function measure(page, handle, label) {
  const box = await handle.boundingBox();
  if (!box || box.width < 2 || box.height < 2) return { label, skipped: 'not visible' };

  const shot = await page.screenshot({
    scale: 'device',
    clip: { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) },
  });

  return reader.evaluate(async ({ png, label: name }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const c = document.getElementById('c');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const { data } = g.getImageData(0, 0, c.width, c.height);

    const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    const lum = (r, gr, b) => 0.2126 * lin(r) + 0.7152 * lin(gr) + 0.0722 * lin(b);

    const ls = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 250) continue; // ignore anything not fully painted
      ls.push(lum(data[i], data[i + 1], data[i + 2]));
    }
    if (ls.length < 40) return { label: name, skipped: 'too few pixels' };
    ls.sort((a, b) => a - b);

    const at = (p) => ls[Math.min(ls.length - 1, Math.max(0, Math.round((ls.length - 1) * p)))];
    const bg = at(0.5);       // the box is mostly background
    // Near-extreme rather than the true min/max: skips a stray outlier pixel
    // without understating solid glyph interiors the way a 2nd percentile does.
    const dark = at(0.005);
    const light = at(0.995);
    // Whichever direction the glyphs actually run.
    const fg = Math.abs(bg - dark) >= Math.abs(light - bg) ? dark : light;
    const ratio = (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
    return { label: name, ratio: Math.round(ratio * 100) / 100, pixels: ls.length };
  }, { png: shot.toString('base64'), label });
}

const results = [];
async function check(page, selector, label, root) {
  const handle = root
    ? await page.evaluateHandle(([r, s]) => r.shadowRoot.querySelector(s), [root, selector])
    : await page.$(selector);
  const el = handle.asElement ? handle.asElement() : handle;
  if (!el) { results.push({ label, skipped: 'not found' }); return; }
  results.push(await measure(page, el, label));
}

// ---------------------------------------------------------------------------
// The in-page banner, over three grounds — including the one that actually
// broke: a light <body> with the dark theme painted by an inner wrapper.
// ---------------------------------------------------------------------------

const GROUNDS = {
  'dark page': 'body{margin:0;background:#0b0d10;color:#d8dde5}',
  'light page': 'body{margin:0;background:#ffffff;color:#1c1c1e}',
  'light body, dark wrapper': 'body{margin:0;background:#ffffff}.app{min-height:100vh;background:#0b0d10;color:#d8dde5}',
};

for (const [name, css] of Object.entries(GROUNDS)) {
  await ctx.unroute('https://buildkite.com/**').catch(() => {});
  await ctx.route('https://buildkite.com/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><title>Running: web #1207</title><style>${css}</style>
      <div class="app"><div style="padding:16px 22px">web #1207 — Running for 43m</div></div>`,
  }));

  const page = await ctx.newPage();
  await page.goto('https://buildkite.com/acme/web/builds/1207');
  await page.waitForTimeout(1600);
  const host = await page.$('#bk-build-watcher-banner');
  if (!host) { results.push({ label: `banner (${name})`, skipped: 'banner absent' }); await page.close(); continue; }

  await check(page, '.text', `banner text — ${name}`, host);
  await check(page, '.action', `banner button — ${name}`, host);
  await page.close();
}

// ---------------------------------------------------------------------------
// The popup, in both appearances.
// ---------------------------------------------------------------------------

const now = Date.now();
for (const scheme of ['light', 'dark']) {
  const page = await ctx.newPage();
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await page.evaluate(async (t) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      volume: 0.6,
      settings: { discovery: true, autoWatchCap: 25 },
      auth: { signedOut: false, at: t },
      discoveryState: { provider: 'json', error: null, found: 2, at: t - 5000 },
      watches: {
        'https://buildkite.com/acme/web/builds/12': {
          org: 'acme', pipeline: 'web', number: 12, url: 'https://buildkite.com/acme/web/builds/12',
          prev: { state: 'running', blocked: false, finished: false },
          provider: 'json', source: 'auto', addedAt: t - 9000, lastChecked: t - 3000, lastError: null,
        },
        'https://buildkite.com/acme/api/builds/9': {
          org: 'acme', pipeline: 'api', number: 9, url: 'https://buildkite.com/acme/api/builds/9',
          prev: null, provider: null, addedAt: t - 9000, lastChecked: t - 3000,
          lastError: 'all providers failed', errorCode: 'shape',
        },
      },
      recent: [
        { url: 'https://buildkite.com/acme/api/builds/8', org: 'acme', pipeline: 'api', number: 8, event: 'success', state: 'passed', at: t - 40000 },
        { url: 'https://buildkite.com/acme/web/builds/11', org: 'acme', pipeline: 'web', number: 11, event: 'failure', state: 'failed', at: t - 90000 },
        { url: 'https://buildkite.com/acme/infra/builds/3', org: 'acme', pipeline: 'infra', number: 3, event: 'input', state: 'running', at: t - 200000 },
      ],
    });
  }, now);
  await page.reload();
  await page.waitForTimeout(700);

  for (const [sel, label] of [
    ['.outcome.success', 'popup "Passed"'],
    ['.outcome.failure', 'popup "Failed"'],
    ['.outcome.input', 'popup "Needed input"'],
    ['.meta.is-error', 'popup row error'],
    ['#watches .meta', 'popup row meta'],
    ['.tag', 'popup AUTO tag'],
    ['#discovery-status', 'popup discovery status'],
    ['h2', 'popup section heading'],
    ['.toolbar h1', 'popup title (on glass)'],
    ['[data-chime="success"]', 'chime button "Passed"'],
    ['[data-chime="failure"]', 'chime button "Failed"'],
    ['[data-chime="input"]', 'chime button "Input"'],
    ['#diagnostics', 'popup link'],
  ]) await check(page, sel, `${label} — ${scheme}`);

  await page.close();
}

await ctx.close();

// ---------------------------------------------------------------------------

let failed = 0;
const width = Math.max(...results.map((r) => r.label.length));
for (const r of results) {
  if (r.skipped) { console.log(`  SKIP  ${r.label.padEnd(width)}  ${r.skipped}`); continue; }
  const ok = r.ratio >= AA;
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${r.label.padEnd(width)}  ${r.ratio.toFixed(2)}:1`);
}
console.log(`\n${results.length - failed} passed, ${failed} below ${AA}:1`);
if (failed) {
  console.error('\nContrast failures. The default colour tier is for fills; small text needs the '
    + 'increased-contrast tier in every appearance.');
  process.exitCode = 1;
}
