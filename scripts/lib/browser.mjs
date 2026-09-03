// One place that knows how to launch a browser with the extension loaded.
//
// The trap this exists to avoid: Google Chrome 137 removed --load-extension
// from branded builds, and 139 removed --disable-extensions-except. Branded
// Chrome ignores the flags silently — the browser starts, the extension is
// simply absent, and the first symptom is a timeout waiting for a service
// worker that will never appear. Playwright's bundled Chromium (Chrome for
// Testing) still honours the flags, and its `chromium` channel supports
// extensions in headless mode. So that is the default. CHROME_PATH remains an
// override for a Chromium or Chrome for Testing binary kept elsewhere; it must
// never point at Google Chrome.
//
// Playwright is imported lazily so this module can be unit-tested (and its
// failure message asserted) without the package or a browser installed.

import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

export const NO_WORKER_MESSAGE =
  'Extension did not load: no service worker appeared. Branded Google Chrome 137+ ignores '
  + '--load-extension, so this must run on Playwright\'s bundled Chromium '
  + '(npx playwright install chromium) or on a Chromium / Chrome for Testing binary named by '
  + 'CHROME_PATH — never on Google Chrome itself.';

/** Launch options shared by every script: bundled Chromium unless overridden. */
export function launchOptions(extra = {}) {
  const exe = process.env.CHROME_PATH;
  return {
    headless: true,
    ...(exe ? { executablePath: exe } : { channel: 'chromium' }),
    ...extra,
  };
}

/**
 * Resolve the extension's service worker, or fail with an explanation.
 * Kept separate from the launch so it can be tested against a fake context.
 */
export async function waitForServiceWorker(ctx, { timeout = 15000 } = {}) {
  let [sw] = ctx.serviceWorkers();
  if (sw) return sw;
  try {
    sw = await ctx.waitForEvent('serviceworker', { timeout });
  } catch (err) {
    const e = new Error(`${NO_WORKER_MESSAGE}\n(${err?.message ?? err})`);
    e.cause = err;
    throw e;
  }
  return sw;
}

/**
 * A persistent context with the extension loaded, plus its id.
 * @param {{viewport?: {width:number,height:number}, deviceScaleFactor?: number, timeout?: number}} [opts]
 * @returns {Promise<{ctx: import('playwright').BrowserContext, extId: string}>}
 */
export async function launchExtension({ viewport, deviceScaleFactor, timeout } = {}) {
  const { chromium } = await import('playwright');
  const ctx = await chromium.launchPersistentContext('', launchOptions({
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
    ...(viewport ? { viewport } : {}),
    ...(deviceScaleFactor ? { deviceScaleFactor } : {}),
  }));
  const sw = await waitForServiceWorker(ctx, { timeout });
  return { ctx, extId: new URL(sw.url()).host };
}

/** A browser with no extension, for rendering assets. Same channel rules. */
export async function launchPlain(extra = {}) {
  const { chromium } = await import('playwright');
  return chromium.launchPersistentContext('', launchOptions(extra));
}
