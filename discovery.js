// Discovering the signed-in user's own builds from the /builds listing.
// Pure logic plus a provider chain, mirroring status.js: no `chrome.*` at
// module scope, so Node can import it for tests.

import { HOSTS, normalise, parseBuildUrl, classifyResponse, resolveCode, ProviderError } from './status.js';

const LIST_PATHS = ['/builds.json', '/builds.json?filter=mine', '/builds.json?state=running'];

/** Build a canonical build URL from loose fields, or return null. */
function toBuildUrl(item) {
  const direct = item?.path ?? item?.url ?? item?.href ?? item?.web_url ?? item?.build_path;
  if (typeof direct === 'string' && direct) {
    const abs = direct.startsWith('http') ? direct : `https://${HOSTS[0]}${direct.startsWith('/') ? '' : '/'}${direct}`;
    const parsed = parseBuildUrl(abs);
    if (parsed) return parsed;
  }
  // Fall back to assembling it from parts, e.g. {account: {slug}, project: {slug}, number}
  const org = slugOf(item?.account ?? item?.organization ?? item?.org);
  const pipeline = slugOf(item?.project ?? item?.pipeline);
  const number = Number(item?.number);
  if (org && pipeline && Number.isFinite(number) && number > 0) {
    return { org, pipeline, number, url: `https://${HOSTS[0]}/${org}/${pipeline}/builds/${number}` };
  }
  return null;
}

function slugOf(v) {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object') {
    const s = v.slug ?? v.name ?? v.permalink;
    return typeof s === 'string' && s.trim() ? s.trim() : null;
  }
  return null;
}

/** Pull the array of builds out of whatever the listing endpoint returned. */
export function pickList(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return null;
  for (const key of ['builds', 'data', 'results', 'items']) {
    if (Array.isArray(body[key])) return body[key];
  }
  if (Array.isArray(body.data?.builds)) return body.data.builds;
  return null;
}

/**
 * Normalise a listing payload into build records.
 * @returns {Array<{org,pipeline,number,url,state,blocked,finished,rawState?,unknownFinish?}>}
 */
export function parseBuildList(body) {
  const list = pickList(body);
  if (!list) return null;
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = toBuildUrl(item);
    if (!id || seen.has(id.url)) continue;
    seen.add(id.url);
    out.push({ ...id, ...normalise(item) });
  }
  return out;
}

const HREF = /href=["'](\/[^"'/]+\/[^"'/]+\/builds\/\d+)["']/gi;
const STATE_WORD = 'passed|failed|failing|running|started|blocked|canceled|cancelled|canceling|cancelling|scheduled|waiting|skipped|not_run';

const ROW_OPEN = /<(?:li|tr|article|section)\b/gi;
const ROW_CLOSE = /<\/(?:li|tr|article|section)>/i;

/**
 * The markup belonging to one build link: from the row element that opens it
 * to the row's close, clamped so it can never reach into a neighbouring link.
 */
function rowSegment(html, matches, i) {
  const lowerBound = i === 0 ? 0 : matches[i - 1].end;
  const upperBound = i === matches.length - 1 ? html.length : matches[i + 1].start;
  const hit = matches[i];

  let from = lowerBound;
  ROW_OPEN.lastIndex = lowerBound;
  let m;
  while ((m = ROW_OPEN.exec(html)) !== null && m.index < hit.start) from = m.index;

  const closeIn = ROW_CLOSE.exec(html.slice(hit.end, upperBound));
  const to = closeIn ? hit.end + closeIn.index : Math.min(upperBound, hit.end + 400);
  return html.slice(from, to);
}

/** Best-effort state for one listing row, most specific pattern first. */
function stateFromSegment(segment) {
  const patterns = [
    new RegExp(`\\b(${STATE_WORD})\\s+(?:for|in|after)\\b`, 'i'), // "Running for 2m" / "Passed in 5m"
    new RegExp(`build-{1,2}(?:state-{1,2})?(${STATE_WORD})\\b`, 'i'),  // build--running
    new RegExp(`(?:data-(?:build-)?state|"state")\\s*[=:]\\s*["'](${STATE_WORD})["']`, 'i'),
    new RegExp(`\\b(${STATE_WORD})\\b`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(segment);
    if (m) return m[1].toLowerCase();
  }
  return 'unknown';
}

/**
 * Extract build records from the /builds HTML listing. Each link is scored only
 * against the markup of its own row — the span from the previous build link to
 * the next one — so one row's state cannot leak into its neighbour.
 */
export function extractBuildsFromHtml(html) {
  if (typeof html !== 'string' || !html) return null;
  const matches = [];
  HREF.lastIndex = 0;
  let m;
  while ((m = HREF.exec(html)) !== null) matches.push({ path: m[1], start: m.index, end: m.index + m[0].length });
  if (!matches.length) return null;

  const out = [];
  const seen = new Set();
  matches.forEach((hit, i) => {
    const id = parseBuildUrl(`https://${HOSTS[0]}${hit.path}`);
    if (!id || seen.has(id.url)) return;
    seen.add(id.url);
    out.push({ ...id, ...normalise({ state: stateFromSegment(rowSegment(html, matches, i)) }) });
  });
  return out.length ? out : null;
}

/** A build worth watching: not finished. */
export function isActive(build) {
  return Boolean(build) && build.finished !== true;
}

/**
 * Decide which discovered builds to start watching.
 * Excludes anything already watched, anything in the first-run baseline, and
 * anything the user explicitly unwatched.
 * @returns {{toWatch: Array, baseline: string[]}} baseline is the pruned set.
 */
export function diffDiscovered(builds, { watched = [], baseline = [], dismissed = [], cap = 25 } = {}) {
  const active = (builds ?? []).filter(isActive);
  const activeUrls = new Set(active.map((b) => b.url));
  const watchedSet = new Set(watched);
  const baselineSet = new Set(baseline);
  const dismissedSet = new Set(dismissed);

  const toWatch = active
    .filter((b) => !watchedSet.has(b.url) && !baselineSet.has(b.url) && !dismissedSet.has(b.url))
    .slice(0, Math.max(0, cap));

  // Drop baseline entries whose build has left the listing, so it cannot grow
  // without bound and a rebuilt number is not suppressed forever.
  const prunedBaseline = [...baselineSet].filter((u) => activeUrls.has(u));

  return { toWatch, baseline: prunedBaseline, activeCount: active.length };
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

async function jsonListProvider({ fetchImpl }) {
  const errors = [];
  for (const path of LIST_PATHS) {
    try {
      const res = await fetchImpl(`https://${HOSTS[0]}${path}`, {
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
        headers: { Accept: 'application/json' },
      });
      if (classifyResponse(res) === 'auth') throw new ProviderError('json: not signed in', 'auth');
      if (!res.ok) { errors.push(`${path} HTTP ${res.status}`); continue; }
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('json')) { errors.push(`${path} content-type ${ct.split(';')[0]}`); continue; }
      const body = await res.json();
      const builds = parseBuildList(body);
      if (builds && builds.length) return builds;
      const keys = body && typeof body === 'object' && !Array.isArray(body)
        ? Object.keys(body).slice(0, 12).join(',') : (Array.isArray(body) ? 'array' : typeof body);
      errors.push(`${path} no builds (keys: ${keys})`);
    } catch (err) {
      if (err?.code === 'auth') throw err;
      errors.push(`${path} ${err?.message ?? err}`);
    }
  }
  throw new ProviderError(`json: ${errors.join('; ')}`, 'shape');
}

async function htmlListProvider({ fetchImpl }) {
  const res = await fetchImpl(`https://${HOSTS[0]}/builds`, {
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
    headers: { Accept: 'text/html' },
  });
  if (classifyResponse(res) === 'auth') throw new ProviderError('html: not signed in', 'auth');
  if (!res.ok) throw new ProviderError(`html: HTTP ${res.status}`, 'http');
  const builds = extractBuildsFromHtml(await res.text());
  if (!builds) throw new ProviderError('html: no build links found', 'shape');
  return builds;
}

async function tabListProvider({ listProbe }) {
  if (typeof listProbe !== 'function') throw new ProviderError('tab: no probe available', 'unavailable');
  const builds = await listProbe();
  if (!builds || !builds.length) throw new ProviderError('tab: no open buildkite tab listed any build', 'unavailable');
  return builds;
}

const LIST_PROVIDERS = [
  { name: 'json', run: jsonListProvider },
  { name: 'html', run: htmlListProvider },
  { name: 'tab', run: tabListProvider },
];

/**
 * Fetch the user's build listing.
 * @returns {Promise<{builds: Array, provider: string}>}
 */
export async function fetchBuildList(deps = {}) {
  const resolved = { fetchImpl: deps.fetchImpl ?? globalThis.fetch, listProbe: deps.listProbe };
  const preferred = deps.provider;
  const ordered = preferred
    ? [...LIST_PROVIDERS.filter((p) => p.name === preferred), ...LIST_PROVIDERS.filter((p) => p.name !== preferred)]
    : LIST_PROVIDERS;
  const failures = [];
  for (const p of ordered) {
    try {
      const builds = await p.run(resolved);
      return { builds, provider: p.name };
    } catch (err) {
      failures.push(err ?? new Error(`${p.name}: failed`));
    }
  }
  const code = resolveCode(failures);
  const messages = failures.map((f) => f?.message ?? String(f));
  const e = new ProviderError(
    code === 'auth' ? 'not signed in to Buildkite' : `all list providers failed (${messages.join('; ')})`,
    code,
  );
  e.errors = messages;
  throw e;
}
