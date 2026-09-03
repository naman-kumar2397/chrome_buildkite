// Proves the extension does not need the "tabs" permission: a matching host
// permission already covers tabs.query({url}), and sendMessage/create need
// none. Run this before adding any permission back.
//
//   npm i --no-save playwright
//   CHROME_PATH=/path/to/chrome npm run permissions
//
// Not part of `npm test` (needs a browser).

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const ctx = await chromium.launchPersistentContext('', {
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
  channel: process.env.CHROME_PATH ? undefined : 'chrome',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;

await ctx.route('https://buildkite.com/**', (route) => route.fulfill({
  status: 200, contentType: 'text/html',
  body: '<!doctype html><title>Running: web #1482</title><body><div data-build-state="running">Running for 2m</div></body>',
}));

const build = await ctx.newPage();
await build.goto('https://buildkite.com/acme/web/builds/1482');
await build.waitForTimeout(1500);

// Drive the checks from an extension page, which shares the extension's permissions.
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/popup.html`);

const query = await page.evaluate(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://buildkite.com/*' });
  return { count: tabs.length, url: tabs[0]?.url ?? null, id: typeof tabs[0]?.id };
});
console.log('tabs.query ->', JSON.stringify(query));
assert(query.count >= 1, 'tabs.query must still find the build tab (host permission grants this)');
assert(query.url?.includes('/builds/1482'), 'the matched tab url must be readable');

// The DOM fallback: background messages the content script in that tab.
const dom = await page.evaluate(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://buildkite.com/*' });
  return chrome.tabs.sendMessage(tabs[0].id, { type: 'DOM_STATUS' });
});
console.log('DOM_STATUS ->', JSON.stringify(dom));
assert(dom?.state === 'running', `content script should report running, got ${JSON.stringify(dom)}`);

const list = await page.evaluate(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://buildkite.com/*' });
  return chrome.tabs.sendMessage(tabs[0].id, { type: 'DOM_BUILD_LIST' });
});
console.log('DOM_BUILD_LIST ->', (list?.builds ?? []).length, 'builds');

// Notification click handler path: tabs.create needs no permission.
const created = await page.evaluate(async () => {
  const t = await chrome.tabs.create({ url: 'https://buildkite.com/acme/web/builds/1482' });
  await chrome.tabs.remove(t.id);
  return true;
});
assert(created, 'tabs.create must still work');
console.log('tabs.create -> ok');

const perms = await page.evaluate(() => chrome.runtime.getManifest().permissions);
assert(!perms.includes('tabs'), 'manifest must not declare tabs');
console.log('manifest permissions ->', perms.join(', '));
console.log('PASS: the tabs permission is not needed');
await ctx.close();
