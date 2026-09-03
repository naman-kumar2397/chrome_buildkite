// Content script: detects a Buildkite build page, shows the "Watch this build"
// banner, and answers DOM-status probes from the service worker.

(() => {
  const BUILD_PATH = /^\/([^/]+)\/([^/]+)\/builds\/(\d+)(?:[/?#]|$)/;
  const BANNER_ID = 'bk-build-watcher-banner';
  const AUTO_HIDE_MS = 20000;
  const KNOWN_STATES = [
    'passed', 'failed', 'failing', 'running', 'blocked', 'canceled', 'canceling',
    'scheduled', 'waiting', 'waiting_failed', 'skipped', 'not_run', 'creating',
  ];
  const ALIASES = { started: 'running', cancelling: 'canceling', cancelled: 'canceled' };

  let currentUrl = null;
  let hideTimer = null;

  function parseLocation() {
    const m = BUILD_PATH.exec(location.pathname);
    if (!m) return null;
    return {
      org: m[1],
      pipeline: m[2],
      number: Number(m[3]),
      url: `${location.origin}/${m[1]}/${m[2]}/builds/${m[3]}`,
    };
  }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (reply) => {
          if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
          else resolve(reply);
        });
      } catch (err) {
        resolve({ error: err.message });
      }
    });
  }

  // -------------------------------------------------------------------------
  // DOM status heuristics (last-resort provider for the service worker)
  // -------------------------------------------------------------------------

  function domStatus() {
    const stateRe = new RegExp(`\\b(${KNOWN_STATES.join('|')})\\b`, 'i');

    // The build header shows e.g. "Running for 11m 2s", "Passed in 5m", "Failed after 2m".
    const bodyText = (document.body?.innerText || '').slice(0, 4000);
    const headerMatch = /\b(Running|Started|Passed|Failed|Failing|Blocked|Canceled|Cancelled|Canceling|Cancelling|Scheduled|Waiting|Skipped)\s+(?:for|in|after)\b/i.exec(bodyText);
    if (headerMatch) {
      const s = ALIASES[headerMatch[1].toLowerCase()] || headerMatch[1].toLowerCase();
      return { state: s, blocked: s === 'blocked' || hasUnblockButton() };
    }
    if (/\bBlocked\b/.test(bodyText) && hasUnblockButton()) return { state: 'blocked', blocked: true };

    const attrEl = document.querySelector('[data-build-state],[data-state]');
    if (attrEl) {
      const v = (attrEl.getAttribute('data-build-state') || attrEl.getAttribute('data-state') || '').toLowerCase();
      if (KNOWN_STATES.includes(v)) return { state: v, blocked: v === 'blocked' || hasUnblockButton() };
    }

    for (const el of document.querySelectorAll('[class*="build-state"],[class*="build--"],[class*="state-"]')) {
      const m = stateRe.exec(el.className);
      if (m) return { state: m[1].toLowerCase(), blocked: m[1].toLowerCase() === 'blocked' || hasUnblockButton() };
    }

    const titleMatch = stateRe.exec(document.title);
    if (titleMatch) {
      const s = titleMatch[1].toLowerCase();
      return { state: s, blocked: s === 'blocked' || hasUnblockButton() };
    }

    const header = document.querySelector('main h1, header h1, h1');
    if (header) {
      const m = stateRe.exec(header.textContent || '');
      if (m) return { state: m[1].toLowerCase(), blocked: m[1].toLowerCase() === 'blocked' || hasUnblockButton() };
    }

    if (hasUnblockButton()) return { state: 'blocked', blocked: true };
    return { state: 'unknown', blocked: false };
  }

  function hasUnblockButton() {
    for (const b of document.querySelectorAll('button, a[role="button"]')) {
      if (/\bunblock\b/i.test(b.textContent || '')) return true;
    }
    return false;
  }

  /**
   * Builds visible on this page (the /builds listing or the My Builds menu).
   * Last-resort provider for discovery when the JSON and HTML fetches fail.
   */
  function domBuildList() {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/builds/"]')) {
      const m = BUILD_PATH.exec(new URL(a.getAttribute('href'), location.origin).pathname);
      if (!m) continue;
      const url = `${location.origin}/${m[1]}/${m[2]}/builds/${m[3]}`;
      if (seen.has(url)) continue;
      seen.add(url);
      const row = a.closest('li, tr, article, section') || a.parentElement;
      const text = `${row?.className || ''} ${row?.textContent || ''}`;
      const state = new RegExp(`\\b(${KNOWN_STATES.join('|')}|started)\\b`, 'i').exec(text);
      out.push({ org: m[1], pipeline: m[2], number: Number(m[3]), url, state: state ? state[1].toLowerCase() : 'unknown' });
    }
    return out;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'DOM_STATUS') {
      sendResponse(domStatus());
      return false;
    }
    if (msg?.type === 'DOM_BUILD_LIST') {
      sendResponse({ builds: domBuildList() });
      return false;
    }
    return false;
  });

  // -------------------------------------------------------------------------
  // Banner
  // -------------------------------------------------------------------------

  // Apple tokens live on :root; inside a shadow root that selector never
  // matches, so the same generated files are re-scoped to :host. Fetching them
  // keeps one source of truth rather than duplicating the values here.
  let tokenCss = null;
  async function loadTokens() {
    if (tokenCss !== null) return tokenCss;
    try {
      const files = ['vendor/apple.css', 'vendor/motion.css'];
      const texts = await Promise.all(
        files.map((f) => fetch(chrome.runtime.getURL(f)).then((r) => r.text())),
      );
      tokenCss = texts.join('\n').replace(/:root/g, ':host');
    } catch {
      tokenCss = '';
    }
    return tokenCss;
  }

  const CSS = `
    :host {
      all: initial;
      --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI",
                 system-ui, ui-sans-serif, Roboto, "Helvetica Neue", Arial, sans-serif;
      --surface-opaque: #1E1E20;
    }

    /* The banner is a floating control over page content — the one place the
       HIG puts Liquid Glass. It samples the Buildkite page behind it, which is
       what the material needs in order to read as glass at all. */
    .bar {
      position: fixed;
      top: 14px;
      left: 50%;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 11px;
      max-width: min(620px, calc(100vw - 32px));
      padding: 9px 9px 9px 15px;
      border-radius: 999px;

      background: color-mix(in srgb, #FFFFFF 10%, transparent);
      backdrop-filter: blur(20px) saturate(180%);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      border: 1px solid color-mix(in srgb, white 16%, transparent);
      box-shadow:
        inset 0 1px 0 color-mix(in srgb, white 40%, transparent),
        inset 0 -1px 0 color-mix(in srgb, black 6%, transparent),
        0 8px 32px -12px rgb(0 0 0 / 0.35);

      color: #fff;
      font-family: var(--font-ui);
      font-size: 14px;
      line-height: 19px;
      letter-spacing: -0.012em;

      transform: translate(-50%, 0);
      animation: enter var(--dur-lively, 433ms) var(--ease-lively, ease-out) both;
    }

    /* A floating overlay must contrast with the page behind it, not with the
       OS appearance: Buildkite renders dark whatever the system is set to. The
       host is stamped with the measured luminance of the page instead. */
    :host([data-behind="light"]) .bar {
      background: color-mix(in srgb, #000000 6%, transparent);
      border-color: color-mix(in srgb, black 10%, transparent);
      color: #10131A;
      box-shadow:
        inset 0 1px 0 color-mix(in srgb, white 70%, transparent),
        inset 0 -1px 0 color-mix(in srgb, black 5%, transparent),
        0 8px 32px -12px rgb(0 0 0 / 0.28);
    }
    :host([data-behind="light"]) .state { opacity: .62; }

    @keyframes enter {
      from { opacity: 0; transform: translate(-50%, -14px) scale(0.97); }
      to   { opacity: 1; transform: translate(-50%, 0) scale(1); }
    }

    @media (prefers-reduced-transparency: reduce) {
      .bar { backdrop-filter: none; background: var(--surface-opaque); }
    }
    @supports not (backdrop-filter: blur(1px)) {
      .bar { background: var(--surface-opaque); }
    }

    /* Small text takes the increased-contrast tier in every appearance; the
       default tier is for fills and marks. --sys-green on a light ground is
       2.2:1, which fails AA outright. */
    :host { --text-green: #4AD968; --text-blue: #5CB8FF; }
    :host([data-behind="light"]) { --text-green: #008932; --text-blue: #1E6EF4; }

    .bell { display: flex; flex: 0 0 auto; color: var(--sys-orange, #FF8D28); }
    .text { flex: 1; min-width: 0; }
    .text b { font-weight: 600; }
    .state { opacity: .72; }
    .watching { color: var(--text-green); font-weight: 600; }

    button {
      font: inherit;
      letter-spacing: inherit;
      cursor: pointer;
      border: 0;
      flex: 0 0 auto;
    }

    /* Icon + text is a capsule; the primary action carries the only tint. */
    .action {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 999px;
      /* White on --sys-blue is 3.5:1. A filled control carrying a label needs
         the increased-contrast tier as its fill, in both appearances. */
      background: #1E6EF4;
      color: #fff;
      font-weight: 590;
      transition: transform var(--dur-snappy, 371ms) var(--ease-snappy, ease-out),
                  filter var(--dur-snappy, 371ms) var(--ease-snappy, ease-out);
    }
    .action:hover { filter: brightness(1.08); }
    .action:active { transform: scale(0.94); }
    .action.secondary {
      background: color-mix(in srgb, currentColor 18%, transparent);
      color: inherit;
    }

    .close {
      display: flex;
      padding: 6px;
      border-radius: 50%;
      background: transparent;
      color: inherit;
      opacity: .55;
      transition: opacity var(--dur-snappy, 371ms) var(--ease-snappy, ease-out),
                  transform var(--dur-snappy, 371ms) var(--ease-snappy, ease-out);
    }
    .close:hover { opacity: 1; background: color-mix(in srgb, currentColor 14%, transparent); }
    .close:active { transform: scale(0.9); }

    :focus-visible { outline: 2px solid var(--text-blue); outline-offset: 2px; }
  `;

  const BELL_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">'
    + '<path d="M12 2.6a1.15 1.15 0 0 1 1.15 1.15v.62a6.2 6.2 0 0 1 5.05 6.1v3.3l1.3 2.2a.9.9 0 0 1-.78 1.36H5.28a.9.9 0 0 1-.78-1.36l1.3-2.2v-3.3a6.2 6.2 0 0 1 5.05-6.1v-.62A1.15 1.15 0 0 1 12 2.6Zm0 18.8a2.5 2.5 0 0 1-2.42-1.9h4.84A2.5 2.5 0 0 1 12 21.4Z"/></svg>';

  const CLOSE_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" '
    + 'stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  /** Relative luminance of a CSS colour, or null if it is fully transparent. */
  function luminanceOf(color) {
    const m = /rgba?\(([^)]+)\)/.exec(color || '');
    if (!m) return null;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    const [r, g, b] = parts;
    const alpha = parts.length > 3 ? parts[3] : 1;
    if (!alpha || [r, g, b].some(Number.isNaN)) return null;
    const lin = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  /**
   * 'light' or 'dark' for whatever is actually painted behind the banner.
   *
   * Reading document.body is not good enough: Buildkite leaves `body` light and
   * paints its dark theme on an inner wrapper, so a body-only probe picks light
   * and the banner ends up dark-on-dark. Sample the real stacking order at the
   * point the bar occupies instead, and fall back progressively.
   */
  function pageBehind() {
    const x = Math.round(window.innerWidth / 2);
    const y = 34; // vertical centre of the bar: top 14px + roughly half its height

    const stack = typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(x, y)
      : [];
    for (const el of stack) {
      if (el.id === BANNER_ID || (el.closest && el.closest(`#${BANNER_ID}`))) continue;
      const l = luminanceOf(getComputedStyle(el).backgroundColor);
      if (l !== null) return l > 0.35 ? 'light' : 'dark';
    }

    for (const el of [document.body, document.documentElement]) {
      const l = el && luminanceOf(getComputedStyle(el).backgroundColor);
      if (l !== null && l !== undefined) return l > 0.35 ? 'light' : 'dark';
    }

    // Nothing paints a background anywhere: the page's own text colour still
    // tells us which way round it is. Light text means a dark page.
    const textL = document.body && luminanceOf(getComputedStyle(document.body).color);
    if (textL !== null && textL !== undefined) return textL > 0.5 ? 'dark' : 'light';

    return 'dark';
  }

  function removeBanner() {
    clearTimeout(hideTimer);
    document.getElementById(BANNER_ID)?.remove();
  }

  function dismissedKey(url) { return `bk-watcher-dismissed:${url}`; }

  function scheduleHide(host) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => host.remove(), AUTO_HIDE_MS);
    host.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    host.addEventListener('mouseleave', () => { hideTimer = setTimeout(() => host.remove(), 5000); });
  }

  async function renderBanner(info, status) {
    removeBanner();
    const host = document.createElement('div');
    host.id = BANNER_ID;
    host.setAttribute('data-behind', pageBehind());
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `${await loadTokens()}\n${CSS}`;
    root.appendChild(style);

    const bar = document.createElement('div');
    bar.className = 'bar';
    root.appendChild(bar);

    const bell = document.createElement('span');
    bell.className = 'bell';
    bell.innerHTML = BELL_SVG;
    bar.appendChild(bell);

    const text = document.createElement('div');
    text.className = 'text';
    bar.appendChild(text);

    const primary = document.createElement('button');
    primary.className = 'action';
    bar.appendChild(primary);

    const close = document.createElement('button');
    close.className = 'close';
    close.title = 'Dismiss';
    close.setAttribute('aria-label', 'Dismiss');
    close.innerHTML = CLOSE_SVG;
    close.addEventListener('click', () => {
      try { sessionStorage.setItem(dismissedKey(info.url), '1'); } catch { /* ignore */ }
      removeBanner();
    });
    bar.appendChild(close);

    const label = `<b>${escapeHtml(info.pipeline)}</b> #${info.number}`;

    function showIdle() {
      const stateText = status.state === 'unknown' ? 'state unknown' : status.stateLabel;
      text.innerHTML = `${label} is <span class="state">${escapeHtml(stateText)}</span>`;
      primary.textContent = 'Watch this build';
      primary.className = 'action';
      primary.onclick = async () => {
        primary.disabled = true;
        primary.textContent = 'Adding…';
        const reply = await send({ type: 'WATCH', url: info.url });
        if (reply?.ok) showWatching();
        else {
          primary.disabled = false;
          primary.textContent = 'Retry';
          text.innerHTML = `Could not watch: ${escapeHtml(reply?.error || 'unknown error')}`;
        }
      };
      scheduleHide(host);
    }

    function showWatching() {
      text.innerHTML = `<span class="watching">Watching</span> ${label} <span class="state">— chime when it finishes</span>`;
      primary.textContent = 'Unwatch';
      primary.className = 'action secondary';
      primary.disabled = false;
      primary.onclick = async () => {
        await send({ type: 'UNWATCH', url: info.url });
        showIdle();
      };
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => host.remove(), 6000);
    }

    if (status.watched) showWatching();
    else showIdle();

    document.documentElement.appendChild(host);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // -------------------------------------------------------------------------
  // Detection
  // -------------------------------------------------------------------------

  async function detect() {
    const info = parseLocation();
    if (!info) { currentUrl = null; removeBanner(); return; }
    if (info.url === currentUrl) return;
    currentUrl = info.url;
    removeBanner();

    try { if (sessionStorage.getItem(dismissedKey(info.url))) return; } catch { /* ignore */ }

    const reply = await send({ type: 'GET_STATUS', url: info.url });
    if (!reply || reply.error && !reply.state) return;
    if (currentUrl !== info.url) return; // navigated away meanwhile

    const status = {
      state: reply.state || 'unknown',
      blocked: Boolean(reply.blocked),
      finished: Boolean(reply.finished),
      watched: Boolean(reply.watched),
      stateLabel: labelFor(reply),
    };

    if (status.finished && !status.watched) return; // nothing to wait for
    await renderBanner(info, status);
  }

  function labelFor(s) {
    if (s.blocked) return 'blocked, waiting for input';
    switch (s.state) {
      case 'started':
      case 'running': return 'running';
      case 'scheduled': return 'scheduled';
      case 'creating': return 'starting';
      case 'failing': return 'failing';
      case 'canceling': return 'canceling';
      case 'waiting':
      case 'waiting_failed': return 'waiting';
      case 'passed': return 'passed';
      case 'failed': return 'failed';
      case 'canceled': return 'canceled';
      default: return s.state || 'unknown';
    }
  }

  detect();
  window.addEventListener('popstate', () => { currentUrl = null; detect(); });
  setInterval(() => { if (parseLocation()?.url !== currentUrl) detect(); }, 1000);
})();
