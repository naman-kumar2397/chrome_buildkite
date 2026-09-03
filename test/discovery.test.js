import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickList, parseBuildList, extractBuildsFromHtml, isActive, diffDiscovered, fetchBuildList,
} from '../discovery.js';

const U = (n, p = 'web') => `https://buildkite.com/acme/${p}/builds/${n}`;

test('pickList handles bare arrays and common wrappers', () => {
  assert.deepEqual(pickList([1, 2]), [1, 2]);
  assert.deepEqual(pickList({ builds: [1] }), [1]);
  assert.deepEqual(pickList({ data: [2] }), [2]);
  assert.deepEqual(pickList({ results: [3] }), [3]);
  assert.deepEqual(pickList({ data: { builds: [4] } }), [4]);
  assert.equal(pickList({ nope: 1 }), null);
  assert.equal(pickList(null), null);
});

test('parseBuildList reads builds identified by path', () => {
  const out = parseBuildList([{ path: '/acme/web/builds/12', state: 'started' }]);
  assert.equal(out.length, 1);
  assert.deepEqual(
    { url: out[0].url, state: out[0].state, finished: out[0].finished },
    { url: U(12), state: 'running', finished: false },
  );
});

test('parseBuildList assembles builds from account/project/number', () => {
  const out = parseBuildList({
    builds: [{ account: { slug: 'acme' }, project: { slug: 'api' }, number: 4, state: 'passed' }],
  });
  assert.equal(out[0].url, U(4, 'api'));
  assert.equal(out[0].finished, true);
});

test('parseBuildList accepts absolute urls and string org/pipeline', () => {
  const out = parseBuildList([
    { url: 'https://buildkite.com/acme/web/builds/7', state: 'running' },
    { organization: 'acme', pipeline: 'jobs', number: 9, state: 'scheduled' },
  ]);
  assert.deepEqual(out.map((b) => b.url), [U(7), U(9, 'jobs')]);
});

test('parseBuildList carries blocked through and dedupes', () => {
  const out = parseBuildList([
    { path: '/acme/web/builds/5', state: 'passed', blocked_state: 'blocked' },
    { path: '/acme/web/builds/5', state: 'passed' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].blocked, true);
  assert.equal(out[0].finished, false, 'a blocked build is not finished');
});

test('parseBuildList skips junk entries and returns null for a non-list', () => {
  assert.deepEqual(parseBuildList([null, 'x', {}, { number: 3 }]), []);
  assert.equal(parseBuildList({ foo: 1 }), null);
});

test('extractBuildsFromHtml finds build links and nearby state', () => {
  const html = `
    <li class="build build--running"><a href="/acme/web/builds/12">web</a> Running for 2m</li>
    <li class="build"><a href="/acme/api/builds/4">api</a> Passed in 5m</li>
    <li><a href="/acme/web/builds/12">dupe</a></li>
    <a href="/acme/web">not a build</a>`;
  const out = extractBuildsFromHtml(html);
  assert.deepEqual(out.map((b) => b.url), [U(12), U(4, 'api')]);
  assert.equal(out[0].state, 'running');
  assert.equal(out[1].state, 'passed');
  assert.equal(extractBuildsFromHtml('<p>nothing</p>'), null);
});

test('isActive treats unfinished builds as watchable', () => {
  assert.equal(isActive({ finished: false }), true);
  assert.equal(isActive({ finished: true }), false);
  assert.equal(isActive(null), false);
});

const running = (n, p) => ({ url: U(n, p), finished: false, state: 'running' });
const done = (n) => ({ url: U(n), finished: true, state: 'passed' });

test('diffDiscovered watches new active builds only', () => {
  const { toWatch } = diffDiscovered([running(1), done(2)]);
  assert.deepEqual(toWatch.map((b) => b.url), [U(1)]);
});

test('diffDiscovered suppresses baseline, already-watched and dismissed builds', () => {
  const builds = [running(1), running(2), running(3), running(4)];
  const { toWatch } = diffDiscovered(builds, {
    baseline: [U(1)], watched: [U(2)], dismissed: [U(3)],
  });
  assert.deepEqual(toWatch.map((b) => b.url), [U(4)]);
});

test('diffDiscovered prunes baseline entries that left the listing', () => {
  const { baseline } = diffDiscovered([running(1)], { baseline: [U(1), U(99)] });
  assert.deepEqual(baseline, [U(1)], 'build 99 is gone, so it should not stay suppressed');
});

test('diffDiscovered respects the cap', () => {
  const builds = [running(1), running(2), running(3)];
  assert.equal(diffDiscovered(builds, { cap: 2 }).toWatch.length, 2);
  assert.equal(diffDiscovered(builds, { cap: 0 }).toWatch.length, 0);
});

test('diffDiscovered reports how many builds are active', () => {
  assert.equal(diffDiscovered([running(1), done(2), running(3)]).activeCount, 2);
  assert.equal(diffDiscovered([]).activeCount, 0);
  assert.equal(diffDiscovered(null).activeCount, 0);
});

function res({ ok = true, status = 200, type = 'application/json', body = '', url = 'https://buildkite.com/builds.json', redirected = false }) {
  return {
    ok, status, url, redirected,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : null) },
    json: async () => JSON.parse(body),
    text: async () => body,
  };
}

test('fetchBuildList uses the first listing endpoint that returns builds', async () => {
  const tried = [];
  const fetchImpl = async (url) => {
    tried.push(new URL(url).pathname + new URL(url).search);
    return url.includes('filter=mine')
      ? res({ body: '{"builds":[{"path":"/acme/web/builds/12","state":"started"}]}' })
      : res({ body: '{"builds":[]}' });
  };
  const { builds, provider } = await fetchBuildList({ fetchImpl });
  assert.equal(provider, 'json');
  assert.deepEqual(builds.map((b) => b.url), [U(12)]);
  assert.equal(tried[0], '/builds.json');
  assert.ok(tried.includes('/builds.json?filter=mine'));
});

test('fetchBuildList falls back to HTML, then to an open tab', async () => {
  const htmlOnly = async (url) => (url.endsWith('/builds')
    ? res({ type: 'text/html', body: '<a href="/acme/web/builds/3">x</a> Running for 1m' })
    : res({ ok: false, status: 404 }));
  const a = await fetchBuildList({ fetchImpl: htmlOnly });
  assert.equal(a.provider, 'html');
  assert.deepEqual(a.builds.map((b) => b.url), [U(3)]);

  const b = await fetchBuildList({
    fetchImpl: async () => res({ ok: false, status: 500 }),
    listProbe: async () => [{ url: U(8), state: 'running', finished: false }],
  });
  assert.equal(b.provider, 'tab');
});

test('fetchBuildList throws listing every provider failure', async () => {
  await assert.rejects(
    fetchBuildList({ fetchImpl: async () => { throw new Error('offline'); } }),
    (err) => err.errors.length === 3 && /offline/.test(err.message),
  );
});

test('fetchBuildList reports a signed-out session as an auth error, not a shape error', async () => {
  const fetchImpl = async () => res({ ok: false, status: 302, type: 'text/html', url: 'https://buildkite.com/login' });
  await assert.rejects(
    fetchBuildList({ fetchImpl }),
    (err) => err.code === 'auth' && /not signed in/i.test(err.message),
  );
});

test('fetchBuildList stops trying other paths once one says not signed in', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return res({ ok: false, status: 401 }); };
  await assert.rejects(fetchBuildList({ fetchImpl }), (err) => err.code === 'auth');
  assert.equal(calls, 2, 'one json attempt plus the html provider, not every candidate path');
});
