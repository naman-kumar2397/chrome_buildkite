import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, NO_WORKER_MESSAGE, launchOptions, waitForServiceWorker,
} from '../scripts/lib/browser.mjs';

test('ROOT resolves to the repository root', () => {
  assert.ok(existsSync(join(ROOT, 'manifest.json')), `expected manifest.json under ${ROOT}`);
});

test('launchOptions defaults to the bundled chromium channel', () => {
  const saved = process.env.CHROME_PATH;
  delete process.env.CHROME_PATH;
  try {
    const opts = launchOptions({ viewport: { width: 1, height: 1 } });
    assert.equal(opts.channel, 'chromium', 'branded Chrome cannot side-load extensions; bundled Chromium can');
    assert.equal(opts.executablePath, undefined);
    assert.equal(opts.headless, true);
    assert.deepEqual(opts.viewport, { width: 1, height: 1 });
  } finally {
    if (saved !== undefined) process.env.CHROME_PATH = saved;
  }
});

test('launchOptions honours CHROME_PATH as an explicit override', () => {
  const saved = process.env.CHROME_PATH;
  process.env.CHROME_PATH = '/opt/somewhere/chrome';
  try {
    const opts = launchOptions();
    assert.equal(opts.executablePath, '/opt/somewhere/chrome');
    assert.equal(opts.channel, undefined, 'a channel and an executablePath must not both be set');
  } finally {
    if (saved === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = saved;
  }
});

test('waitForServiceWorker returns a worker that is already running', async () => {
  const worker = { url: () => 'chrome-extension://abc/background.js' };
  const ctx = { serviceWorkers: () => [worker], waitForEvent: () => { throw new Error('must not wait'); } };
  assert.equal(await waitForServiceWorker(ctx), worker);
});

test('waitForServiceWorker waits for the event when none is running yet', async () => {
  const worker = { url: () => 'chrome-extension://abc/background.js' };
  const ctx = {
    serviceWorkers: () => [],
    waitForEvent: async (name, { timeout }) => {
      assert.equal(name, 'serviceworker');
      assert.equal(timeout, 15000, 'default timeout');
      return worker;
    },
  };
  assert.equal(await waitForServiceWorker(ctx), worker);
});

test('a timeout becomes an explanation that names the cause and the fix', async () => {
  const timeoutErr = new Error('Timeout 15000ms exceeded while waiting for event "serviceworker"');
  timeoutErr.name = 'TimeoutError';
  const ctx = { serviceWorkers: () => [], waitForEvent: async () => { throw timeoutErr; } };
  await assert.rejects(waitForServiceWorker(ctx), (err) => {
    assert.ok(err.message.startsWith(NO_WORKER_MESSAGE), 'leads with the explanation');
    assert.match(err.message, /Chrome 137/, 'names the cause');
    assert.match(err.message, /npx playwright install chromium/, 'names the fix');
    assert.match(err.message, /CHROME_PATH/, 'names the override');
    assert.match(err.message, /Timeout 15000ms/, 'keeps the original error for debugging');
    assert.equal(err.cause, timeoutErr);
    return true;
  });
});
