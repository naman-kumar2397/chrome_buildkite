// Pure build-status logic shared by the service worker and the unit tests.
// No `chrome.*` globals are referenced at module scope so this file can be
// imported by Node for testing. Anything browser-specific is injected.

export const HOSTS = ['buildkite.com'];

// Buildkite's public REST API reports `running`; the internal web JSON that
// backs the build page (GET <build url>.json) reports `started`. Normalise.
export const STATE_ALIASES = {
  started: 'running',
  cancelling: 'canceling',
  cancelled: 'canceled',
};

// A build with a manual block step keeps its previous `state` and flags the
// block separately (`blocked: true` in REST, `blocked_state: "blocked"` in the
// web JSON), so "blocked" is derived from those flags, not the state string.
export const FINISHED_STATES = new Set(['passed', 'failed', 'canceled', 'skipped', 'not_run']);
export const FAILURE_STATES = new Set(['failed', 'canceled', 'skipped', 'not_run']);
export const KNOWN_STATES = new Set([
  ...FINISHED_STATES,
  'creating', 'scheduled', 'running', 'failing', 'blocked', 'canceling', 'waiting', 'waiting_failed',
]);

const BUILD_PATH = /^\/([^/]+)\/([^/]+)\/builds\/(\d+)(?:[/?#]|$)/;
const LOGIN_PATH = /\/(login|signin|sign_in|sso|session\/new)\b/i;

/** An error that records why a provider failed, so the UI can special-case auth. */
export class ProviderError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

/**
 * Decide whether a response means "not signed in". Buildkite redirects an
 * unauthenticated fetch to its login page rather than returning 401, so the
 * final URL matters as much as the status.
 */
export function classifyResponse(res) {
  if (!res) return 'error';
  if (res.status === 401 || res.status === 403) return 'auth';
  if (typeof res.url === 'string' && LOGIN_PATH.test(res.url)) return 'auth';
  if (res.redirected && typeof res.url === 'string' && !/\/builds\b/.test(res.url)) return 'auth';
  return 'ok';
}

/**
 * Reduce a chain's failures to one code. A single "not signed in" answer from
 * any provider that actually reached Buildkite decides it: the DOM fallback
 * failing for want of an open tab says nothing about the session.
 */
export function resolveCode(errors) {
  if (errors.some((e) => e?.code === 'auth')) return 'auth';
  const codes = errors.map((e) => e?.code).filter(Boolean);
  return codes.length === errors.length && new Set(codes).size === 1 ? codes[0] : undefined;
}

/** Parse a Buildkite build URL into its parts, or return null. */
export function parseBuildUrl(input) {
  let u;
  try { u = new URL(input); } catch { return null; }
  if (u.protocol !== 'https:' || !HOSTS.includes(u.hostname)) return null;
  const m = BUILD_PATH.exec(u.pathname);
  if (!m) return null;
  const [, org, pipeline, number] = m;
  return {
    org,
    pipeline,
    number: Number(number),
    url: `https://${u.hostname}/${org}/${pipeline}/builds/${number}`,
  };
}

function isSet(v) {
  return v !== null && v !== undefined && v !== '' && v !== false;
}

/**
 * Normalise a raw build object into {state, blocked, finished}.
 * Accepts both the REST shape ({state, blocked}) and the web JSON shape
 * ({state: "started", blocked_state, finished_at, canceled_at, cancel_status}).
 * Adds `rawState` when the reported state was aliased or unrecognised, and
 * `unknownFinish` when the build is finished but the state is not one we know.
 */
export function normalise(raw) {
  const rawState = typeof raw?.state === 'string' ? raw.state.trim().toLowerCase() : 'unknown';
  let state = STATE_ALIASES[rawState] ?? rawState;

  const blockedState = typeof raw?.blocked_state === 'string' ? raw.blocked_state.trim().toLowerCase() : '';
  const blocked = raw?.blocked === true || state === 'blocked' || blockedState === 'blocked';

  const finished = !blocked && (FINISHED_STATES.has(state) || isSet(raw?.finished_at));
  let unknownFinish = false;
  if (finished && !FINISHED_STATES.has(state)) {
    if (isSet(raw?.canceled_at) || isSet(raw?.cancel_status)) state = 'canceled';
    else unknownFinish = true;
  }

  const out = { state, blocked, finished };
  // Keep the reported state whenever it was aliased or is one we don't know,
  // so the popup and notifications can show exactly what Buildkite said.
  if (rawState !== state || unknownFinish) out.rawState = rawState;
  if (unknownFinish) out.unknownFinish = true;
  return out;
}

/**
 * Decide which chime (if any) a transition from `prev` to `next` deserves.
 * Returns 'input' | 'success' | 'failure' | null.
 */
export function decideEvent(prev, next) {
  const p = prev ?? { state: 'unknown', blocked: false, finished: false };
  if (next.blocked) return p.blocked ? null : 'input';
  if (!next.finished) return null;
  if (next.state === 'passed') return 'success';
  if (FAILURE_STATES.has(next.state)) return 'failure';
  if (next.unknownFinish) return 'failure'; // finished with a state we don't know: worth a look
  return null;
}

/** Human label for a normalised status. */
export function describe(status) {
  if (status.blocked) return 'blocked, waiting for input';
  if (status.unknownFinish) return `finished with state "${status.rawState || status.state}"`;
  switch (status.state) {
    case 'passed': return 'passed';
    case 'failed': return 'failed';
    case 'failing': return 'failing';
    case 'canceled': return 'canceled';
    case 'canceling': return 'canceling';
    case 'running': return 'running';
    case 'scheduled': return 'scheduled';
    case 'creating': return 'starting';
    case 'waiting':
    case 'waiting_failed': return 'waiting';
    case 'skipped': return 'skipped';
    case 'not_run': return 'not run';
    default: return 'in an unknown state';
  }
}

// ---------------------------------------------------------------------------
// Status providers. Each takes (watch, deps) and resolves to a raw build-like
// object or throws. `fetchStatus` tries them in order, starting with whichever
// one worked last time for this watch.
// ---------------------------------------------------------------------------

/** Find the build object inside a JSON body. Exported for tests. */
export function pickBuild(body) {
  if (!body || typeof body !== 'object') return null;
  const candidates = [body, body.build, body.data, body.data?.build];
  for (const c of candidates) {
    if (c && typeof c === 'object' && typeof c.state === 'string') return c;
  }
  return null;
}

async function jsonProvider(watch, { fetchImpl }) {
  const res = await fetchImpl(`${watch.url}.json`, {
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
    headers: { Accept: 'application/json' },
  });
  const cls = classifyResponse(res);
  if (cls === 'auth') throw new ProviderError('json: not signed in', 'auth');
  if (!res.ok) throw new ProviderError(`json: HTTP ${res.status}`, 'http');
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json')) throw new ProviderError(`json: unexpected content-type ${ct}`, 'shape');
  const body = await res.json();
  const build = pickBuild(body);
  if (!build) {
    const keys = body && typeof body === 'object' ? Object.keys(body).slice(0, 12).join(',') : typeof body;
    throw new ProviderError(`json: no state field (keys: ${keys})`, 'shape');
  }
  return build;
}

const HTML_STATE_WORDS = [...KNOWN_STATES, ...Object.keys(STATE_ALIASES)].join('|');

/** Extract a build state from raw HTML. Exported for tests. */
export function extractStateFromHtml(html) {
  if (typeof html !== 'string' || !html) return null;
  const patterns = [
    // data attributes on the build header, e.g. data-build-state="running"
    new RegExp(`data-(?:build-)?state=["'](${HTML_STATE_WORDS})["']`, 'i'),
    // embedded JSON, e.g. "state":"started" ... "blocked_state":"blocked"
    new RegExp(`"state"\\s*:\\s*"(${HTML_STATE_WORDS})"`, 'i'),
    // visible header text, e.g. >Running for 2m 47s<  /  >Passed in 5m<
    new RegExp(`>\\s*(${HTML_STATE_WORDS})\\s+(?:for|in|after)\\b`, 'i'),
    // class names like build-state-running / build--running
    new RegExp(`build-?(?:state)?-{1,2}(${HTML_STATE_WORDS})\\b`, 'i'),
    // page title, e.g. <title>Running: Pipeline #123 ...
    new RegExp(`<title>[^<]*?\\b(${HTML_STATE_WORDS})\\b`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) {
      const blockedFlag = /"blocked"\s*:\s*(true|false)/i.exec(html);
      const blockedState = /"blocked_state"\s*:\s*"(\w+)"/i.exec(html);
      const blocked = (blockedFlag ? blockedFlag[1].toLowerCase() === 'true' : false)
        || (blockedState ? blockedState[1].toLowerCase() === 'blocked' : false);
      return { state: m[1].toLowerCase(), blocked };
    }
  }
  return null;
}

async function htmlProvider(watch, { fetchImpl }) {
  const res = await fetchImpl(watch.url, {
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
    headers: { Accept: 'text/html' },
  });
  const cls = classifyResponse(res);
  if (cls === 'auth') throw new ProviderError('html: not signed in', 'auth');
  if (!res.ok) throw new ProviderError(`html: HTTP ${res.status}`, 'http');
  const html = await res.text();
  const picked = extractStateFromHtml(html);
  if (!picked) throw new ProviderError('html: no recognisable state markup', 'shape');
  return picked;
}

async function domProvider(watch, { domProbe }) {
  if (typeof domProbe !== 'function') throw new ProviderError('dom: no probe available', 'unavailable');
  const result = await domProbe(watch);
  if (!result || typeof result.state !== 'string' || result.state === 'unknown') {
    throw new ProviderError('dom: no open tab reported a state', 'unavailable');
  }
  return result;
}

const PROVIDERS = [
  { name: 'json', run: jsonProvider },
  { name: 'html', run: htmlProvider },
  { name: 'dom', run: domProvider },
];

/**
 * Fetch the current status for a watch.
 * @param {{url: string, provider?: string}} watch
 * @param {{fetchImpl?: typeof fetch, domProbe?: (watch) => Promise<{state:string, blocked?:boolean}|null>}} deps
 * @returns {Promise<{state:string, blocked:boolean, finished:boolean, provider:string, rawState?:string, unknownFinish?:boolean}>}
 */
export async function fetchStatus(watch, deps = {}) {
  const resolved = { fetchImpl: deps.fetchImpl ?? globalThis.fetch, domProbe: deps.domProbe };
  const ordered = watch.provider
    ? [...PROVIDERS.filter((p) => p.name === watch.provider), ...PROVIDERS.filter((p) => p.name !== watch.provider)]
    : PROVIDERS;
  const failures = [];
  for (const p of ordered) {
    try {
      const raw = await p.run(watch, resolved);
      return { ...normalise(raw), provider: p.name };
    } catch (err) {
      failures.push(err ?? new Error(`${p.name}: failed`));
    }
  }
  const code = resolveCode(failures);
  const messages = failures.map((f) => f?.message ?? String(f));
  const e = new ProviderError(
    code === 'auth' ? 'not signed in to Buildkite' : `all providers failed (${messages.join('; ')})`,
    code,
  );
  e.errors = messages;
  throw e;
}
