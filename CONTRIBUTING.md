# Contributing

Plain JavaScript, Manifest V3, no build step. Edit a file, hit **Reload** on `chrome://extensions`,
and you're running the change. This page is the technical companion to the README: how the extension
finds build state, the design rules it is held to, and how to run every check.

## Layout

```
manifest.json     permissions, content-script matches, offscreen + alarms
background.js     service worker: watch store, 30 s alarm, provider chain, notifications, chimes
status.js         pure logic: URL parsing, state normalisation, event decisions, provider chain
discovery.js      pure logic: parsing the /builds listing, baseline and dedupe rules, provider chain
content.js        the in-page banner, plus DOM-state and DOM-build-list responders
offscreen.*       Web Audio chime synthesis (a service worker cannot play audio)
popup.*           watch list, recently finished, test chimes, volume, diagnostics
vendor/           Apple design tokens, copied verbatim from the design repo — do not hand-edit
scripts/          browser-driven checks and asset generators (see below)
store/            generated Chrome Web Store assets and the submission notes
test/             node --test unit tests
```

## Running the checks

```
npm test              # unit tests, no browser needed
npm run lint          # ESLint
npm run pack          # builds dist/<name>-<version>.zip and prints exactly what ships
```

The browser-driven checks need Playwright and its bundled Chromium:

```
npm i --no-save playwright && npx playwright install chromium

npm run permissions   # proves no unnecessary permission has crept back in
npm run contrast      # WCAG AA, measured from rendered pixels
npm run smoke         # loads the extension, seeds storage, checks the popup and chime path
npm run icons         # regenerates the icons and the store icon from one drawing
npm run assets        # regenerates the store screenshots from fictional data
```

**The browser has to be Playwright's bundled Chromium (Chrome for Testing).** Google Chrome removed
`--load-extension` from branded builds in version 137 and ignores the flag silently: the browser starts
and the extension is simply absent, and the first symptom is a timeout waiting for its service worker.
`CHROME_PATH` may name a Chromium or Chrome for Testing binary kept elsewhere; it must never point at
Google Chrome. All five scripts launch through `scripts/lib/browser.mjs`, which explains exactly this if
the extension fails to load.

CI runs lint and the unit tests on every push, and the three browser checks in a second job. A `v*` tag
builds the zip and attaches it to a release, refusing if the tag disagrees with `manifest.json` and
`package.json`.

## How build state is fetched

Every 30 seconds the service worker tries these, in order, and remembers which one worked for each build:

1. `GET <build url>.json` with the session cookies (`Accept: application/json`), reading `state` and
   `blocked_state`.
2. `GET <build url>` as HTML, extracting the state from data attributes or embedded JSON.
3. Asking the content script in any open tab for that build to read the state from the DOM.

If all three fail the watch stays and the popup shows the error next to the build. It never gives up on
its own. A login redirect or a 401/403 from any provider is classified as *signed out*: the popup says so
plainly, and polling backs off to roughly five minutes until the session returns.

### The JSON is Buildkite's internal shape, not the public API

| Field | Meaning |
|---|---|
| `state` | `started` while running (normalised to `running`); `passed`, `failed`, `canceled` once done; `scheduled`, `creating`, `canceling`, `failing` in between |
| `blocked_state` | `blocked` while a block step waits for someone — the "needs input" signal |
| `finished_at` | non-null once the build is done; a second finished signal |
| `canceled_at`, `cancel_status` | non-null when the build was canceled |

An unrecognised state is shown in the popup as `unrecognised state "<value>"`. A finished build with an
unknown state still gets the failure chime, so it is never silently missed.

### Probe the endpoint on your account

Open a build page, open the DevTools console, and run:

```js
fetch(location.pathname + '.json', { credentials: 'include', headers: { Accept: 'application/json' } })
  .then(r => r.json())
  .then(j => console.log({ state: j.state, blocked_state: j.blocked_state, finished_at: j.finished_at, canceled_at: j.canceled_at }))
```

A `state` in the output means provider 1 is working and polling is cheap and exact. If you get HTML or
an error the extension silently falls through to providers 2 and 3. The popup's **Copy diagnostics**
link produces a fuller, redacted version of this for bug reports.

## Auto-discovery

**Auto-watch builds I trigger** polls `https://buildkite.com/builds` once a minute and watches anything
new that Buildkite lists as yours, through the same three-provider fallback as build status. The rules
that keep it quiet:

- Builds already in flight when discovery is first enabled are recorded as a baseline and never watched.
- A build you unwatch is remembered and not re-added.
- A build that just chimed cannot be picked up again if the listing lags a cycle behind.
- At most 25 builds are auto-watched at once.
- One acknowledgement chime per cycle, however many builds arrive together.
- Watched builds that the listing covers reuse its state and skip their own fetch that cycle, so with
  several builds in flight discovery removes more requests than it adds.

## Permissions

| Permission | Why |
|---|---|
| `https://buildkite.com/*` | Read build status using the session the browser already has |
| `alarms` | Re-check watched builds on a schedule |
| `storage` | Keep the watch list and settings on the user's machine |
| `notifications` | Say which build finished; clicking opens it |
| `offscreen` | Play the chime — a Manifest V3 service worker cannot |

Notably absent: `tabs`. Opening a build from a notification and reading state from an open Buildkite
tab are both covered by the host permission. `npm run permissions` proves it in a real browser so the
permission cannot creep back in unnoticed.

## Design rules, and the two that are enforced

The interface follows Apple's Human Interface Guidelines using the token set from
[naman-kumar2397/design](https://github.com/naman-kumar2397/design): `vendor/apple.css` and
`vendor/motion.css`, copied verbatim. They carry the current system colours in four appearance
variants, the published text ramps, and spring easing curves.

- **The system font, never a bundled one.** Apple's licence forbids shipping SF Pro on the web, so the
  stack asks the OS for its own UI face. Size, leading and Apple's published optical tracking per size
  are set so the design holds on whatever face resolves.
- **The macOS text ramp, not the iOS one.** A dense desktop panel read at desk distance: body is 13/16,
  not 17/22.
- **Liquid Glass only on the functional layer.** The popup toolbar and the floating in-page banner carry
  the material; content rows never do. The banner samples what is actually painted behind it to choose
  its contrast, because Buildkite renders dark whatever the OS appearance is set to.
- **Two colour roles, not one.** The default tier of a system colour is for fills and marks; small text
  takes the increased-contrast tier in every appearance. `--sys-green` as text on white is 2.2:1.
- **Tint on one control per view.** The chime buttons are neutral capsules carrying a coloured dot.
- `prefers-reduced-motion` and `prefers-reduced-transparency` are both honoured.

Two of these are enforced by CI rather than trusted:

- `npm run smoke` fails if any element other than the toolbar carries a `backdrop-filter`.
- `npm run contrast` screenshots every piece of text and measures **its own rendered pixels** — both
  appearances, three page grounds — failing below WCAG AA (4.5:1). Token-against-token would prove
  nothing: the banner floats over an arbitrary page, the toolbar is translucent, tinted controls are
  colour-mixed. It samples at 3× because at 1× small glyphs are mostly antialiased edges.

The second exists because it caught two real bugs: a banner rendering dark-on-dark over Buildkite, and
default-tier colours used as small text.

## Shipping a change

1. Bump the version in **both** `manifest.json` and `package.json` — CI fails if they disagree.
2. Add a `CHANGELOG.md` entry.
3. Tag `vX.Y.Z` and push; the release workflow attaches the zip.
4. Upload that zip to the Chrome Web Store item. `store/SUBMISSION.md` has the full walkthrough.

### Confirming a reload took effect

The popup footer shows the version it is running. After pulling changes and clicking the reload arrow
on `chrome://extensions`, check that number against `manifest.json`. If it still shows the old one,
Chrome is reading a different folder than the one you pulled into.

## Reporting a bug

Open an issue and paste the output of **Copy diagnostics** from the popup. Organisation and pipeline
names are replaced with placeholders and no cookies or tokens are included.
