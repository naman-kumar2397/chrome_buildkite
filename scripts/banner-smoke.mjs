// Checks the in-page banner on a build that has already failed: it appears at
// all (a finished build used to be dropped), it offers to copy the reason, and
// pressing it puts a report on the real clipboard.
//
//   npm i --no-save playwright && npx playwright install chromium
//   npm run banner
//
// CHROME_PATH may point at a Chromium / Chrome for Testing binary instead —
// never Google Chrome, which ignores --load-extension since 137.
//
// Not part of `npm test` (needs a browser).

import assert from 'node:assert/strict';
import { launchExtension } from './lib/browser.mjs';

const { ctx } = await launchExtension();

const FAILED = 'https://buildkite.com/acme/web/builds/9696';
const PASSED = 'https://buildkite.com/acme/web/builds/9697';

const page = (state, extra = '') => '<!doctype html>'
  + `<title>${state}: web</title><body style="background:#111">`
  + `<div data-build-state="${state.toLowerCase()}">${state} after 2m 3s</div>${extra}</body>`;

// One handler for every buildkite.com request, page and service worker alike.
await ctx.route('https://buildkite.com/**', (route) => {
  const url = route.request().url();
  if (url.startsWith(`${FAILED}/jobs/`)) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        content: 'bundle install ok\n--- :rspec: RSpec\nFailures:\n'
          + '  1) Widget#total sums the line items\n'
          + '     Failure/Error: expect(widget.total).to eq(42)\n'
          + '       expected: 42\n            got: 41\n',
      }),
    });
  }
  if (url === `${FAILED}.json`) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        state: 'failed',
        jobs: [{ id: 'job-1', name: 'RSpec', state: 'failed', exit_status: 1 }],
      }),
    });
  }
  if (url === `${PASSED}.json`) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"state":"passed"}' });
  }
  return route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: page(url.startsWith(PASSED) ? 'Passed' : 'Failed'),
  });
});

await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://buildkite.com' });

// ---------------------------------------------------------------------------
// A build that already failed
// ---------------------------------------------------------------------------

const failed = await ctx.newPage();
const errors = [];
failed.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
await failed.goto(FAILED);

const action = failed.locator('#bk-build-watcher-banner .action');
await action.waitFor({ state: 'visible', timeout: 10000 });
assert.equal(await action.textContent(), 'Copy reason',
  'a failed build should offer its reason, not "Watch this build"');
console.log('banner action ->', await action.textContent());
console.log('banner text   ->', (await failed.locator('#bk-build-watcher-banner .text').textContent()).trim());

await action.click();
await failed.waitForFunction(
  () => !/Reading/.test(document.getElementById('bk-build-watcher-banner')
    ?.shadowRoot?.querySelector('.action')?.textContent ?? ''),
  null, { timeout: 15000 },
);

const label = await action.textContent();
console.log('after click   ->', label);
assert.equal(label, 'Copied', `the copy should succeed, button read "${label}"`);

const clipboard = await failed.evaluate(() => navigator.clipboard.readText());
console.log('clipboard     ->', JSON.stringify(clipboard));
assert.equal(clipboard.split('\n')[0], `Build web #9696 failed — ${FAILED}`,
  'the report must lead with the build and its link');

// The service worker's fetches may or may not be interceptable depending on the
// Playwright build, so the reason is reported rather than required — the line
// above is the part that must always hold.
if (clipboard.includes('expected: 42')) {
  assert(clipboard.includes('Failed step: RSpec (exit 1)'), 'the failed step should be named');
  assert(!clipboard.includes('bundle install ok'), 'output before the failure is not the reason');
  console.log('reason        -> read from the job log, and it picked the right passage');
} else {
  console.log('reason        -> not reached (service-worker fetches were not intercepted); link-only path checked');
}

// ---------------------------------------------------------------------------
// A build that passed has nothing to offer
// ---------------------------------------------------------------------------

const passed = await ctx.newPage();
await passed.goto(PASSED);
await passed.waitForTimeout(2500);
const onPassed = await passed.locator('#bk-build-watcher-banner').count();
assert.equal(onPassed, 0, 'a finished, passing build should not raise a banner');
console.log('passed build  -> no banner, as before');

if (errors.length) { console.error('page errors:', errors); process.exitCode = 1; }
await ctx.close();
console.log(process.exitCode ? 'banner smoke test FAILED' : 'banner smoke test passed');
