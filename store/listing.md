# Chrome Web Store listing

Copy each block into the matching field in the developer console. Character limits are Google's.

---

## Item name (45 max)

```
Buildkite Build Watcher
```

## Short description (132 max)

```
Chimes when your Buildkite build passes, fails, or needs input. Different sound for each. No token, no login.
```

## Category

Developer Tools

## Language

English (United Kingdom)

## Detailed description

```
Stop watching a build log waiting for it to go green.

Buildkite Build Watcher plays a distinct sound the moment a build you care about finishes, so you can go and
do something else until it does.

THREE SOUNDS, THREE OUTCOMES
• Passed — a rising four-note chime
• Failed or cancelled — two descending tones
• Needs input — a double ping, for when a block step is waiting on you
A fourth, quieter sound acknowledges a build being picked up automatically.

WATCHES BUILDS YOU TRIGGER, ON ITS OWN
Turn on auto-watch and any build you start is picked up within a minute, read from the same builds page you
already use. Builds already running when you enable it are ignored, so switching it on is never a burst of
noise. You can also watch anyone else's build by hand from its page.

TELLS YOU WHICH BUILD IT WAS
A desktop notification names the pipeline and build number, and clicking it opens the build. The popup keeps
the last finished builds listed and colour-coded, so a chime you missed is still accounted for.

NO TOKEN, NO LOGIN, NO ACCOUNT
It reads build status using the Buildkite session your browser already has. There is nothing to configure and
no credential to paste. It never sees your password.

NOTHING LEAVES YOUR BROWSER
No servers, no analytics, no telemetry, no remote code. The builds you are watching and your settings are
stored locally on your own machine and are never transmitted anywhere. The full source is on GitHub.

WORKS WITH
buildkite.com. Self-hosted Buildkite instances are not supported yet.

An independent open-source project. Not affiliated with, endorsed by, or sponsored by Buildkite.
```

## Homepage URL

```
https://github.com/naman-kumar2397/chrome_buildkite
```

## Assets

| Field | File |
|---|---|
| Screenshots (1280×800) | `screenshot-1-watching.png`, `screenshot-2-history.png`, `screenshot-3-auto.png` |
| Small promo tile (440×280) | `promo-small.png` |
| Store icon (128×128) | `store-icon-128.png` — 96×96 artwork with 16px transparent padding, no drop shadow |

Regenerate the screenshots and tile with `npm run assets`, and the icons with `npm run icons`. They are rendered from fictional `acme` pipelines — never from a
real Buildkite session.

---

# Privacy tab

## Single purpose

```
Notify the user with a sound and a desktop notification when a Buildkite build they are watching finishes,
fails, or needs manual input.
```

## Permission justifications

**Host permission — `https://buildkite.com/*`**
```
The extension reads the status of builds on buildkite.com using the session the user is already signed in
to. This is the extension's entire function: without access to buildkite.com it cannot tell whether a build
has finished, and there is no other source for that information. Requests are ordinary reads of pages and
JSON endpoints the user can visit themselves. No data from those responses is sent anywhere.
```

**`alarms`**
```
Watched builds are re-checked on a schedule so the user gets a chime after a build finishes without having
to keep the build page open. Alarms are the only way for a Manifest V3 service worker to run periodically.
```

**`storage`**
```
Stores the list of builds being watched, their last known state, the most recent finished builds, and the
user's settings. All of it stays in chrome.storage.local on the user's own machine and is never transmitted.
```

**`notifications`**
```
The chime alone cannot say which build finished when several are being watched. A desktop notification names
the pipeline and build number and opens that build when clicked.
```

**`offscreen`**
```
A Manifest V3 service worker cannot play audio. An offscreen document is created solely to play the chime
through the Web Audio API and does nothing else. The sounds are synthesised in code; no audio file is loaded.
```

## Data usage

Declare **no** data collected in every category. All four certifications apply:

- Does not sell or transfer user data to third parties
- Does not use or transfer user data for purposes unrelated to the single purpose
- Does not use or transfer user data to determine creditworthiness or for lending
- Complies with the Developer Program Policies

## Privacy policy URL

```
https://github.com/naman-kumar2397/chrome_buildkite/blob/main/PRIVACY.md
```

---

# Distribution tab

- Visibility: **Public**
- Regions: all
- Pricing: free
