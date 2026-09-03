# Buildkite Build Watcher

> An independent open-source project. Not affiliated with, endorsed by, or sponsored by Buildkite.

A small Chrome extension that notices when you're looking at a Buildkite build that is still running,
offers to **watch** it, and then plays a distinct chime (plus a desktop notification) when the build:

| Event | Chime | Buildkite state |
|---|---|---|
| **Passed** | rising four-note arpeggio | `passed` |
| **Failed** | two descending low buzzes | `failed`, `canceled` (also `skipped`, `not_run`) |
| **Needs input** | double ping, repeated once | a `block` step is waiting (`blocked: true`) |
| **Now watching** | two soft ascending blips | a build you triggered was picked up automatically |

After a "needs input" chime the watcher keeps going: unblock the step and you'll get the pass/fail chime
when the build finally finishes.

No login handling, no API tokens. The extension polls buildkite.com in the background using the session
cookies your browser already has, so the chime fires even if you've closed the build tab.

## Install (load unpacked)

1. Clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the repo folder.
4. Open any running build on `https://buildkite.com/<org>/<pipeline>/builds/<n>`. A banner appears at the
   top of the page: click **Watch this build**.

## Your own builds are picked up automatically

**Auto-watch builds I trigger** (on by default, toggle in the popup) polls `https://buildkite.com/builds` once
a minute and starts watching anything new that Buildkite lists as yours. Auto-watched builds carry an `AUTO`
tag in the popup; manual watching is unchanged and still works for other people's builds.

- When it picks builds up you get one soft acknowledgement chime per cycle, not one per build.
- Builds already running when you enable it are ignored, so switching it on is never a burst of chimes.
- Unwatching an auto-watched build makes it stay unwatched.
- At most 25 builds are auto-watched at once, so a mass rebuild cannot spawn hundreds of pollers.
- Because the listing already reports each build's state, watched builds it covers skip their individual
  status fetch that cycle. Discovery costs roughly one request a minute, not one per build.

The listing is read through the same fallback chain as build status (`/builds.json` and variants, then the
`/builds` HTML, then any open buildkite.com tab). The popup's status line names which one worked, or shows the
error if none did.

The toolbar icon shows how many builds are being watched. Click it to see them, unwatch, test the three
chimes, or adjust the volume.

**Recently finished** in the popup keeps the last dozen builds that chimed, colour-coded by outcome, so if
you miss a chime or a notification you can still tell which build it was. Click one to open it, or **clear**
to empty the list.

Requires Chrome 120 or newer (30-second alarm polling).

### Confirming an update took effect

The popup footer shows the version it is running, e.g. `v0.3.0`. After pulling changes and clicking the
reload arrow on `chrome://extensions`, open the popup and check that number against `manifest.json`. If it
still shows the old one, Chrome is reading a different folder than the one you pulled into.

## How status is fetched

Every 30 seconds the service worker tries these, in order, and remembers which one worked:

1. `GET <build url>.json` with your session cookies (`Accept: application/json`), reading `state` and `blocked`.
2. `GET <build url>` as HTML, extracting the state from the page's data attributes or embedded JSON.
3. Asking the content script in any open tab for that build to read the state from the DOM.

If all three fail, the watch stays and the popup shows the error next to the build. It never gives up on its own.

### What the JSON looks like

The build page's JSON is Buildkite's internal shape, not the public REST API. The fields the extension reads:

| Field | Meaning |
|---|---|
| `state` | `started` while running (mapped to `running`); `passed`, `failed`, `canceled` once done; `scheduled`, `creating`, `canceling`, `failing` in between |
| `blocked_state` | `blocked` while a block step waits for someone; that is the "needs input" signal |
| `finished_at` | non-null once the build is done, used as a second finished signal |
| `canceled_at`, `cancel_status` | non-null when the build was canceled |

If Buildkite reports a state name the extension does not know, the popup shows it as `raw: <value>` next to
the build. A finished build with an unknown state still gets the failure chime so it is never silently missed.

### Probe the endpoint on your account (10 seconds)

Open a build page, open DevTools (Console) and run:

```js
fetch(location.pathname + '.json', { credentials: 'include', headers: { Accept: 'application/json' } })
  .then(r => r.json())
  .then(j => console.log({ state: j.state, blocked_state: j.blocked_state, finished_at: j.finished_at, canceled_at: j.canceled_at }))
```

If you see a `state`, provider 1 is working and polling is cheap and exact. If you get HTML or an error, the
extension silently uses providers 2 and 3. If the popup reports that all providers fail, open an issue with
the output above (redact anything sensitive).

## Design

The interface is built on Apple's Human Interface Guidelines, using the token set from
[naman-kumar2397/design](https://github.com/naman-kumar2397/design) — `vendor/apple.css` and
`vendor/motion.css`, copied in verbatim and not hand-edited. Those files carry the current system
colours in four appearance variants, the published text ramps, and spring easing curves.

Three rules shape the result:

- **The system font, never a bundled one.** Apple's font licence forbids shipping SF Pro on the
  web, so the stack asks the operating system for its own UI face. Metrics — size, leading and
  Apple's published optical tracking per size — are set so the design holds up on whatever face
  resolves.
- **The macOS text ramp, not the iOS one.** This is a dense desktop panel read at desk distance,
  so body text is 13/16 rather than 17/22.
- **Liquid Glass only on the functional layer.** The popup toolbar and the floating in-page banner
  get the material; content rows never do. The banner measures the luminance of the page behind it
  to choose its contrast, because a floating overlay has to read against the page rather than the
  OS appearance. Both `prefers-reduced-transparency` and the no-`backdrop-filter` fallback are
  implemented.

`npm run smoke` asserts the layering rule directly: it fails if any element other than the toolbar
carries a `backdrop-filter`.

## Development

Plain JavaScript, Manifest V3, no build step. Edit files and hit **Reload** on `chrome://extensions`.

```
manifest.json     permissions, content script match, offscreen + alarms
background.js     service worker: watch store, 30s alarm, provider chain, notifications, offscreen chimes
status.js         pure logic: URL parsing, state normalisation, event decisions, provider chain
discovery.js      pure logic: parsing the /builds listing, baseline and dedupe rules, provider chain
content.js        banner UI on build pages + DOM-state and DOM-build-list responders
offscreen.*       Web Audio chime synthesis (service workers can't play audio)
popup.*           watch list, test chimes, volume
scripts/make-icons.mjs   renders the icons and the store icon from one drawing (`npm run icons`)
scripts/popup-smoke.mjs  optional browser smoke test for the popup (`npm run smoke`)
scripts/store-assets.mjs generates the store screenshots from fictional data (`npm run assets`)
vendor/           Apple design tokens, copied from the design repo — do not hand-edit
store/            generated Chrome Web Store listing assets
test/             node --test unit tests for status.js (`npm test`)
```

Run the tests with:

```
npm test
```

There is also an optional end-to-end smoke test that loads the extension in a real Chromium, seeds storage,
and checks the popup renders and the chime path works:

```
npm i --no-save playwright
CHROME_PATH=/path/to/chrome npm run smoke     # add a filename to also save a screenshot
```

## Permissions

- `alarms`, `storage`: polling schedule and the watch list.
- `notifications`: desktop notification alongside the chime; clicking it opens the build.
- `offscreen`: hidden document used only to play audio.
- Host access to `https://buildkite.com/*`: fetch build status with your existing session.

Notably absent: `tabs`. Opening a build from a notification and reading state from an already-open Buildkite
tab are both covered by the host permission above. `npm run permissions` proves it in a real browser, so the
permission cannot creep back in unnoticed.
