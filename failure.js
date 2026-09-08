// Turning a failed build into a short reason worth pasting into Slack or a
// prompt. Pure logic plus a provider chain, mirroring status.js and
// discovery.js: no `chrome.*` at module scope, so Node can import it for tests.

import { HOSTS, classifyResponse, resolveCode, ProviderError, pickBuild } from './status.js';

// ---------------------------------------------------------------------------
// Log text: getting from a raw Buildkite log to lines worth reading
// ---------------------------------------------------------------------------

/**
 * Remove terminal control sequences. Buildkite interleaves its own per-line
 * timestamps as APC escapes (`ESC _bk;t=1699999999999 BEL`) alongside ordinary
 * colour codes, and both would otherwise dominate the text.
 */
export function stripAnsi(text) {
  /* eslint-disable no-control-regex -- matching the control characters is the point */
  return String(text ?? '')
    .replace(/\u001B[\]_][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '') // OSC / APC, incl. _bk;t=
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '') // CSI: colour, cursor moves
    .replace(/\u001B[@-Z\\-_]/g, ''); // stray two-byte escapes
  /* eslint-enable no-control-regex */
}

/**
 * Split a log into readable lines: control sequences gone, progress bars
 * collapsed to their final state, blanks and immediate repeats dropped.
 */
export function logLines(text) {
  const out = [];
  for (const raw of stripAnsi(text).split('\n')) {
    // A carriage return means the line was overwritten in place (progress
    // bars, spinners). Only what it settled on matters.
    const line = raw.split('\r').pop().replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (line === out[out.length - 1]) continue; // a retry loop printing the same thing
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Redaction
//
// A build log is full of things nobody meant to publish: a step that exports
// credentials, a curl carrying a token, a registry login. This button exists to
// put that log in a Slack message, so anything it copies has to be scrubbed on
// the way out.
//
// It is a safety net, not a guarantee. It catches assignments to secret-ish
// names, values that are simply too opaque to be anything else, and the token
// shapes that are recognisable on sight. It does not understand a secret your
// pipeline prints in prose, and it deliberately leaves ARNs, account ids and
// hostnames alone — redacting those would gut the error message.
// ---------------------------------------------------------------------------

const REDACTED = '‹redacted›';

// A variable name that has no business being in a paste.
const SECRET_NAME = /(?:secret|token|passwd|password|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?id|credential|auth|bearer|signature|session|(?:^|_)cid)\b/i;

// A value with no words in it and no spaces: a key, not a sentence.
const OPAQUE = /^[A-Za-z0-9+/=_.:-]{20,}$/;

/** Scrub one line of anything that looks like a credential. */
export function redactSecrets(line) {
  const text = String(line ?? '');
  if (/-----BEGIN[^-]*PRIVATE KEY-----/.test(text)) return REDACTED;
  return text
    // Token shapes that are recognisable wherever they appear.
    .replace(/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{12,}\b/g, REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED)
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    // Credentials inside a URL.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
    // The header first, taking the whole value with it, so the bearer rule
    // below cannot redact what is left and leave two markers behind.
    .replace(/\b(authorization\s*[:=]\s*).+$/i, `$1${REDACTED}`)
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, `$1${REDACTED}`)
    // A secret passed as a flag, but only when the value could be one: the
    // string "--password" in a warning about --password must survive.
    .replace(
      /(--?(?:password|passwd|token|secret|api[_-]?key|access[_-]?key))([=\s]+)(\S{12,})/gi,
      (m, flag, sep, value) => (OPAQUE.test(value) ? `${flag}${sep}${REDACTED}` : m),
    )
    // NAME=value, with or without `export`. Redacted when the name gives it
    // away, or when the value is too opaque to be anything but a key.
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g,
      (m, name, value) => {
        const bare = value.replace(/^["']|["']$/g, '');
        return SECRET_NAME.test(name) || (bare.length >= 20 && OPAQUE.test(bare))
          ? `${name}=${REDACTED}`
          : m;
      },
    );
}

// Buildkite's own section markers. They bound a cluster of output but are
// never themselves the reason a build failed.
const SECTION = /^(?:---|\+\+\+|~~~|\^\^\^)(?:\s|$)/;

// What a line looks like when it is the actual cause, most specific first.
// Only the strongest match counts, so a stack trace under "Error:" cannot
// out-score the error line itself.
const SIGNALS = [
  [12, /^[\s\W]{0,4}(?:##\[error\]|error|fatal|panic|failure)\b\s*[:/]/i],
  [12, /\b(?:Traceback \(most recent call last\)|Segmentation fault|core dumped)\b/i],
  [11, /npm ERR!|\bpanic:|\bfatal error\b|\bAssertionError\b/i],
  [10, /^\s*(?:[✗✘×✖‼]|FAIL(?:ED|URE)?\b)/],
  [9, /\b\d+\s+(?:failing|failed|failures?|errors?)\b/i],
  [9, /\b[A-Z]\w*(?:Error|Exception|Failure)\b\s*[:(]/],
  [8, /\b(?:exited with|exit status|exit code|returned)\s+(?:status\s+)?(?!0\b)\d+/i],
  [7, /\b(?:cannot find|no such file|not found|permission denied|command not found|undefined reference|unresolved|connection refused|timed out)\b/i],
  [6, /\b(?:expected|assertion)\b.*\b(?:but|got|to be|to eq)\b/i],
  [5, /\b(?:error|failure|failed)\b/i],
];

// Lines that carry one of the words above without being the cause.
const NOISE = [
  [-12, /\b(?:0|no)\s+(?:failures?|errors?)\b/i],
  [-6, /^\s*(?:warn(?:ing)?|notice|debug|info)\b/i],
  [-6, /\bdeprecat/i],
  [-5, /\bretrying\b|\bwill retry\b/i],
  [-4, /^\s*\$\s/], // the echoed command: context, not the cause
  [-3, /^\s*(?:at|from|in)\s+\S+[:(]/], // a stack frame belongs under an anchor, not as one
];

// A build system announcing that something underneath it failed. True, and
// worth keeping in the excerpt, but never the cause — the cause is the output
// just above, and these lines are the ones nearest the end, so left alone they
// win on recency every time and bury it.
const CONSEQUENCE = [
  /^make(?:\[\d+\])?:\s*\*\*\*/,
  /\bexited with (?:status|code)\s+\d+/i,
  /\bthe command exited\b/i,
  /\b(?:hook|plugin|command|process|recipe)\s+(?:exited|failed)\b/i,
];
const CONSEQUENCE_CAP = 2;

/** How likely a single line is to be the reason the build failed. */
export function scoreLine(line) {
  let score = 0;
  for (const [weight, re] of SIGNALS) {
    if (re.test(line)) { score = weight; break; }
  }
  for (const [penalty, re] of NOISE) {
    if (re.test(line)) score += penalty;
  }
  // Still able to anchor a log that has nothing else to offer, never able to
  // outrank a line that actually says what went wrong.
  if (score > CONSEQUENCE_CAP && CONSEQUENCE.some((re) => re.test(line))) return CONSEQUENCE_CAP;
  return score;
}

const TAIL_LINES = 400;
const LEAD_IN = 2;

/**
 * Where to start reading, given the anchor. An anchor like "expected: 42" says
 * nothing without the assertion above it, so a couple of lines of context come
 * with it — but never across a section marker, and never a line that scored
 * negative, which is how a passing suite sitting above the error stays out.
 */
function leadIn(lines, anchor) {
  let start = anchor;
  for (let i = anchor - 1; i >= 0 && anchor - i <= LEAD_IN; i--) {
    if (SECTION.test(lines[i]) || scoreLine(lines[i]) < 0) break;
    start = i;
  }
  return start;
}

/**
 * Pick the passage of a log that explains the failure.
 *
 * Errors cluster near the end of a failing log, so every line in the tail is
 * scored on its wording and nudged by how late it appears; the best line
 * anchors a short window, which stops at the next section marker. A log where
 * nothing scores falls back to its last few lines — which is what a person
 * would have looked at anyway.
 *
 * @returns {{lines: string[], anchored: boolean, truncated: boolean}|null}
 */
export function summariseLog(text, { maxLines = 12, maxChars = 900 } = {}) {
  const all = logLines(text);
  if (!all.length) return null;
  const tail = all.slice(-TAIL_LINES);

  let anchor = -1;
  let best = 0;
  tail.forEach((line, i) => {
    if (SECTION.test(line)) return;
    const base = scoreLine(line);
    if (base <= 0) return; // recency alone must never anchor a quiet log
    const score = base + ((i + 1) / tail.length) * 3;
    if (score > best) { best = score; anchor = i; }
  });

  const start = anchor < 0 ? Math.max(0, tail.length - maxLines) : leadIn(tail, anchor);
  const lines = [];
  let chars = 0;
  let truncated = false;
  for (let i = start; i < tail.length; i++) {
    if (lines.length >= maxLines) { truncated = true; break; }
    if (i > start && SECTION.test(tail[i])) break;
    const clean = redactSecrets(tail[i]);
    const line = clean.length > 200 ? `${clean.slice(0, 199)}…` : clean;
    if (chars + line.length > maxChars) { truncated = true; break; }
    chars += line.length + 1;
    lines.push(line);
  }
  return lines.length ? { lines, anchored: anchor >= 0, truncated } : null;
}

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'", '#x2f': '/',
};

/** Flatten an annotation's HTML into plain text. */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|pre|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39|#x27|#x2F);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

const FAILED_JOB_STATES = new Set(['failed', 'broken', 'timed_out', 'timing_out', 'errored']);

/** Did this job fail in a way that failed the build? A soft failure did not. */
export function isFailedJob(job) {
  if (!job || typeof job !== 'object') return false;
  if (job.soft_failed === true || job.soft_fail === true) return false;

  // A step from the build page's own steps endpoint reports `state: "finished"`
  // and puts the verdict in `outcome` (e.g. "hard_failed"), with no
  // exit_status at all — so the state alone says nothing about whether it
  // passed, and `finished` must never be read as a failure.
  const outcome = String(job.outcome ?? '').trim().toLowerCase();
  if (outcome) {
    if (outcome.includes('soft_fail')) return false;
    if (/fail|error|broken|timed_out/.test(outcome)) return true;
    if (/pass|success|neutral|skip/.test(outcome)) return false;
  }

  const exit = job.exit_status;
  if (exit !== null && exit !== undefined && exit !== '' && Number(exit) !== 0) return true;
  return FAILED_JOB_STATES.has(String(job.state ?? '').trim().toLowerCase());
}

/** A short name for a job, whatever the payload happens to call it. */
export function jobLabel(job) {
  const raw = job?.name ?? job?.label ?? job?.step_label ?? job?.command ?? '';
  const text = redactSecrets(htmlToText(String(raw)).split('\n')[0]).trim();
  if (!text) return 'a step';
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** Pull an array of steps out of whatever the steps endpoint returned. */
export function pickSteps(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return null;
  for (const key of ['steps', 'jobs', 'data', 'results', 'items']) {
    if (Array.isArray(body[key])) return body[key];
  }
  return Array.isArray(body.data?.steps) ? body.data.steps : null;
}

/**
 * A step can be a group holding the real jobs, so flatten one level. Buildkite
 * is asked for `exclude_group_steps=true`, but the parameter is not guaranteed
 * to be honoured by every payload shape.
 */
export function flattenSteps(steps) {
  const out = [];
  for (const step of steps ?? []) {
    if (!step || typeof step !== 'object') continue;
    const nested = [step.jobs, step.steps].find(Array.isArray);
    if (nested?.length) out.push(...nested);
    else out.push(step);
  }
  return out;
}

/** The failed jobs of a build. */
export function pickFailedJobs(build) {
  const jobs = [build?.jobs, build?.steps, build?.build?.jobs].find((a) => Array.isArray(a) && a.length) ?? [];
  return flattenSteps(jobs).filter(isFailedJob);
}

/**
 * Where a build's steps live when the build JSON does not carry them.
 *
 * The modern Buildkite build page loads its steps separately: `jobs` and
 * `steps` are present but empty in `<build url>.json`, and the page preloads
 * `<build>/data/steps?exclude_group_steps=true&state=failed` instead. The build
 * payload names that base itself, as `build_data_base_path`.
 */
export function stepsUrls(buildUrl, build) {
  const origin = `https://${HOSTS[0]}`;
  const query = '?exclude_group_steps=true&state=failed';
  const bases = [];
  for (const raw of [build?.build_data_base_path, `${buildUrl}/data`]) {
    if (typeof raw !== 'string' || !raw) continue;
    const abs = raw.startsWith('http') ? raw : `${origin}${raw.startsWith('/') ? '' : '/'}${raw}`;
    bases.push(abs.replace(/\/$/, ''));
  }
  // Narrowed to the failures first; the unfiltered list is the fallback for an
  // instance that does not accept the parameters.
  return [...new Set(bases.flatMap((b) => [`${b}/steps${query}`, `${b}/steps`]))];
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function headline({ pipeline, number, state, url }) {
  const name = pipeline ? `${pipeline} #${number}` : url;
  const verb = state === 'canceled' ? 'was canceled'
    : state === 'skipped' ? 'was skipped'
      : state === 'not_run' ? 'did not run'
        : state && state !== 'failed' ? `finished as "${state}"`
          : 'failed';
  return `Build ${name} ${verb}`;
}

/**
 * Assemble the text that goes on the clipboard: one line naming the build and
 * linking it, the step that failed, then the reason in a fenced block so it
 * survives a paste into Slack or a prompt.
 */
export function formatReport({ pipeline, number, url, state = 'failed', jobs = [], reason = null }) {
  const lines = [`${headline({ pipeline, number, state, url })} — ${url}`];

  const named = jobs.slice(0, 3).map((job) => {
    const exit = job?.exit_status;
    const suffix = exit !== null && exit !== undefined && exit !== '' && Number(exit) !== 0
      ? ` (exit ${exit})` : '';
    return `${jobLabel(job)}${suffix}`;
  });
  if (named.length === 1) {
    lines.push(`Failed step: ${named[0]}`);
  } else if (named.length > 1) {
    const more = jobs.length > named.length ? `, +${jobs.length - named.length} more` : '';
    lines.push(`Failed steps: ${named.join(', ')}${more}`);
  }

  if (reason?.lines?.length) {
    lines.push('', '```', ...reason.lines, ...(reason.truncated ? ['…'] : []), '```');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * Where a job's log might live. Buildkite's internal paths are undocumented and
 * differ between payload shapes, so anything the job object itself offers is
 * tried before the assembled guesses.
 */
export function jobLogUrls(buildUrl, job) {
  const origin = `https://${HOSTS[0]}`;
  const abs = (p) => (p.startsWith('http') ? p : `${origin}${p.startsWith('/') ? '' : '/'}${p}`);
  const urls = [];
  for (const key of ['log_url', 'raw_log_url', 'log_path', 'raw_log_path', 'base_path', 'path', 'url']) {
    const v = job?.[key];
    if (typeof v !== 'string' || !v) continue;
    if (/log/i.test(key)) urls.push(abs(v));
    else urls.push(`${abs(v).replace(/\/$/, '')}/log`, `${abs(v).replace(/\/$/, '')}/raw_log`);
  }
  const id = job?.id ?? job?.uuid;
  if (id) urls.push(`${buildUrl}/jobs/${id}/log`, `${buildUrl}/jobs/${id}/raw_log`);
  return [...new Set(urls)];
}

/** Where a build's annotations might live. */
export function annotationUrls(buildUrl) {
  return [`${buildUrl}/annotations`, `${buildUrl}/annotations.json`];
}

/** Pull log text out of whatever the endpoint returned: JSON or plain text. */
export function extractLogText(text) {
  const body = String(text ?? '');
  if (!body.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON, so it is either the log itself or a login/error page.
    return /^\s*<(?:!doctype|html)\b/i.test(body.trimStart()) ? null : body;
  }
  if (typeof parsed === 'string') return parsed || null;
  for (const key of ['content', 'log', 'body', 'output', 'raw', 'text']) {
    if (typeof parsed?.[key] === 'string' && parsed[key]) return parsed[key];
  }
  // Chunked logs: [{content}, {content}, …]
  const list = [parsed?.chunks, parsed?.lines, Array.isArray(parsed) ? parsed : null].find(Array.isArray);
  if (list) {
    const joined = list.map((c) => (typeof c === 'string' ? c : c?.content ?? c?.text ?? '')).join('');
    if (joined.trim()) return joined;
  }
  return null;
}

function rankStyle(style) {
  return style === 'error' ? 0 : style === 'warning' ? 1 : 2;
}

/** Reduce an annotations payload to its text, error styles first. */
export function extractAnnotations(body) {
  const list = [body?.annotations, body?.data?.annotations, Array.isArray(body) ? body : null].find(Array.isArray);
  if (!list) return null;
  const ranked = list
    .map((a) => ({
      style: String(a?.style ?? a?.context_style ?? '').trim().toLowerCase(),
      text: htmlToText(a?.body_html ?? a?.body ?? a?.html ?? a?.content ?? ''),
    }))
    .filter((a) => a.text)
    .sort((a, b) => rankStyle(a.style) - rankStyle(b.style));
  return ranked.length ? ranked : null;
}

async function getText(url, fetchImpl, accept) {
  const res = await fetchImpl(url, {
    credentials: 'include', cache: 'no-store', redirect: 'follow', headers: { Accept: accept },
  });
  if (classifyResponse(res) === 'auth') throw new ProviderError('not signed in', 'auth');
  if (!res.ok) throw new ProviderError(`HTTP ${res.status}`, 'http');
  return res.text();
}

/**
 * Annotations are written by the pipeline's own authors to say what went
 * wrong, so when a build has one it beats anything scraped out of a log.
 */
/**
 * How many annotations the build says it has. The build payload carries
 * `annotation_counts_by_style` ({error: 2, info: 1, …}), so a build with none
 * can skip the hunt for them entirely rather than spending two requests
 * finding out. Returns null when the payload does not say.
 */
export function annotationCount(build) {
  const counts = build?.annotation_counts_by_style;
  if (!counts || typeof counts !== 'object') return null;
  const values = Object.values(counts).filter((n) => Number.isFinite(Number(n)));
  return values.length ? values.reduce((a, b) => a + Number(b), 0) : null;
}

async function annotationProvider({ buildUrl, build }, { fetchImpl }) {
  let found = extractAnnotations(build);
  if (!found && annotationCount(build) === 0) {
    throw new ProviderError('annotations: build reports none', 'unavailable');
  }
  if (!found) {
    for (const url of annotationUrls(buildUrl)) {
      try {
        found = extractAnnotations(JSON.parse(await getText(url, fetchImpl, 'application/json')));
        if (found) break;
      } catch (err) {
        if (err?.code === 'auth') throw err;
      }
    }
  }
  if (!found?.length) throw new ProviderError('annotations: none published', 'unavailable');
  const summary = summariseLog(found.map((a) => a.text).join('\n\n'), { maxLines: 14 });
  if (!summary) throw new ProviderError('annotations: empty', 'shape');
  return { ...summary, source: 'annotation' };
}

/** Otherwise, read the log of the step that failed. */
async function jobLogProvider({ buildUrl, jobs }, { fetchImpl }) {
  if (!jobs.length) throw new ProviderError('log: no failed step reported', 'unavailable');
  const tried = [];
  for (const job of jobs.slice(0, 2)) {
    for (const url of jobLogUrls(buildUrl, job)) {
      try {
        const log = extractLogText(await getText(url, fetchImpl, 'application/json, text/plain, */*'));
        if (!log) { tried.push(`${url} (not a log)`); continue; }
        const summary = summariseLog(log);
        if (summary) return { ...summary, source: 'log' };
      } catch (err) {
        if (err?.code === 'auth') throw err;
        tried.push(`${url} (${err?.message ?? err})`);
      }
    }
  }
  throw new ProviderError(`log: no readable log (${tried.slice(0, 4).join('; ') || 'no candidate urls'})`, 'shape');
}

const REASON_PROVIDERS = [
  { name: 'annotation', run: annotationProvider },
  { name: 'log', run: jobLogProvider },
];

/**
 * Build the pasteable failure report for one build.
 *
 * Nothing below the first line is required: a build whose log cannot be read
 * still produces a report naming it and linking it, which is the part someone
 * actually needs in order to ask for help.
 *
 * @param {{pipeline?: string, number?: number, url: string}} watch
 * @param {{fetchImpl?: typeof fetch, state?: string}} deps
 * @returns {Promise<{report: string, source: string|null, error?: string}>}
 */
export async function buildFailureReport(watch, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const buildUrl = watch.url;

  let build = null;
  let buildError = null;
  try {
    build = pickBuild(JSON.parse(await getText(`${buildUrl}.json`, fetchImpl, 'application/json')));
  } catch (err) {
    buildError = `build json: ${err?.message ?? String(err)}`;
  }

  let jobs = pickFailedJobs(build);
  // `jobs` and `steps` come back present but empty on a modern build page,
  // which loads them separately. Ask for them where the page itself does.
  if (!jobs.length && build) {
    for (const url of stepsUrls(buildUrl, build)) {
      try {
        const steps = flattenSteps(pickSteps(JSON.parse(await getText(url, fetchImpl, 'application/json'))));
        if (!steps.length) continue;
        const failed = steps.filter(isFailedJob);
        if (failed.length) { jobs = failed; break; }
        // The URL asked Buildkite for the failed steps and it returned some.
        // Whatever they look like, its filter knows better than ours does.
        if (url.includes('state=failed')) { jobs = steps; break; }
      } catch (err) {
        if (err?.code === 'auth') break;
      }
    }
  }
  const rawState = build?.state ? String(build.state).trim().toLowerCase() : (deps.state ?? 'failed');
  const state = rawState === 'started' || rawState === 'running' ? 'failed' : rawState;

  let reason = null;
  const failures = [];
  for (const provider of REASON_PROVIDERS) {
    try {
      reason = await provider.run({ buildUrl, build, jobs }, { fetchImpl });
      break;
    } catch (err) {
      failures.push(err ?? new Error(`${provider.name}: failed`));
    }
  }

  const report = formatReport({
    pipeline: watch.pipeline, number: watch.number, url: buildUrl, state, jobs, reason,
  });

  const out = { report, source: reason?.source ?? null };
  if (!reason) {
    const code = resolveCode(failures);
    out.error = code === 'auth'
      ? 'not signed in to Buildkite'
      : [buildError, ...failures.map((f) => f?.message ?? String(f))].filter(Boolean).join('; ');
  }
  return out;
}
