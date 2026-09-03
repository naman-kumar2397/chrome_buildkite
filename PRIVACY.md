# Privacy Policy

> An independent open-source project. Not affiliated with, endorsed by, or sponsored by Buildkite.

**Buildkite Build Watcher** does not collect, transmit, or sell any data. There is no server, no analytics,
no telemetry, and no remote code.

Last updated: 2026-09-03

## What the extension does

It reads build status from `https://buildkite.com` using the session cookies your browser already has, and
plays a sound when a build you are watching finishes or needs input. It never asks for your credentials and
never sees your password.

## What is stored, and where

Everything is stored locally in `chrome.storage.local` on your own machine:

- URLs of the builds you are watching, with their organisation, pipeline, and build number
- the last known state of those builds
- a list of the most recent finished builds, so the popup can show what chimed
- your settings (auto-discovery on or off, chime volume)

This data never leaves your browser. It is not synced to any account. Removing the extension deletes it.

## What is sent, and to whom

The only network requests are to `https://buildkite.com`, the same site you are already signed in to. They are
ordinary reads of pages and JSON endpoints you can visit yourself. No request is made to any other host, and
no data is sent to the extension's author.

## Permissions

| Permission | Why |
|---|---|
| `https://buildkite.com/*` | Read build status using your existing session |
| `alarms` | Check watched builds on a schedule |
| `storage` | Remember your watches and settings on your machine |
| `notifications` | Show a desktop notification when a build finishes |
| `offscreen` | Play the chime (a Manifest V3 service worker cannot play audio itself) |

The extension deliberately does **not** request the `tabs` permission. Opening a build from a notification and
reading state from an already-open Buildkite tab are both covered by the single `buildkite.com` host
permission above.

## Diagnostics

The popup has a **Copy diagnostics** button for reporting bugs. It copies a report to your clipboard, with
organisation and pipeline names replaced by placeholders and no cookies or tokens included. Nothing is sent
anywhere — you choose whether to paste it into an issue.

## Contact

Questions or concerns: open an issue at https://github.com/naman-kumar2397/chrome_buildkite/issues
