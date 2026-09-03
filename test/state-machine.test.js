import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalise, decideEvent, parseBuildUrl, extractStateFromHtml, fetchStatus, describe, pickBuild,
  classifyResponse, resolveCode,
} from '../status.js';

const running = normalise({ state: 'running' });
const blocked = normalise({ state: 'passed', blocked: true });

test('parseBuildUrl accepts build pages and canonicalises them', () => {
  const p = parseBuildUrl('https://buildkite.com/acme/web/builds/123#job-abc?x=1');
  assert.deepEqual(p, { org: 'acme', pipeline: 'web', number: 123, url: 'https://buildkite.com/acme/web/builds/123' });
  assert.equal(parseBuildUrl('https://buildkite.com/acme/web/builds/123/rebuild').url, 'https://buildkite.com/acme/web/builds/123');
});

test('parseBuildUrl rejects non-build pages and other hosts', () => {
  assert.equal(parseBuildUrl('https://buildkite.com/acme/web'), null);
  assert.equal(parseBuildUrl('https://buildkite.com/acme/web/builds'), null);
  assert.equal(parseBuildUrl('https://example.com/acme/web/builds/1'), null);
  assert.equal(parseBuildUrl('not a url'), null);
});

test('normalise derives blocked from the flag and treats blocked as unfinished', () => {
  assert.deepEqual(normalise({ state: 'RUNNING' }), { state: 'running', blocked: false, finished: false });
  assert.deepEqual(normalise({ state: 'passed' }), { state: 'passed', blocked: false, finished: true });
  assert.deepEqual(normalise({ state: 'passed', blocked: true }), { state: 'passed', blocked: true, finished: false });
  assert.deepEqual(normalise({ state: 'blocked' }), { state: 'blocked', blocked: true, finished: false });
  assert.deepEqual(normalise({ state: 'canceling' }), { state: 'canceling', blocked: false, finished: false });
  assert.deepEqual(normalise({}), { state: 'unknown', blocked: false, finished: false });
  assert.deepEqual(normalise(null), { state: 'unknown', blocked: false, finished: false });
});

test('running -> passed is success', () => {
  assert.equal(decideEvent(running, normalise({ state: 'passed' })), 'success');
});

test('running -> failed / canceled are failures', () => {
  assert.equal(decideEvent(running, normalise({ state: 'failed' })), 'failure');
  assert.equal(decideEvent(running, normalise({ state: 'canceled' })), 'failure');
});

test('running -> canceling is not yet an event; canceling -> canceled is', () => {
  const canceling = normalise({ state: 'canceling' });
  assert.equal(decideEvent(running, canceling), null);
  assert.equal(decideEvent(canceling, normalise({ state: 'canceled' })), 'failure');
});

test('running -> failing is not yet an event', () => {
  assert.equal(decideEvent(running, normalise({ state: 'failing' })), null);
});

test('running -> blocked is input, and blocked stays quiet while still blocked', () => {
  assert.equal(decideEvent(running, blocked), 'input');
  assert.equal(decideEvent(blocked, blocked), null);
});

test('blocked -> running (unblocked) is silent, then blocked -> passed/failed chimes', () => {
  assert.equal(decideEvent(blocked, running), null);
  assert.equal(decideEvent(blocked, normalise({ state: 'passed' })), 'success');
  assert.equal(decideEvent(blocked, normalise({ state: 'failed' })), 'failure');
});

test('no baseline: first finished poll still chimes, first running poll does not', () => {
  assert.equal(decideEvent(null, normalise({ state: 'passed' })), 'success');
  assert.equal(decideEvent(null, normalise({ state: 'failed' })), 'failure');
  assert.equal(decideEvent(null, blocked), 'input');
  assert.equal(decideEvent(null, running), null);
});

test('unknown states never chime', () => {
  assert.equal(decideEvent(running, normalise({ state: 'unknown' })), null);
  assert.equal(decideEvent(running, normalise({ state: 'weird' })), null);
});

test('describe labels', () => {
  assert.equal(describe(blocked), 'blocked, waiting for input');
  assert.equal(describe(normalise({ state: 'canceled' })), 'canceled');
  assert.equal(describe(normalise({ state: 'nope' })), 'in an unknown state');
});

test('extractStateFromHtml finds data attributes, embedded JSON, and titles', () => {
  assert.deepEqual(extractStateFromHtml('<div data-build-state="running">'), { state: 'running', blocked: false });
  assert.deepEqual(extractStateFromHtml('<script>{"number":5,"state":"passed","blocked":true}</script>'), { state: 'passed', blocked: true });
  assert.deepEqual(extractStateFromHtml('<title>Failed: web #12</title>'), { state: 'failed', blocked: false });
  assert.equal(extractStateFromHtml('<html><body>hello</body></html>'), null);
  assert.equal(extractStateFromHtml(''), null);
});

function fakeResponse({ ok = true, status = 200, type = 'application/json', body = '', url = 'https://buildkite.com/a/b/builds/1.json', redirected = false }) {
  return {
    ok, status, url, redirected,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : null) },
    json: async () => JSON.parse(body),
    text: async () => body,
  };
}

test('fetchStatus uses the .json endpoint first', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return fakeResponse({ body: '{"state":"running","blocked":false}' }); };
  const s = await fetchStatus({ url: 'https://buildkite.com/a/b/builds/1' }, { fetchImpl });
  assert.deepEqual(s, { state: 'running', blocked: false, finished: false, provider: 'json' });
  assert.deepEqual(calls, ['https://buildkite.com/a/b/builds/1.json']);
});

test('fetchStatus falls back to HTML when JSON is not JSON', async () => {
  const fetchImpl = async (url) => (url.endsWith('.json')
    ? fakeResponse({ type: 'text/html', body: '<html>' })
    : fakeResponse({ type: 'text/html', body: '<title>Passed: b #1</title>' }));
  const s = await fetchStatus({ url: 'https://buildkite.com/a/b/builds/1' }, { fetchImpl });
  assert.equal(s.provider, 'html');
  assert.equal(s.state, 'passed');
  assert.equal(s.finished, true);
});

test('fetchStatus falls back to the DOM probe last, and remembers a preferred provider', async () => {
  const fetchImpl = async () => fakeResponse({ ok: false, status: 404, type: 'text/html', body: '' });
  const domProbe = async () => ({ state: 'blocked', blocked: true });
  const s = await fetchStatus({ url: 'https://buildkite.com/a/b/builds/1' }, { fetchImpl, domProbe });
  assert.deepEqual(s, { state: 'blocked', blocked: true, finished: false, provider: 'dom' });

  const order = [];
  const s2 = await fetchStatus({ url: 'https://buildkite.com/a/b/builds/1', provider: 'dom' }, {
    fetchImpl: async () => { order.push('fetch'); return fakeResponse({ ok: false, status: 500 }); },
    domProbe: async () => { order.push('dom'); return { state: 'running' }; },
  });
  assert.equal(s2.provider, 'dom');
  assert.equal(order[0], 'dom');
});

test('fetchStatus throws with every provider error when all fail', async () => {
  const fetchImpl = async () => { throw new Error('offline'); };
  await assert.rejects(
    fetchStatus({ url: 'https://buildkite.com/a/b/builds/1' }, { fetchImpl }),
    (err) => err.errors.length === 3 && /offline/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Buildkite internal web JSON shape (what GET <build url>.json actually returns)
// ---------------------------------------------------------------------------

const WEB_KEYS = ['id', 'state', 'blocked_state', 'message', 'number', 'max_lifetime_status', 'path', 'json_path',
  'created_at', 'scheduled_at', 'started_at', 'canceled_at', 'finished_at', 'cancel_reason', 'cancel_status',
  'jobs', 'steps', 'statistics'];

function webBuild(overrides) {
  const b = Object.fromEntries(WEB_KEYS.map((k) => [k, null]));
  return { ...b, id: 'abc', number: 3870, jobs: [], steps: [], ...overrides };
}

test('web JSON: started maps to running and is not finished', () => {
  const s = normalise(webBuild({ state: 'started' }));
  assert.equal(s.state, 'running');
  assert.equal(s.rawState, 'started');
  assert.equal(s.finished, false);
  assert.equal(s.blocked, false);
  assert.equal(decideEvent(null, s), null);
});

test('web JSON: passed with finished_at is success', () => {
  const s = normalise(webBuild({ state: 'passed', finished_at: '2026-09-03T03:00:00Z' }));
  assert.deepEqual(s, { state: 'passed', blocked: false, finished: true });
  assert.equal(decideEvent(running, s), 'success');
});

test('web JSON: failed / canceled are failures', () => {
  assert.equal(decideEvent(running, normalise(webBuild({ state: 'failed', finished_at: 'x' }))), 'failure');
  assert.equal(decideEvent(running, normalise(webBuild({ state: 'canceled', finished_at: 'x', canceled_at: 'x' }))), 'failure');
  assert.equal(decideEvent(running, normalise(webBuild({ state: 'cancelled', finished_at: 'x' }))).valueOf(), 'failure');
});

test('web JSON: blocked_state marks the build blocked whatever the state says', () => {
  const b1 = normalise(webBuild({ state: 'started', blocked_state: 'blocked' }));
  assert.equal(b1.blocked, true);
  assert.equal(b1.finished, false);
  assert.equal(decideEvent(running, b1), 'input');

  const b2 = normalise(webBuild({ state: 'passed', blocked_state: 'blocked', finished_at: 'x' }));
  assert.equal(b2.blocked, true);
  assert.equal(b2.finished, false);
  assert.equal(decideEvent(running, b2), 'input');
  assert.equal(decideEvent(b1, b2), null);

  const unblocked = normalise(webBuild({ state: 'started', blocked_state: 'unblocked' }));
  assert.equal(unblocked.blocked, false);
  assert.equal(decideEvent(b1, unblocked), null);
  assert.equal(decideEvent(b1, normalise(webBuild({ state: 'passed', blocked_state: 'unblocked', finished_at: 'x' }))), 'success');
});

test('web JSON: finished with an unknown state chimes failure and says so', () => {
  const s = normalise(webBuild({ state: 'wrapped_up', finished_at: 'x' }));
  assert.equal(s.finished, true);
  assert.equal(s.unknownFinish, true);
  assert.equal(s.rawState, 'wrapped_up');
  assert.equal(decideEvent(running, s), 'failure');
  assert.equal(describe(s), 'finished with state "wrapped_up"');

  const c = normalise(webBuild({ state: 'wrapped_up', finished_at: 'x', cancel_status: 'canceled' }));
  assert.equal(c.state, 'canceled');
  assert.equal(c.unknownFinish, undefined);
  assert.equal(decideEvent(running, c), 'failure');
});

test('web JSON: unknown state without finished_at stays quiet', () => {
  const s = normalise(webBuild({ state: 'something_new' }));
  assert.equal(s.finished, false);
  assert.equal(decideEvent(running, s), null);
});

test('pickBuild accepts any string state and finds nested builds', () => {
  assert.equal(pickBuild(webBuild({ state: 'started' })).state, 'started');
  assert.equal(pickBuild({ build: { state: 'x' } }).state, 'x');
  assert.equal(pickBuild({ data: { build: { state: 'y' } } }).state, 'y');
  assert.equal(pickBuild({ message: 'nope' }), null);
  assert.equal(pickBuild(null), null);
});

test('fetchStatus parses the real web JSON via the json provider', async () => {
  const fetchImpl = async (url) => {
    assert.ok(url.endsWith('.json'));
    return fakeResponse({ body: JSON.stringify(webBuild({ state: 'started' })) });
  };
  const s = await fetchStatus({ url: 'https://buildkite.com/acme/service-catalog/builds/3870' }, { fetchImpl });
  assert.equal(s.provider, 'json');
  assert.equal(s.state, 'running');
  assert.equal(s.finished, false);
});

test('json provider error names the keys it saw when there is no state', async () => {
  const fetchImpl = async (url) => (url.endsWith('.json')
    ? fakeResponse({ body: '{"message":"not found","id":1}' })
    : fakeResponse({ ok: false, status: 404, type: 'text/html' }));
  await assert.rejects(
    fetchStatus({ url: 'https://buildkite.com/a/b/builds/1' }, { fetchImpl }),
    (err) => /json: no state field \(keys: message,id\)/.test(err.message),
  );
});

test('extractStateFromHtml reads the visible header and internal state names', () => {
  assert.deepEqual(extractStateFromHtml('<div><span>Running for 2m 47s</span></div>'), { state: 'running', blocked: false });
  assert.deepEqual(extractStateFromHtml('<h2>Passed in 5m</h2>'), { state: 'passed', blocked: false });
  assert.deepEqual(extractStateFromHtml('<script>{"state":"started","blocked_state":"blocked"}</script>'), { state: 'started', blocked: true });
  assert.equal(normalise(extractStateFromHtml('<script>{"state":"started"}</script>')).state, 'running');
});

test('classifyResponse spots a signed-out session by status or login redirect', () => {
  assert.equal(classifyResponse(fakeResponse({})), 'ok');
  assert.equal(classifyResponse(fakeResponse({ ok: false, status: 401 })), 'auth');
  assert.equal(classifyResponse(fakeResponse({ ok: false, status: 403 })), 'auth');
  assert.equal(classifyResponse(fakeResponse({ url: 'https://buildkite.com/login?return_to=%2Fa' })), 'auth');
  assert.equal(classifyResponse(fakeResponse({ url: 'https://buildkite.com/sso/acme' })), 'auth');
  assert.equal(classifyResponse(fakeResponse({ url: 'https://buildkite.com/', redirected: true })), 'auth');
  assert.equal(classifyResponse(fakeResponse({ url: 'https://buildkite.com/a/b/builds/1', redirected: true })), 'ok',
    'a redirect that lands on a build page is not a login bounce');
  assert.equal(classifyResponse(null), 'error');
});

test('resolveCode lets one real auth answer win over unavailable fallbacks', () => {
  assert.equal(resolveCode([{ code: 'auth' }, { code: 'unavailable' }]), 'auth');
  assert.equal(resolveCode([{ code: 'shape' }, { code: 'shape' }]), 'shape');
  assert.equal(resolveCode([{ code: 'shape' }, { code: 'http' }]), undefined);
  assert.equal(resolveCode([{}, {}]), undefined);
});

test('fetchStatus reports a signed-out session as a single auth error', async () => {
  const fetchImpl = async () => fakeResponse({ ok: false, status: 401, type: 'text/html', body: '' });
  await assert.rejects(
    fetchStatus({ url: 'https://buildkite.com/a/b/builds/1' }, { fetchImpl }),
    (err) => err.code === 'auth' && /not signed in/i.test(err.message),
  );
});

test('fetchStatus still reports a shape problem as a shape problem', async () => {
  const fetchImpl = async () => fakeResponse({ body: '{"message":"hi"}' });
  await assert.rejects(
    fetchStatus({ url: 'https://buildkite.com/a/b/builds/1' }, { fetchImpl }),
    (err) => err.code !== 'auth' && /no state field/.test(err.message),
  );
});
