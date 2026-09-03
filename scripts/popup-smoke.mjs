// Optional end-to-end smoke test for the popup. Loads the unpacked extension
// in a real Chromium, seeds storage with representative watches and results,
// and asserts the popup renders them and that the chime path works.
//
//   npm i --no-save playwright && npx playwright install chromium
//   node scripts/popup-smoke.mjs [screenshot.png]
//
// CHROME_PATH may point at a Chromium / Chrome for Testing binary instead —
// never Google Chrome, which ignores --load-extension since 137.
//
// Not part of `npm test` (needs a browser); run it when changing popup markup.

import assert from 'node:assert/strict';
import { launchExtension } from './lib/browser.mjs';

const { ctx, extId } = await launchExtension();
console.log('extension id:', extId);

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(`chrome-extension://${extId}/popup.html`);
await page.waitForTimeout(400);

// Seed from inside the extension page (has chrome.* bindings).
await page.evaluate(async (now) => {
  await chrome.storage.local.set({
    volume: 0.6,
    settings: { discovery: true, autoWatchCap: 25 },
    auth: { signedOut: false, at: now },
    discoveryState: { provider: 'json', error: null, found: 3, watchedThisCycle: 1, at: now - 8000 },
    watches: {
      'https://buildkite.com/acme/web/builds/9700': {
        org: 'acme', pipeline: 'web', number: 9700,
        url: 'https://buildkite.com/acme/web/builds/9700',
        prev: { state: 'running', blocked: false, finished: false },
        provider: 'json', source: 'auto', addedAt: now - 20000, lastChecked: now - 5000, lastError: null,
      },
      'https://buildkite.com/acme/service-catalog/builds/3870': {
        org: 'acme', pipeline: 'service-catalog', number: 3870,
        url: 'https://buildkite.com/acme/service-catalog/builds/3870',
        prev: { state: 'running', blocked: false, finished: false, rawState: 'started' },
        provider: 'json', addedAt: now - 300000, lastChecked: now - 12000, lastError: null,
      },
      'https://buildkite.com/acme/document-pipeline/builds/119': {
        org: 'acme', pipeline: 'document-pipeline', number: 119,
        url: 'https://buildkite.com/acme/document-pipeline/builds/119',
        prev: null, provider: null, addedAt: now - 60000, lastChecked: now - 9000,
        lastError: 'all providers failed (json: json: no state field (keys: message,id))',
      },
    },
    recent: [
      { url: 'https://buildkite.com/acme/models-feature-store/builds/812',
        org: 'acme', pipeline: 'models-feature-store', number: 812,
        event: 'success', state: 'passed', at: now - 45000 },
      { url: 'https://buildkite.com/acme/web/builds/9696',
        org: 'acme', pipeline: 'web', number: 9696,
        event: 'failure', state: 'failed', at: now - 400000 },
      { url: 'https://buildkite.com/acme/api/builds/44',
        org: 'acme', pipeline: 'api', number: 44,
        event: 'input', state: 'running', at: now - 3600000 },
      { url: 'https://buildkite.com/acme/odd-one/builds/7',
        org: 'acme', pipeline: 'odd-one', number: 7,
        event: 'failure', state: 'wrapped_up', rawState: 'wrapped_up', unknownFinish: true, at: now - 7200000 },
    ],
  });
}, Date.now());

await page.reload();
await page.waitForTimeout(900);

const dump = await page.evaluate(() => ({
  version: document.getElementById('version')?.textContent,
  discoveryChecked: document.getElementById('discovery')?.getAttribute('aria-checked') === 'true',
  discoveryStatus: document.getElementById('discovery-status')?.textContent,
  noticeHidden: document.getElementById('signed-out')?.hidden,
  noticeVisible: !!document.getElementById('signed-out')?.offsetParent,
  emptyVisible: !!document.getElementById('empty')?.offsetParent,
  chimeButtons: [...document.querySelectorAll('[data-chime]')].map((b) => b.dataset.chime),
  autoTags: [...document.querySelectorAll('#watches li')].map((li) => !!li.querySelector('.tag')),
  glassed: [...document.querySelectorAll('body *')]
    .filter((el) => {
      const bf = getComputedStyle(el).backdropFilter;
      return bf && bf !== 'none';
    })
    .map((el) => el.tagName.toLowerCase() + '.' + (el.className || '')),
  recentHidden: document.getElementById('recent-section').hidden,
  recent: [...document.querySelectorAll('#recent li')].map((li) => ({
    dot: li.querySelector('.dot')?.className,
    name: li.querySelector('.name')?.textContent,
    outcome: li.querySelector('.outcome')?.textContent,
  })),
  watches: [...document.querySelectorAll('#watches li')].map((li) => ({
    name: li.querySelector('.name')?.textContent,
    meta: li.querySelector('.meta')?.textContent,
    isError: li.querySelector('.meta')?.classList.contains('is-error'),
  })),
}));
console.log(JSON.stringify(dump, null, 2));
if (errors.length) { console.error('page errors:', errors); process.exitCode = 1; }
assert(dump.recentHidden === false, 'recent section should be visible');
assert(dump.recent.length === 4, 'expected 4 recent rows');
assert(dump.recent[0].outcome.startsWith('Passed'), 'first recent row should be a pass');
assert(dump.recent[3].outcome.startsWith('Finished as "wrapped_up"'), 'unknown finish should show its raw state');
assert(dump.watches.some((w) => w.isError), 'erroring watch should be flagged');
assert(dump.watches.some((w) => /· running ·/.test(w.meta)),
  'a normally running watch should read plainly, without the raw Buildkite state');
assert(/^Version \d+\.\d+\.\d+$/.test(dump.version), `footer should show the manifest version, got "${dump.version}"`);
assert(dump.discoveryChecked === true, 'discovery toggle should reflect settings');
assert(dump.noticeHidden === true, 'the signed-in fixture must not show the signed-out notice');
assert(dump.noticeVisible === false, 'a [hidden] notice must actually be off-screen, not merely flagged');
assert(dump.emptyVisible === false, 'the empty-state line must stay hidden when watches exist');
assert(/3 running builds found/.test(dump.discoveryStatus), `discovery status should report the count, got "${dump.discoveryStatus}"`);
assert(!/Could not read/.test(dump.discoveryStatus), 'discovery status should not be an error');
assert.deepEqual(dump.chimeButtons, ['success', 'failure', 'input', 'watching'], 'four chime buttons');
assert(dump.autoTags.some(Boolean), 'auto-watched build should carry an "auto" tag');
assert(dump.autoTags.some((t) => !t), 'manual watches should not carry the tag');
assert.deepEqual(dump.glassed, ['header.toolbar'],
  `Liquid Glass belongs to the functional layer only; found it on: ${dump.glassed.join(', ')}`);

await page.setViewportSize({ width: 340, height: 700 });
if (process.argv[2]) await page.screenshot({ path: process.argv[2], fullPage: true });

// Exercise the real chime path end to end.
const chime = await page.evaluate(async () => {
  const r = await chrome.runtime.sendMessage({ type: 'TEST_CHIME', kind: 'success' });
  return r;
});
assert(chime && chime.ok, 'TEST_CHIME should succeed (offscreen audio path)');
for (const kind of ['failure', 'input', 'watching']) {
  const r = await page.evaluate((k) => chrome.runtime.sendMessage({ type: 'TEST_CHIME', kind: k }), kind);
  assert(r && r.ok, `TEST_CHIME ${kind} should succeed`);
}
await page.waitForTimeout(500);
console.log('offscreen docs after chime:', (await ctx.backgroundPages()).length, 'bg,', ctx.serviceWorkers().length, 'sw');

// Clear-recent link works?
await page.click('#clear-recent');
await page.waitForTimeout(600);
const cleared = await page.evaluate(() => document.querySelectorAll('#recent li').length);
assert.equal(cleared, 0, 'clear should empty the recent list');

await ctx.close();
console.log(process.exitCode ? 'popup smoke test FAILED' : 'popup smoke test passed');
