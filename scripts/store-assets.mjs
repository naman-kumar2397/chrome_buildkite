// Generate Chrome Web Store listing assets from FICTIONAL data.
// Never point this at a real Buildkite session: the output is published.
//
//   npm i --no-save playwright
//   CHROME_PATH=/path/to/chrome node scripts/store-assets.mjs
//
// Writes store/screenshot-*.png (1280x800) and store/promo-small.png (440x280).

import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const OUT = path.join(ROOT, 'store');
await mkdir(OUT, { recursive: true });

// The canvas pages are not extension pages, so a chrome-extension:// stylesheet
// will not load into them — inline the tokens instead.
const TOKENS = await readFile(path.join(ROOT, 'vendor', 'apple.css'), 'utf8');

const now = Date.now();

// What the fake buildkite.com returns while the assets are captured.
const LISTING = [
  { path: '/acme/web/builds/1482', number: 1482, state: 'started', blocked_state: null, finished_at: null },
  { path: '/acme/api/builds/921', number: 921, state: 'started', blocked_state: null, finished_at: null },
  { path: '/acme/infra/builds/59', number: 59, state: 'scheduled', blocked_state: null, finished_at: null },
  { path: '/acme/payments/builds/307', number: 307, state: 'passed', blocked_state: 'blocked', finished_at: null },
];

const base = { volume: 0.6, settings: { discovery: true, autoWatchCap: 25 }, auth: { signedOut: false, at: now } };

const W = (pipeline, number, extra) => ({
  org: 'acme', pipeline, number, url: `https://buildkite.com/acme/${pipeline}/builds/${number}`,
  provider: 'json', addedAt: now - 90000, lastChecked: now - 6000, lastError: null, ...extra,
});
const R = (pipeline, number, event, state, at) => ({
  url: `https://buildkite.com/acme/${pipeline}/builds/${number}`,
  org: 'acme', pipeline, number, event, state, at,
});

// Each screenshot shows a different, real state of the popup.
const SCENES = [
  {
    name: 'screenshot-1-watching.png',
    caption: 'Hear when your build finishes',
    subcaption: 'Four distinct chimes — passed, failed, needs input, and now watching.',
    fixture: {
      ...base,
      discoveryState: { provider: 'json', error: null, found: 3, at: now - 9000 },
      watches: {
        [W('web', 1482).url]: W('web', 1482, { source: 'auto', prev: { state: 'running', blocked: false, finished: false } }),
        [W('payments', 307).url]: W('payments', 307, { source: 'manual', lastChecked: now - 11000, prev: { state: 'passed', blocked: true, finished: false } }),
      },
      recent: [R('api', 920, 'success', 'passed', now - 60000)],
    },
  },
  {
    name: 'screenshot-2-history.png',
    caption: 'Never miss which build chimed',
    subcaption: 'The last finished builds stay listed, colour-coded by outcome.',
    fixture: {
      ...base,
      discoveryState: { provider: 'json', error: null, found: 0, at: now - 15000 },
      watches: {},
      recent: [
        R('api', 920, 'success', 'passed', now - 45000),
        R('web', 1481, 'failure', 'failed', now - 420000),
        R('infra', 58, 'input', 'running', now - 3000000),
        R('payments', 306, 'success', 'passed', now - 7200000),
      ],
    },
  },
  {
    name: 'screenshot-3-auto.png',
    caption: 'Builds you trigger watch themselves',
    subcaption: 'No tokens, no login — it uses the Buildkite session your browser already has.',
    fixture: {
      ...base,
      discoveryState: { provider: 'json', error: null, found: 4, watchedThisCycle: 2, at: now - 4000 },
      watches: {
        [W('web', 1482).url]: W('web', 1482, { source: 'auto', prev: { state: 'running', blocked: false, finished: false } }),
        [W('api', 921).url]: W('api', 921, { source: 'auto', lastChecked: now - 9000, prev: { state: 'running', blocked: false, finished: false } }),
        [W('infra', 59).url]: W('infra', 59, { source: 'auto', lastChecked: now - 14000, prev: { state: 'scheduled', blocked: false, finished: false } }),
      },
      recent: [],
    },
  },
];

const ctx = await chromium.launchPersistentContext('', {
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
  channel: process.env.CHROME_PATH ? undefined : 'chrome',
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
});

// The extension really polls during capture. Rather than dress the UI up as
// signed-in, answer its requests with fixture data so the state it renders is
// the state it actually computed.
await ctx.route('https://buildkite.com/**', async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === '/builds.json') {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(LISTING),
    });
  }
  const build = /^\/acme\/([\w-]+)\/builds\/(\d+)\.json$/.exec(url.pathname);
  if (build) {
    const match = LISTING.find((b) => b.path === `/acme/${build[1]}/builds/${build[2]}`);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(match ?? { state: 'started', blocked_state: null, finished_at: null }),
    });
  }
  return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body></body></html>' });
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;

/**
 * Screenshot the popup on its own, then compose that image onto a 1280x800
 * canvas. Compositing an image avoids the popup's own CSS (which sets a fixed
 * body width) leaking into the canvas layout.
 */
async function popupImage(fixture) {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await page.evaluate(async (f) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set(f);
  }, fixture);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 360, height: 900 });
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'POLL_NOW' }));
  await page.reload();
  // Wait for the popup to actually reach the signed-in state rather than
  // screenshotting mid-poll and dressing it up afterwards.
  await page.waitForFunction(
    () => document.getElementById('signed-out')?.hidden === true
      && document.querySelectorAll('#watches li, #recent li').length > 0,
    null,
    { timeout: 15000 },
  );
  await page.waitForTimeout(250);
  // Crop to the rendered height so the shot has no dead space beneath it.
  const height = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
  const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 344, height } });
  await page.close();
  return `data:image/png;base64,${buf.toString('base64')}`;
}

async function shot(name, { caption, subcaption, image }) {
  const canvas = await ctx.newPage();
  await canvas.setViewportSize({ width: 1280, height: 800 });
  await canvas.setContent(`
    <style>
      ${TOKENS}
      * { box-sizing: border-box; }
      body {
        margin: 0; width: 1280px; height: 800px; display: flex; align-items: center;
        justify-content: center; gap: 84px; padding: 0 88px; overflow: hidden;
        background: #06080B;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI",
                     system-ui, ui-sans-serif, Roboto, "Helvetica Neue", Arial, sans-serif;
        color: #fff; -webkit-font-smoothing: antialiased;
      }
      /* An ambient field, so the composition has depth and the glass toolbar in
         the screenshot has something to read against. */
      body::before, body::after {
        content: ""; position: absolute; border-radius: 50%; filter: blur(60px);
      }
      body::before {
        width: 880px; height: 880px; left: -330px; top: -360px; opacity: .40;
        background: radial-gradient(circle closest-side, var(--sys-green) 0%, transparent 100%);
      }
      body::after {
        width: 800px; height: 800px; right: -250px; bottom: -320px; opacity: .34;
        background: radial-gradient(circle closest-side, var(--sys-blue) 0%, transparent 100%);
      }
      .copy { position: relative; max-width: 440px; }
      .badge {
        display: inline-flex; align-items: center; gap: 8px; margin-bottom: 22px;
        padding: 7px 15px 7px 12px; border-radius: 999px;
        background: color-mix(in srgb, white 10%, transparent);
        border: 1px solid color-mix(in srgb, white 16%, transparent);
        font-size: 14px; letter-spacing: -0.006em; font-weight: 560;
      }
      h1 {
        margin: 0 0 16px;
        /* iOS Large Title, with Apple's positive tracking above 23px. */
        font-size: 44px; line-height: 50px; letter-spacing: 0.012em; font-weight: 700;
      }
      p {
        margin: 0; font-size: 19px; line-height: 27px; letter-spacing: -0.023em;
        color: color-mix(in srgb, white 68%, transparent);
      }
      .frame {
        position: relative; border-radius: 18px; overflow: hidden; flex: 0 0 auto;
        box-shadow: 0 50px 100px -20px rgb(0 0 0 / .7), 0 0 0 1px color-mix(in srgb, white 12%, transparent);
      }
      .frame img { display: block; width: 344px; }
    </style>
    <div class="copy">
      <span class="badge">🔔 Build Watcher</span>
      <h1>${caption}</h1>
      <p>${subcaption}</p>
    </div>
    <div class="frame"><img src="${image}"></div>
  `);
  await canvas.emulateMedia({ colorScheme: 'dark' });
  await canvas.waitForTimeout(400);
  await canvas.screenshot({ path: path.join(OUT, name) });
  await canvas.close();
  console.log('wrote store/' + name);
}

for (const scene of SCENES) {
  const image = await popupImage(scene.fixture);
  await shot(scene.name, { caption: scene.caption, subcaption: scene.subcaption, image });
}

// Small promotional tile
const promo = await ctx.newPage();
await promo.setViewportSize({ width: 440, height: 280 });
await promo.setContent(`
  <style>
    ${TOKENS}
    body {
      margin: 0; width: 440px; height: 280px; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 12px; overflow: hidden;
      background: #05070A; color: #fff; text-align: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI",
                   system-ui, ui-sans-serif, Roboto, "Helvetica Neue", Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    body::before {
      content: ""; position: absolute; width: 420px; height: 420px; left: -110px; top: -150px;
      border-radius: 50%; filter: blur(40px); opacity: .6;
      background: radial-gradient(circle closest-side, var(--sys-green) 0%, transparent 100%);
    }
    body::after {
      content: ""; position: absolute; width: 360px; height: 360px; right: -100px; bottom: -140px;
      border-radius: 50%; filter: blur(40px); opacity: .5;
      background: radial-gradient(circle closest-side, var(--sys-blue) 0%, transparent 100%);
    }
    .bell { position: relative; font-size: 54px; line-height: 1; }
    h1 { position: relative; margin: 0; font-size: 30px; letter-spacing: 0.012em; font-weight: 700; }
    p { position: relative; margin: 0; font-size: 15px; letter-spacing: -0.016em;
        color: color-mix(in srgb, white 66%, transparent); }
  </style>
  <div class="bell">🔔</div>
  <h1>Build Watcher</h1>
  <p>A chime when your Buildkite build finishes</p>
`);
await promo.emulateMedia({ colorScheme: 'dark' });
await promo.waitForTimeout(300);
await promo.screenshot({ path: path.join(OUT, 'promo-small.png') });
console.log('wrote store/promo-small.png');

await ctx.close();
