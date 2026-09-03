const DEFAULT_VOLUME = 0.6;

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (reply) => {
      if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
      else resolve(reply);
    });
  });
}

// Buildkite's own state names are an implementation detail. Surface the raw
// value only when it did not map to something we recognise — then it is the
// one thing worth reporting; otherwise it is noise.
function stateLabel(w) {
  if (!w.prev) return 'checking…';
  if (w.prev.blocked) return 'blocked, needs input';
  if (w.prev.unknownFinish && w.prev.rawState) return `finished as "${w.prev.rawState}"`;
  if (w.prev.state === 'unknown' && w.prev.rawState) return `unrecognised state "${w.prev.rawState}"`;
  return w.prev.state;
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

const OUTCOME = {
  success: { label: 'passed', verb: 'Passed' },
  failure: { label: 'failed', verb: 'Failed' },
  input: { label: 'needs input', verb: 'Needed input' },
};

function renderRecent(recent) {
  const section = document.getElementById('recent-section');
  const ul = document.getElementById('recent');
  section.hidden = recent.length === 0;
  ul.textContent = '';

  for (const r of recent) {
    const li = document.createElement('li');

    const dot = document.createElement('span');
    dot.className = `dot ${r.event}`;
    li.appendChild(dot);

    const info = document.createElement('div');
    info.className = 'info';

    const name = document.createElement('div');
    name.className = 'name';
    const a = document.createElement('a');
    a.href = r.url;
    a.target = '_blank';
    a.className = 'truncate';
    a.textContent = `${r.pipeline} #${r.number}`;
    a.title = `${r.org}/${r.pipeline} #${r.number}`;
    name.appendChild(a);
    info.appendChild(name);

    const outcome = document.createElement('div');
    outcome.className = `outcome ${r.event}`;
    const what = r.unknownFinish && r.rawState
      ? `Finished as "${r.rawState}"`
      : (OUTCOME[r.event]?.verb ?? r.state);
    outcome.textContent = `${what} · ${ago(r.at)}`;
    info.appendChild(outcome);

    li.appendChild(info);
    ul.appendChild(li);
  }
}

function renderDiscovery(settings, discovery, signedOut) {
  const box = document.getElementById('discovery');
  const status = document.getElementById('discovery-status');
  const on = settings.discovery !== false;
  box.setAttribute('aria-checked', String(on));

  if (!on) {
    status.className = 'footnote';
    status.textContent = 'Off — only builds you add by hand are watched.';
    return;
  }
  if (signedOut || discovery.code === 'auth') {
    status.className = 'footnote';
    status.textContent = 'Paused until you sign in to Buildkite.';
    return;
  }
  if (discovery.error) {
    status.className = 'footnote is-error';
    status.textContent = `Could not read your builds: ${discovery.error}`;
    return;
  }
  status.className = 'footnote';
  if (!discovery.provider) {
    status.textContent = 'Looking for your builds…';
    return;
  }
  const found = discovery.found ?? 0;
  const parts = [`${found} running build${found === 1 ? '' : 's'} found`];
  if (discovery.capped) parts.push('cap reached');
  parts.push(`via ${discovery.provider}`);
  parts.push(`checked ${ago(discovery.at)}`);
  status.textContent = parts.join(' · ');
}

async function renderWatches() {
  const { watches = [], recent = [], settings = {}, discovery = {}, auth = {} } = await send({ type: 'LIST' });
  const signedOut = Boolean(auth.signedOut);
  document.getElementById('signed-out').hidden = !signedOut;
  renderDiscovery(settings, discovery, signedOut);
  renderRecent(recent);
  const ul = document.getElementById('watches');
  const empty = document.getElementById('empty');
  ul.textContent = '';
  empty.hidden = watches.length > 0;

  for (const w of watches) {
    const li = document.createElement('li');

    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    const a = document.createElement('a');
    a.href = w.url;
    a.target = '_blank';
    a.className = 'truncate';
    a.textContent = `${w.pipeline} #${w.number}`;
    a.title = `${w.org}/${w.pipeline} #${w.number}`;
    name.appendChild(a);
    if (w.source === 'auto') {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'auto';
      tag.title = 'Picked up automatically because you triggered it';
      name.appendChild(tag);
    }
    info.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'meta' + (w.lastError ? ' is-error' : '');
    if (w.errorCode === 'auth') {
      meta.textContent = `${w.org} · paused, not signed in`;
    } else if (w.lastError) {
      meta.textContent = `${w.org} · could not check (${ago(w.lastChecked)})`;
      meta.title = w.lastError;
    } else {
      meta.textContent = `${w.org} · ${stateLabel(w)} · checked ${ago(w.lastChecked)}`;
    }
    info.appendChild(meta);
    li.appendChild(info);

    const btn = document.createElement('button');
    btn.className = 'compact';
    btn.textContent = 'Unwatch';
    btn.addEventListener('click', async () => {
      await send({ type: 'UNWATCH', url: w.url });
      renderWatches();
    });
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

async function initVolume() {
  const slider = document.getElementById('volume');
  const label = document.getElementById('volume-label');
  const { volume = DEFAULT_VOLUME } = await chrome.storage.local.get('volume');
  slider.value = volume;
  label.textContent = `${Math.round(volume * 100)}%`;
  slider.addEventListener('input', () => {
    label.textContent = `${Math.round(slider.value * 100)}%`;
  });
  slider.addEventListener('change', async () => {
    await chrome.storage.local.set({ volume: Number(slider.value) });
  });
}

for (const btn of document.querySelectorAll('[data-chime]')) {
  btn.addEventListener('click', () => send({ type: 'TEST_CHIME', kind: btn.dataset.chime }));
}

document.getElementById('diagnostics').addEventListener('click', async (e) => {
  const link = e.currentTarget;
  link.textContent = 'Collecting…';
  const { report, error } = await send({ type: 'DIAGNOSTICS' });
  if (!report) {
    link.textContent = `Failed: ${error ?? 'unknown'}`;
    return;
  }
  try {
    await navigator.clipboard.writeText(report);
    link.textContent = 'Copied — paste into an issue';
  } catch {
    // Clipboard can be refused in a popup; fall back to a console dump.
    console.log(report);
    link.textContent = 'See the popup console';
  }
  setTimeout(() => { link.textContent = 'Copy diagnostics'; }, 4000);
});

document.getElementById('discovery').addEventListener('click', async (e) => {
  const box = e.currentTarget;
  const next = box.getAttribute('aria-checked') !== 'true';
  box.setAttribute('aria-checked', String(next)); // move now, reconcile after
  await send({ type: 'SET_DISCOVERY', enabled: next });
  renderWatches();
});

document.getElementById('clear-recent').addEventListener('click', async () => {
  await send({ type: 'CLEAR_RECENT' });
  renderWatches();
});

document.getElementById('refresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.classList.add('is-busy');
  await send({ type: 'POLL_NOW' });
  btn.classList.remove('is-busy');
  renderWatches();
});

function showVersion() {
  const m = chrome.runtime.getManifest();
  const el = document.getElementById('version');
  el.textContent = `Version ${m.version}`;
  el.title = `${m.name} ${m.version} — reload the extension after pulling changes`;
}

showVersion();
renderWatches();
initVolume();
setInterval(renderWatches, 5000);
