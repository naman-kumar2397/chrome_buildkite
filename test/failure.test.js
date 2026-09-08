import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  stripAnsi, logLines, scoreLine, summariseLog, htmlToText, isFailedJob, jobLabel,
  pickFailedJobs, formatReport, jobLogUrls, extractLogText, extractAnnotations, buildFailureReport,
  redactSecrets, pickSteps, flattenSteps, stepsUrls, annotationCount, jobIdOf,
} from '../failure.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

// A Buildkite log line as it actually arrives: an APC timestamp, then colour.
const stamped = (t) => `${ESC}_bk;t=1699999999999${BEL}${t}`;

test('stripAnsi removes colour, cursor moves and Buildkite timestamps', () => {
  assert.equal(stripAnsi(stamped(`${ESC}[31mFAILED${ESC}[0m`)), 'FAILED');
  assert.equal(stripAnsi(`${ESC}[2K${ESC}[1G done`), ' done');
  assert.equal(stripAnsi('plain'), 'plain');
  assert.equal(stripAnsi(null), '');
});

test('logLines collapses overwritten progress lines and immediate repeats', () => {
  const log = ['10%\r55%\r100%', 'same', 'same', '', '   ', 'end'].join('\n');
  assert.deepEqual(logLines(log), ['100%', 'same', 'end']);
});

test('scoreLine ranks a real error above a passing mention of the word', () => {
  assert.ok(scoreLine('Error: connect ECONNREFUSED 127.0.0.1:5432') > scoreLine('Running error-handling specs'));
  assert.ok(scoreLine('npm ERR! code ELIFECYCLE') > scoreLine('warning: 1 error in a comment'));
  // "0 failures" is the summary of a passing run, not a cause.
  assert.ok(scoreLine('12 examples, 0 failures') < 0);
  // A stack frame is continuation, never the anchor.
  assert.ok(scoreLine('AssertionError: expected 41 to eq 42') > scoreLine('    at Object.<anonymous> (spec.js:3:9)'));
});

test('summariseLog anchors on the failure, keeps one line of lead-in, and stops at the next section', () => {
  const log = [
    '--- :ruby: RSpec',
    stamped('Randomized with seed 41234'),
    stamped('...........F'),
    stamped(''),
    stamped('Failures:'),
    stamped('  1) Widget#total sums the line items'),
    stamped('     Failure/Error: expect(widget.total).to eq(42)'),
    stamped('       expected: 42'),
    stamped('            got: 41'),
    '--- :arrow_up: Uploading artifacts',
    stamped('Uploaded 3 files'),
  ].join('\n');

  const out = summariseLog(log);
  assert.ok(out.anchored);
  assert.ok(out.lines.includes('Failures:'), out.lines.join('\n'));
  assert.ok(out.lines.some((l) => l.includes('expected: 42')));
  // The artifact-upload section after the failure is not part of the reason.
  assert.ok(!out.lines.some((l) => l.includes('Uploaded 3 files')), out.lines.join('\n'));
});

test('summariseLog prefers the real error over an earlier passing suite', () => {
  const log = [
    '20 examples, 0 failures',
    'Running the integration suite',
    'Error: connect ECONNREFUSED 127.0.0.1:5432',
    '  at Socket.emit (node:events:518:28)',
  ].join('\n');
  const out = summariseLog(log);
  assert.ok(out.lines[0].includes('Error: connect ECONNREFUSED')
    || out.lines[1]?.includes('Error: connect ECONNREFUSED'), out.lines.join('\n'));
  assert.ok(!out.lines.some((l) => l.includes('0 failures')), out.lines.join('\n'));
});

test('summariseLog falls back to the tail when nothing scores, and reports truncation', () => {
  const log = Array.from({ length: 50 }, (_, i) => `step ${i}`).join('\n');
  const out = summariseLog(log, { maxLines: 4 });
  assert.equal(out.anchored, false);
  assert.deepEqual(out.lines, ['step 46', 'step 47', 'step 48', 'step 49']);
});

test('summariseLog caps its own size', () => {
  const log = `Error: boom\n${'x'.repeat(5000)}`;
  const out = summariseLog(log, { maxChars: 120 });
  assert.ok(out.truncated);
  assert.ok(out.lines.join('\n').length <= 220); // one line, itself clamped to 200
});

test('summariseLog gives nothing back for an empty log', () => {
  assert.equal(summariseLog(''), null);
  assert.equal(summariseLog(`${ESC}[0m\n\n`), null);
});

// ---------------------------------------------------------------------------
// Redaction. This button puts a build log into a Slack message, so a pipeline
// that exports credentials next to the failure must not leak them.
// ---------------------------------------------------------------------------

test('redactSecrets removes assignments whose name gives them away', () => {
  assert.equal(redactSecrets('export FALCON_CLIENT_SECRET=EXAMPLEsecretEXAMPLE00; \\'),
    'export FALCON_CLIENT_SECRET=‹redacted›; \\');
  assert.equal(redactSecrets('API_TOKEN=short'), 'API_TOKEN=‹redacted›');
  assert.equal(redactSecrets('DB_PASSWORD="hunter2"'), 'DB_PASSWORD=‹redacted›');
});

test('redactSecrets removes a value too opaque to be anything but a key', () => {
  // The name says nothing, so the value has to.
  assert.equal(redactSecrets('FALCON_CID=EXAMPLECIDEXAMPLECIDEXAMPLECID00-43'), 'FALCON_CID=‹redacted›');
});

test('redactSecrets knows the token shapes on sight', () => {
  assert.equal(redactSecrets('key AKIAIOSFODNN7EXAMPLE here'), 'key ‹redacted› here');
  assert.equal(redactSecrets('git clone https://user:pw@github.com/x/y'),
    'git clone https://‹redacted›@github.com/x/y');
  assert.equal(redactSecrets('Authorization: Bearer abcdefghijklmnop'), 'Authorization: ‹redacted›');
  assert.equal(redactSecrets('-----BEGIN RSA PRIVATE KEY-----'), '‹redacted›');
});

test('redactSecrets leaves the error message intact', () => {
  // Every one of these would gut the report if it went.
  const keep = [
    'WARNING! Using --password via the CLI is insecure. Use --password-stdin.',
    'export SENSOR_TYPE=falcon-container; \\',
    '  --parameter-overrides RepositoryName=falcon-sensor',
    '--role-arn arn:aws:iam::000000000000:role/cfn-deploy-role',
    'Error: table "widgets" does not exist',
  ];
  for (const line of keep) assert.equal(redactSecrets(line), line, line);
});

test('an excerpt is redacted on the way out', () => {
  const out = summariseLog('Error: boom\nexport API_SECRET=EXAMPLEsecretEXAMPLEsecret00');
  assert.ok(out.lines.join('\n').includes('API_SECRET=‹redacted›'));
  assert.ok(!out.lines.join('\n').includes('EXAMPLEsecret'));
});

// ---------------------------------------------------------------------------
// A real failing build, reduced to its shape (credentials replaced).
// ---------------------------------------------------------------------------

test('a real log: the cause anchors, the exit-status wrappers do not', () => {
  const out = summariseLog(readFileSync(new URL('fixtures/ecr-falcon.log', import.meta.url), 'utf8'));
  const text = out.lines.join('\n');

  // The cause, not the three lines below it that only say something exited.
  assert.ok(text.includes('Fatal error: Pulling multi-arch images locally is not supported.'), text);
  assert.ok(text.includes('- Pull a specific platform'), 'the remedy the tool printed is part of the reason');

  // Those wrappers are last in the log, so they win on recency unless demoted —
  // they belong in the excerpt, under the cause, never as its anchor.
  assert.ok(text.includes('The command exited with status 2'), text);

  // Nothing from the credential block, which sits a few lines above the anchor.
  assert.ok(!/EXAMPLEsecret|EXAMPLEclientid|EXAMPLECID/.test(text), 'credentials must not reach the clipboard');

  // And none of the noise above it.
  assert.ok(!text.includes('Login Succeeded'), text);
  assert.ok(!text.includes('WARNING! Using --password'), text);
});

test('htmlToText flattens an annotation, entities and all', () => {
  assert.equal(
    htmlToText('<p>Build failed:</p><ul><li>spec &amp; feature</li><li>lint</li></ul>'),
    'Build failed:\n• spec & feature\n• lint',
  );
  assert.equal(htmlToText('<style>p{color:red}</style><p>only this</p>'), 'only this');
});

test('isFailedJob reads exit status and state, and forgives a soft failure', () => {
  assert.equal(isFailedJob({ state: 'passed', exit_status: 1 }), true);
  assert.equal(isFailedJob({ state: 'failed' }), true);
  assert.equal(isFailedJob({ state: 'broken', exit_status: null }), true);
  assert.equal(isFailedJob({ state: 'passed', exit_status: 0 }), false);
  assert.equal(isFailedJob({ state: 'failed', exit_status: 1, soft_failed: true }), false);
  assert.equal(isFailedJob({ type: 'waiter' }), false);
  assert.equal(isFailedJob(null), false);
});

test('jobLabel copes with every name a payload might use', () => {
  assert.equal(jobLabel({ name: ':rspec: RSpec' }), ':rspec: RSpec');
  assert.equal(jobLabel({ command: 'make test\nmake lint' }), 'make test');
  assert.equal(jobLabel({}), 'a step');
  assert.equal(jobLabel({ name: 'x'.repeat(200) }).length, 80);
});

test('pickFailedJobs finds the failures wherever the jobs array lives', () => {
  const jobs = [{ state: 'passed' }, { state: 'failed', name: 'RSpec' }];
  assert.deepEqual(pickFailedJobs({ jobs }).map((j) => j.name), ['RSpec']);
  assert.deepEqual(pickFailedJobs({ steps: jobs }).map((j) => j.name), ['RSpec']);
  assert.deepEqual(pickFailedJobs({}), []);
  assert.deepEqual(pickFailedJobs(null), []);
});

test('pickSteps finds the array wherever the steps endpoint puts it', () => {
  assert.deepEqual(pickSteps([{ a: 1 }]), [{ a: 1 }]);
  assert.deepEqual(pickSteps({ steps: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(pickSteps({ data: { steps: [{ a: 1 }] } }), [{ a: 1 }]);
  assert.equal(pickSteps({ message: 'no' }), null);
});

test('flattenSteps unwraps a group step to the jobs inside it', () => {
  const steps = [{ name: 'group', jobs: [{ name: 'a' }, { name: 'b' }] }, { name: 'plain' }];
  assert.deepEqual(flattenSteps(steps).map((j) => j.name), ['a', 'b', 'plain']);
  assert.deepEqual(flattenSteps([{ name: 'empty group', jobs: [] }]).map((j) => j.name), ['empty group']);
  assert.deepEqual(flattenSteps(null), []);
});

test('stepsUrls follows the path the build payload names, then the conventional one', () => {
  const urls = stepsUrls('https://buildkite.com/acme/web/builds/12',
    { build_data_base_path: '/acme/web/builds/12/data' });
  assert.equal(urls[0], 'https://buildkite.com/acme/web/builds/12/data/steps?exclude_group_steps=true&state=failed');
  assert.ok(urls.includes('https://buildkite.com/acme/web/builds/12/data/steps'), 'unfiltered fallback');
  assert.equal(new Set(urls).size, urls.length, 'no duplicates when both bases agree');
});

test('formatReport leads with the build and its link', () => {
  const text = formatReport({
    pipeline: 'web', number: 9696, url: 'https://buildkite.com/acme/web/builds/9696',
    jobs: [{ name: 'RSpec', exit_status: 1 }],
    reason: { lines: ['Error: boom'], truncated: false },
  });
  assert.equal(text.split('\n')[0], 'Build web #9696 failed — https://buildkite.com/acme/web/builds/9696');
  assert.ok(text.includes('Failed step: RSpec (exit 1)'));
  assert.ok(text.includes('```\nError: boom\n```'));
});

test('formatReport still says something useful with no reason and no jobs', () => {
  const text = formatReport({ pipeline: 'web', number: 12, url: 'https://buildkite.com/acme/web/builds/12' });
  assert.equal(text, 'Build web #12 failed — https://buildkite.com/acme/web/builds/12');
});

test('formatReport tells the truth about a build that was canceled, not failed', () => {
  const text = formatReport({ pipeline: 'web', number: 12, url: 'u', state: 'canceled' });
  assert.ok(text.startsWith('Build web #12 was canceled'));
});

test('formatReport names several failed steps and counts the rest', () => {
  const jobs = ['a', 'b', 'c', 'd'].map((name) => ({ name, state: 'failed' }));
  assert.ok(formatReport({ pipeline: 'p', number: 1, url: 'u', jobs })
    .includes('Failed steps: a, b, c, +1 more'));
});

test('jobIdOf prefers the job the step ran over the step itself', () => {
  // A log URL built from the step's own uuid 404s; the job is named in the
  // step's statistics.
  assert.equal(jobIdOf({ uuid: 'step-uuid', statistics: { latest_job_id: 'job-uuid' } }), 'job-uuid');
  assert.equal(jobIdOf({ uuid: 'only-uuid' }), 'only-uuid');
  assert.equal(jobIdOf({ id: 'an-id' }), 'an-id');
  assert.equal(jobIdOf({}), null);
});

test('pickSteps reads the records key the jobs endpoint uses', () => {
  assert.deepEqual(pickSteps({ records: [{ a: 1 }], has_next_page: false }), [{ a: 1 }]);
});

test('jobLogUrls prefers what the job says over the assembled guesses', () => {
  const urls = jobLogUrls('https://buildkite.com/acme/web/builds/9', {
    id: 'job-uuid', base_path: '/acme/web/builds/9/jobs/job-uuid',
  });
  assert.equal(urls[0], 'https://buildkite.com/acme/web/builds/9/jobs/job-uuid/log');
  assert.ok(urls.includes('https://buildkite.com/acme/web/builds/9/jobs/job-uuid/raw_log'));
  assert.equal(new Set(urls).size, urls.length, 'no duplicates');
  assert.deepEqual(jobLogUrls('https://buildkite.com/a/b/builds/1', {}), []);
});

test('extractLogText reads plain text, JSON wrappers and chunk arrays — but not an HTML page', () => {
  assert.equal(extractLogText('raw log text'), 'raw log text');
  assert.equal(extractLogText('{"content":"from json"}'), 'from json');
  assert.equal(extractLogText('[{"content":"a"},{"content":"b"}]'), 'ab');
  assert.equal(extractLogText('<!doctype html><html>login</html>'), null);
  assert.equal(extractLogText('{"message":"nope"}'), null);
  assert.equal(extractLogText(''), null);
});

test('annotationCount reads the build payload rather than guessing', () => {
  assert.equal(annotationCount({ annotation_counts_by_style: { error: 2, info: 1 } }), 3);
  assert.equal(annotationCount({ annotation_counts_by_style: {} }), null);
  assert.equal(annotationCount({}), null, 'no opinion is not the same as none');
  assert.equal(annotationCount({ annotation_counts_by_style: { error: 0 } }), 0);
});

test('a build reporting no annotations does not go hunting for them', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    const body = url.endsWith('.json')
      ? JSON.stringify({ state: 'failed', annotation_counts_by_style: {}, jobs: [{ state: 'failed', id: 'j1' }] })
      : 'Error: boom';
    return { ok: true, status: 200, url, headers: new Map(), text: async () => body };
  };
  // An empty counts object says nothing, so the hunt still runs.
  await buildFailureReport(watch, { fetchImpl });
  assert.ok(seen.some((u) => u.includes('/annotations')), 'no opinion means still look');

  seen.length = 0;
  const withZero = async (url) => {
    seen.push(url);
    const body = url.endsWith('.json')
      ? JSON.stringify({
        state: 'failed',
        annotation_counts_by_style: { error: 0 },
        jobs: [{ state: 'failed', id: 'j1' }],
      })
      : 'Error: boom';
    return { ok: true, status: 200, url, headers: new Map(), text: async () => body };
  };
  const { source } = await buildFailureReport(watch, { fetchImpl: withZero });
  assert.ok(!seen.some((u) => u.includes('/annotations')), `a stated zero saves the requests: ${seen}`);
  assert.equal(source, 'log', 'and it goes straight to the log');
});

test('extractAnnotations puts the error style first', () => {
  const got = extractAnnotations({
    annotations: [
      { style: 'info', body_html: '<p>built at 09:00</p>' },
      { style: 'error', body_html: '<p>3 specs failed</p>' },
    ],
  });
  assert.deepEqual(got.map((a) => a.text), ['3 specs failed', 'built at 09:00']);
  assert.equal(extractAnnotations({ annotations: [] }), null);
  assert.equal(extractAnnotations({}), null);
});

// ---------------------------------------------------------------------------
// The whole path, with fetch stubbed
// ---------------------------------------------------------------------------

function stubFetch(routes) {
  return async (url) => {
    const hit = Object.keys(routes).find((k) => url.includes(k));
    if (!hit) return { ok: false, status: 404, url, headers: new Map() };
    const r = routes[hit];
    return { ok: true, status: 200, url, headers: new Map(), text: async () => r };
  };
}

const watch = { pipeline: 'web', number: 9696, url: 'https://buildkite.com/acme/web/builds/9696' };

test('buildFailureReport reads the failed job log', async () => {
  const fetchImpl = stubFetch({
    '/builds/9696.json': JSON.stringify({
      state: 'failed',
      jobs: [{ name: 'RSpec', state: 'failed', exit_status: 1, id: 'j1' }],
    }),
    '/jobs/j1/log': JSON.stringify({ content: 'setup ok\nError: table "widgets" does not exist\n' }),
  });
  const { report, source, error } = await buildFailureReport(watch, { fetchImpl });
  assert.equal(error, undefined);
  assert.equal(source, 'log');
  assert.ok(report.includes('Failed step: RSpec (exit 1)'));
  assert.ok(report.includes('Error: table "widgets" does not exist'));
});

test('buildFailureReport asks the steps endpoint when the build payload has no jobs', async () => {
  const fetchImpl = stubFetch({
    // What a modern build page actually returns: the keys are there, empty.
    '/builds/9696.json': JSON.stringify({
      state: 'failed', jobs: [], steps: [],
      build_data_base_path: '/acme/web/builds/9696/data',
    }),
    '/data/steps': JSON.stringify({
      steps: [{ name: 'Build image', state: 'failed', exit_status: 2, id: 'j9' }],
    }),
    '/jobs/j9/log': 'Fatal error: Pulling multi-arch images locally is not supported.\n'
      + 'make: *** [Makefile:9: download-falcon-image] Error 1\n',
  });
  const { report, source, error } = await buildFailureReport(watch, { fetchImpl });
  assert.equal(error, undefined);
  assert.equal(source, 'log');
  assert.ok(report.includes('Failed step: Build image (exit 2)'), report);
  assert.ok(report.includes('Fatal error: Pulling multi-arch images'), report);
});

test('isFailedJob reads the outcome field when there is no exit status', () => {
  // What the build page's steps endpoint actually returns: finished, no exit.
  assert.equal(isFailedJob({ state: 'finished', outcome: 'hard_failed' }), true);
  assert.equal(isFailedJob({ state: 'finished', outcome: 'errored' }), true);
  assert.equal(isFailedJob({ state: 'finished', outcome: 'soft_failed' }), false);
  assert.equal(isFailedJob({ state: 'finished', outcome: 'passed' }), false);
  // "finished" on its own is not a verdict either way.
  assert.equal(isFailedJob({ state: 'finished' }), false);
});

test('a step endpoint asked for failures is trusted over our own classifier', async () => {
  // The real payload has no exit_status and an outcome we may not recognise,
  // but the URL asked for state=failed and Buildkite answered.
  const fetchImpl = stubFetch({
    '/builds/9696.json': JSON.stringify({
      state: 'failed', jobs: [], build_data_base_path: '/acme/web/builds/9696/data',
    }),
    'steps?exclude_group_steps=true&state=failed': JSON.stringify([{
      label: 'Download falcon image', state: 'finished', outcome: 'some_future_verdict',
      uuid: '01a07ec8-fc1a-477b-a004-2e7576d3de0d',
    }]),
    '/jobs/01a07ec8-fc1a-477b-a004-2e7576d3de0d/log': 'Fatal error: no such image',
  });
  const { report, source } = await buildFailureReport(watch, { fetchImpl });
  assert.ok(report.includes('Failed step: Download falcon image'), report);
  assert.equal(source, 'log');
});

test('buildFailureReport prefers an annotation over the log', async () => {
  const fetchImpl = stubFetch({
    '/builds/9696.json': JSON.stringify({
      state: 'failed',
      annotations: [{ style: 'error', body_html: '<p>3 specs failed in checkout</p>' }],
      jobs: [{ name: 'RSpec', state: 'failed', id: 'j1' }],
    }),
    '/jobs/j1/log': 'Error: something less specific',
  });
  const { report, source } = await buildFailureReport(watch, { fetchImpl });
  assert.equal(source, 'annotation');
  assert.ok(report.includes('3 specs failed in checkout'));
  assert.ok(!report.includes('something less specific'));
});

test('buildFailureReport still returns the build and link when nothing can be read', async () => {
  const { report, source, error } = await buildFailureReport(watch, { fetchImpl: stubFetch({}) });
  assert.equal(report, 'Build web #9696 failed — https://buildkite.com/acme/web/builds/9696');
  assert.equal(source, null);
  assert.ok(error.includes('build json'));
});

test('buildFailureReport reports being signed out rather than a wall of failures', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200, url: 'https://buildkite.com/login', headers: new Map(), text: async () => '',
  });
  const { source, error } = await buildFailureReport(watch, { fetchImpl });
  assert.equal(source, null);
  assert.equal(error, 'not signed in to Buildkite');
});
