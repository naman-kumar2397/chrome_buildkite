// Service worker: owns the watch list, polls Buildkite, and fires chimes +
// notifications on state transitions.

import { fetchStatus, decideEvent, parseBuildUrl, describe, classifyResponse, pickBuild } from './status.js';
import { fetchBuildList, diffDiscovered, pickList, parseBuildList, extractBuildsFromHtml } from './discovery.js';

const ALARM = 'bk-poll';
const DISCOVER_ALARM = 'bk-discover';
const POLL_MINUTES = 0.5; // Chrome's minimum alarm period (Chrome >= 120)
const DISCOVER_MINUTES = 1;
const DEFAULT_SETTINGS = { discovery: true, autoWatchCap: 25 };
const AUTH_BACKOFF_CYCLES = 10; // signed out: poll every 10th cycle (~5 min)
const DEFAULT_VOLUME = 0.6;

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getWatches() {
  const { watches = {} } = await chrome.storage.local.get('watches');
  return watches;
}

/**
 * Remember whether the session looks signed out, so the UI can say so plainly
 * and polling can back off instead of hammering a login redirect.
 */
async function setAuthState(signedOut) {
  const { auth = {} } = await chrome.storage.local.get('auth');
  if (Boolean(auth.signedOut) === Boolean(signedOut)) return;
  await chrome.storage.local.set({ auth: { signedOut: Boolean(signedOut), at: Date.now() } });
  if (signedOut) console.warn('[bk-watcher] not signed in to Buildkite — backing off');
  else console.info('[bk-watcher] Buildkite session is back');
}

async function isSignedOut() {
  const { auth = {} } = await chrome.storage.local.get('auth');
  return Boolean(auth.signedOut);
}

/** While signed out, only poll every Nth cycle rather than every 30s. */
async function shouldSkipCycle() {
  if (!await isSignedOut()) return false;
  const { authTick = 0 } = await chrome.storage.local.get('authTick');
  const next = (authTick + 1) % AUTH_BACKOFF_CYCLES;
  await chrome.storage.local.set({ authTick: next });
  return next !== 0;
}

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function saveWatches(watches) {
  await chrome.storage.local.set({ watches });
  await updateBadge(watches);
  await ensureAlarm(watches);
  await ensureDiscoveryAlarm();
}

const RECENT_LIMIT = 12;

/** Record a chimed event so the popup can show what just happened. */
async function recordRecent(event, watch, status) {
  const { recent = [] } = await chrome.storage.local.get('recent');
  const entry = {
    url: watch.url,
    org: watch.org,
    pipeline: watch.pipeline,
    number: watch.number,
    event,
    state: status.state,
    rawState: status.rawState,
    unknownFinish: status.unknownFinish === true,
    at: Date.now(),
  };
  const next = [entry, ...recent.filter((r) => !(r.url === entry.url && r.event === entry.event))].slice(0, RECENT_LIMIT);
  await chrome.storage.local.set({ recent: next });
}

async function updateBadge(watches) {
  const n = Object.keys(watches).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#14CC80' });
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
}

async function ensureDiscoveryAlarm() {
  const { discovery } = await getSettings();
  const existing = await chrome.alarms.get(DISCOVER_ALARM);
  if (discovery && !existing) {
    await chrome.alarms.create(DISCOVER_ALARM, { periodInMinutes: DISCOVER_MINUTES, delayInMinutes: 0.1 });
  } else if (!discovery && existing) {
    await chrome.alarms.clear(DISCOVER_ALARM);
  }
}

async function ensureAlarm(watches) {
  const hasWatches = Object.keys(watches).length > 0;
  const existing = await chrome.alarms.get(ALARM);
  if (hasWatches && !existing) {
    await chrome.alarms.create(ALARM, { periodInMinutes: POLL_MINUTES, delayInMinutes: POLL_MINUTES });
  } else if (!hasWatches && existing) {
    await chrome.alarms.clear(ALARM);
  }
}

// ---------------------------------------------------------------------------
// Status lookup (with the open-tab DOM as the last-resort provider)
// ---------------------------------------------------------------------------

async function domProbe(watch) {
  const tabs = await chrome.tabs.query({ url: `${watch.url}*` });
  for (const tab of tabs) {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: 'DOM_STATUS' });
      if (reply && reply.state && reply.state !== 'unknown') return reply;
    } catch {
      // tab has no content script (e.g. discarded) — try the next one
    }
  }
  return null;
}

function lookupStatus(watch) {
  return fetchStatus(watch, { domProbe });
}

/** The part of a status worth persisting as the baseline for the next poll. */
function snapshot(status) {
  const prev = { state: status.state, blocked: status.blocked, finished: status.finished };
  if (status.rawState) prev.rawState = status.rawState;
  if (status.unknownFinish) prev.unknownFinish = true;
  return prev;
}

// ---------------------------------------------------------------------------
// Chimes (offscreen document) and notifications
// ---------------------------------------------------------------------------

let creatingOffscreen = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length > 0) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Play a chime when a watched Buildkite build finishes or needs input.',
      })
      .finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function chime(kind) {
  await ensureOffscreen();
  const { volume = DEFAULT_VOLUME } = await chrome.storage.local.get('volume');
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'PLAY', kind, volume });
}

const TITLES = {
  success: 'Build passed',
  failure: 'Build failed',
  input: 'Build needs your input',
};

async function notify(kind, watch, status) {
  const label = `${watch.pipeline} #${watch.number}`;
  const detail = status.state === 'canceled' && !status.unknownFinish
    ? 'Build was canceled.'
    : `Build ${describe(status)}.`;
  await chrome.notifications.create(watch.url, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `${TITLES[kind]} — ${label}`,
    message: `${detail} Click to open.`,
    priority: 2,
    requireInteraction: kind === 'input',
  });
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (parseBuildUrl(notificationId)) {
    await chrome.tabs.create({ url: notificationId });
  }
  chrome.notifications.clear(notificationId);
});

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

let polling = null;

async function pollAll() {
  if (polling) return polling;
  polling = (async () => {
    const watches = await getWatches();
    const urls = Object.keys(watches);
    if (urls.length === 0) {
      await ensureAlarm(watches);
      return;
    }
    if (await shouldSkipCycle()) return;
    let changed = false;
    let sawAuthFailure = false;
    let sawSuccess = false;
    for (const url of urls) {
      const watch = watches[url];
      try {
        // Discovery just saw this build in the listing; reuse that instead of
        // fetching it again.
        const fresh = watch.listState && Date.now() - (watch.listSeenAt ?? 0) < 45000
          ? { ...watch.listState, provider: 'list' }
          : null;
        delete watch.listState;
        delete watch.listSeenAt;
        const status = fresh ?? await lookupStatus(watch);
        sawSuccess = true;
        const event = decideEvent(watch.prev, status);
        watch.prev = snapshot(status);
        if (status.provider !== 'list') watch.provider = status.provider;
        watch.lastChecked = Date.now();
        watch.lastError = null;
        changed = true;
        if (event) {
          console.info(`[bk-watcher] ${watch.pipeline} #${watch.number}: ${event} via ${status.provider}`);
          await recordRecent(event, watch, status);
          await Promise.allSettled([chime(event), notify(event, watch, status)]);
          if (event !== 'input') delete watches[url];
        }
      } catch (err) {
        if (err?.code === 'auth') sawAuthFailure = true;
        watch.lastChecked = Date.now();
        watch.lastError = err?.message ?? String(err);
        watch.errorCode = err?.code ?? null;
        watch.errorCount = (watch.errorCount || 0) + 1;
        changed = true;
        console.warn(`[bk-watcher] ${watch.pipeline} #${watch.number}: ${watch.lastError}`);
      }
    }
    if (sawSuccess) await setAuthState(false);
    else if (sawAuthFailure) await setAuthState(true);
    if (changed) await saveWatches(watches);
  })().finally(() => { polling = null; });
  return polling;
}

// ---------------------------------------------------------------------------
// Discovery: auto-watch the signed-in user's own builds
// ---------------------------------------------------------------------------

let discovering = null;

/** Ask any open buildkite.com tab for the builds it can see (last-resort provider). */
async function listProbe() {
  const tabs = await chrome.tabs.query({ url: 'https://buildkite.com/*' });
  for (const tab of tabs) {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: 'DOM_BUILD_LIST' });
      if (Array.isArray(reply?.builds) && reply.builds.length) return reply.builds;
    } catch {
      // no content script in that tab
    }
  }
  return null;
}

async function setDiscoveryState(patch) {
  const { discoveryState = {} } = await chrome.storage.local.get('discoveryState');
  const next = { ...discoveryState, ...patch, at: Date.now() };
  await chrome.storage.local.set({ discoveryState: next });
  return next;
}

async function discoverBuilds() {
  if (discovering) return discovering;
  discovering = (async () => {
    const settings = await getSettings();
    if (!settings.discovery) return;
    if (await shouldSkipCycle()) return;

    const stored = await chrome.storage.local.get(['discoveryState', 'baseline', 'dismissed', 'recent']);
    const state = stored.discoveryState ?? {};
    // Recently chimed builds count as dismissed: if the listing is a cycle
    // behind and still shows one as running, it must not be picked up again.
    const dismissed = [...(stored.dismissed ?? []), ...(stored.recent ?? []).map((r) => r.url)];
    const firstRun = !Array.isArray(stored.baseline);

    let builds;
    let provider;
    try {
      ({ builds, provider } = await fetchBuildList({ provider: state.provider, listProbe }));
    } catch (err) {
      if (err?.code === 'auth') await setAuthState(true);
      await setDiscoveryState({ error: err?.message ?? String(err), code: err?.code ?? null });
      console.warn('[bk-watcher] discovery failed:', err?.message ?? err);
      return;
    }
    await setAuthState(false);

    const watches = await getWatches();

    // First run: remember what is already in flight and watch none of it, so
    // enabling discovery never produces a burst of chimes for known builds.
    if (firstRun) {
      const baseline = builds.filter((b) => !b.finished).map((b) => b.url);
      await chrome.storage.local.set({ baseline });
      await setDiscoveryState({ provider, error: null, found: baseline.length, watchedThisCycle: 0 });
      console.info(`[bk-watcher] discovery baseline: ignoring ${baseline.length} in-flight build(s)`);
      return;
    }

    const { toWatch, baseline, activeCount } = diffDiscovered(builds, {
      watched: Object.keys(watches),
      baseline: stored.baseline,
      dismissed,
      cap: settings.autoWatchCap,
    });
    await chrome.storage.local.set({ baseline });

    // The listing carries state for every build, so refresh the watches it
    // covers here and let them skip their own fetch this cycle.
    let changed = false;
    for (const build of builds) {
      const watch = watches[build.url];
      if (!watch) continue;
      watch.listState = snapshot(build);
      watch.listSeenAt = Date.now();
      changed = true;
    }

    for (const build of toWatch) {
      watches[build.url] = {
        org: build.org,
        pipeline: build.pipeline,
        number: build.number,
        url: build.url,
        prev: snapshot(build),
        provider: undefined,
        source: 'auto',
        addedAt: Date.now(),
        lastChecked: null,
        lastError: null,
      };
      changed = true;
    }
    if (changed) await saveWatches(watches);

    await setDiscoveryState({
      provider,
      error: null,
      found: activeCount,
      watchedThisCycle: toWatch.length,
      capped: toWatch.length >= settings.autoWatchCap,
    });

    // One acknowledgement per cycle, however many builds arrived together.
    if (toWatch.length) {
      const names = toWatch.map((b) => `${b.pipeline} #${b.number}`);
      console.info(`[bk-watcher] auto-watching ${names.join(', ')}`);
      const label = names.length === 1
        ? `Watching ${names[0]}`
        : `Watching ${names.length} builds`;
      await Promise.allSettled([
        chime('watching'),
        chrome.notifications.create(toWatch[0].url, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: label,
          message: names.length === 1
            ? 'Started automatically. You will hear a chime when it finishes.'
            : `${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}`,
          priority: 0,
        }),
      ]);
    }
  })().finally(() => { discovering = null; });
  return discovering;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) pollAll();
  else if (alarm.name === DISCOVER_ALARM) discoverBuilds();
});

// ---------------------------------------------------------------------------
// Diagnostics: probe every endpoint and report what came back, redacted so the
// result can be pasted into a public issue.
// ---------------------------------------------------------------------------

/** Stable pseudonyms, so the same org reads the same way throughout a report. */
function makeRedactor() {
  const orgs = new Map();
  const pipelines = new Map();
  const label = (map, value, prefix) => {
    if (!value) return value;
    if (!map.has(value)) map.set(value, `${prefix}-${map.size + 1}`);
    return map.get(value);
  };
  return (text) => String(text ?? '').replace(
    /https:\/\/buildkite\.com\/([\w.-]+)(?:\/([\w.-]+))?/g,
    (_m, org, pipeline) => `https://buildkite.com/${label(orgs, org, 'org')}${pipeline ? `/${label(pipelines, pipeline, 'pipeline')}` : ''}`,
  );
}

async function probe(url, accept) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      credentials: 'include', cache: 'no-store', redirect: 'follow', headers: { Accept: accept },
    });
    const ct = (res.headers.get('content-type') || '').split(';')[0];
    const row = {
      url, status: res.status, contentType: ct, redirectedTo: res.url === url ? null : res.url,
      classified: classifyResponse(res), ms: Date.now() - started,
    };
    if (ct.includes('json')) {
      try {
        const body = await res.json();
        row.jsonTop = Array.isArray(body) ? `array(${body.length})` : Object.keys(body).slice(0, 30).join(',');
        const list = pickList(body);
        if (Array.isArray(list)) {
          row.listCount = list.length;
          row.itemKeys = list[0] ? Object.keys(list[0]).slice(0, 30).join(',') : null;
          row.parsedBuilds = (parseBuildList(body) ?? []).length;
        }
        const build = pickBuild(body);
        if (build) row.buildState = `${build.state}${build.blocked_state ? ` / blocked_state=${build.blocked_state}` : ''}`;
      } catch (err) { row.jsonError = err?.message ?? String(err); }
    } else {
      const text = await res.text();
      row.bytes = text.length;
      row.htmlBuilds = (extractBuildsFromHtml(text) ?? []).length;
    }
    return row;
  } catch (err) {
    return { url, error: err?.message ?? String(err), ms: Date.now() - started };
  }
}

async function collectDiagnostics() {
  const manifest = chrome.runtime.getManifest();
  const watches = await getWatches();
  const sample = Object.values(watches)[0];
  const { auth = {}, discoveryState = {}, baseline = [], dismissed = [] } = await chrome.storage.local.get(
    ['auth', 'discoveryState', 'baseline', 'dismissed'],
  );

  const rows = [];
  for (const path of ['/builds.json', '/builds.json?filter=mine', '/builds']) {
    rows.push(await probe(`https://buildkite.com${path}`, path.endsWith('.json') || path.includes('.json?')
      ? 'application/json' : 'text/html'));
  }
  if (sample) {
    rows.push(await probe(`${sample.url}.json`, 'application/json'));
    rows.push(await probe(sample.url, 'text/html'));
  }

  const redact = makeRedactor();
  const lines = [
    '### Buildkite Build Watcher diagnostics',
    '',
    `- extension: ${manifest.version}`,
    `- user agent: ${navigator.userAgent}`,
    `- signed out: ${Boolean(auth.signedOut)}`,
    `- discovery: provider=${discoveryState.provider ?? 'none'} found=${discoveryState.found ?? 0} error=${discoveryState.error ? redact(discoveryState.error) : 'none'}`,
    `- watches: ${Object.keys(watches).length} (baseline ${baseline.length}, dismissed ${dismissed.length})`,
    sample ? `- sample build probed: yes (${sample.source ?? 'manual'})` : '- sample build probed: no watches',
    '',
    '```',
    ...rows.map((r) => redact(JSON.stringify(r))),
    '```',
    '',
    '_Org and pipeline names are replaced with placeholders. No cookies or tokens are included._',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Messages from the content script and popup
// ---------------------------------------------------------------------------

async function handleMessage(msg) {
  switch (msg?.type) {
    case 'GET_STATUS': {
      const parsed = parseBuildUrl(msg.url);
      if (!parsed) return { error: 'not a build url' };
      const watches = await getWatches();
      const watched = Boolean(watches[parsed.url]);
      try {
        const status = await lookupStatus({ ...parsed, provider: watches[parsed.url]?.provider });
        return { ...parsed, ...status, watched };
      } catch (err) {
        return { ...parsed, state: 'unknown', blocked: false, finished: false, watched, error: err.message };
      }
    }
    case 'WATCH': {
      const parsed = parseBuildUrl(msg.url);
      if (!parsed) return { error: 'not a build url' };
      const watches = await getWatches();
      if (!watches[parsed.url]) {
        let prev = null;
        let provider;
        try {
          const status = await lookupStatus(parsed);
          prev = snapshot(status);
          provider = status.provider;
        } catch {
          // Unknown baseline: first successful poll will decide the event.
        }
        watches[parsed.url] = {
          ...parsed, prev, provider, source: 'manual', addedAt: Date.now(), lastChecked: null, lastError: null,
        };
        // A build watched by hand should not be suppressed if it is later
        // rediscovered, so clear any dismissal.
        const { dismissed = [] } = await chrome.storage.local.get('dismissed');
        if (dismissed.includes(parsed.url)) {
          await chrome.storage.local.set({ dismissed: dismissed.filter((u) => u !== parsed.url) });
        }
        await saveWatches(watches);
      }
      return { ok: true, watch: watches[parsed.url] };
    }
    case 'UNWATCH': {
      const parsed = parseBuildUrl(msg.url);
      if (!parsed) return { error: 'not a build url' };
      const watches = await getWatches();
      const wasAuto = watches[parsed.url]?.source === 'auto';
      delete watches[parsed.url];
      await saveWatches(watches);
      // Remember the dismissal so the next discovery cycle does not re-add it.
      if (wasAuto) {
        const { dismissed = [] } = await chrome.storage.local.get('dismissed');
        if (!dismissed.includes(parsed.url)) {
          await chrome.storage.local.set({ dismissed: [parsed.url, ...dismissed].slice(0, 200) });
        }
      }
      return { ok: true };
    }
    case 'LIST': {
      const watches = await getWatches();
      const { recent = [], discoveryState = {}, auth = {} } = await chrome.storage.local.get(
        ['recent', 'discoveryState', 'auth'],
      );
      const settings = await getSettings();
      return {
        watches: Object.values(watches).sort((a, b) => b.addedAt - a.addedAt),
        recent,
        settings,
        discovery: discoveryState,
        auth,
      };
    }
    case 'SET_DISCOVERY': {
      const settings = await getSettings();
      const next = { ...settings, discovery: Boolean(msg.enabled) };
      await chrome.storage.local.set({ settings: next });
      await ensureDiscoveryAlarm();
      if (next.discovery) {
        // Re-baseline on enable so switching it back on is never a chime burst.
        await chrome.storage.local.remove('baseline');
        discoverBuilds();
      }
      return { ok: true, settings: next };
    }
    case 'DISCOVER_NOW': {
      await discoverBuilds();
      const { discoveryState = {} } = await chrome.storage.local.get('discoveryState');
      return { ok: true, discovery: discoveryState };
    }
    case 'CLEAR_RECENT': {
      await chrome.storage.local.set({ recent: [] });
      return { ok: true };
    }
    case 'POLL_NOW': {
      await Promise.allSettled([pollAll(), discoverBuilds()]);
      return { ok: true };
    }
    case 'DIAGNOSTICS': {
      return { report: await collectDiagnostics() };
    }
    case 'TEST_CHIME': {
      await chime(msg.kind);
      return { ok: true };
    }
    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false; // not for us
  handleMessage(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err?.message ?? String(err) }));
  return true; // keep the channel open for the async response
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function init() {
  const watches = await getWatches();
  await updateBadge(watches);
  await ensureAlarm(watches);
  await ensureDiscoveryAlarm();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
init();
