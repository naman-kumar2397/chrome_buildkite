# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-09-03

First public release.

### Changed
- Redesigned the popup and the in-page banner in Apple's current design language, built on the
  token set from [naman-kumar2397/design](https://github.com/naman-kumar2397/design): real system
  colours in light, dark and increased-contrast variants, the published macOS text ramp with
  optical tracking per size, and spring easings that neutralise under `prefers-reduced-motion`.
- Liquid Glass is used only where the HIG puts it — the popup toolbar and the floating in-page
  banner, both of which sit above scrolling content — and never on content rows. The banner picks
  its contrast from the measured luminance of the page behind it rather than the OS appearance,
  so it stays legible on Buildkite's dark UI whatever the system is set to.
- The discovery setting is now a switch rather than a checkbox, per the HIG guidance for a setting
  that governs a whole behaviour.
- Watch rows lead with the pipeline and build number and demote the organisation, which stops long
  names truncating. Buildkite's internal state names are no longer shown unless they are the thing
  worth reporting.

### Fixed
- The signed-out notice could never be dismissed: an author `display: flex` silently overrode the
  browser's `[hidden]` rule, so the banner showed permanently regardless of session state.

### Added
- Clear signed-out state: the popup says "Not signed in to Buildkite" instead of showing a provider error
  dump, and polling backs off to roughly five minutes until the session returns.
- **Copy diagnostics** in the popup: probes every endpoint and copies a redacted report, with organisation and
  pipeline names replaced by placeholders, ready to paste into an issue.
- MIT licence, privacy policy, changelog, and issue template.
- GitHub Actions: lint and tests on every push and pull request; a `v*` tag builds the extension zip and
  attaches it to a release, refusing to publish if the tag and manifest versions disagree.
- `npm run pack` builds a store-ready zip containing only the files the extension ships.

## [0.4.0] — 2026-09-03

### Added
- Auto-discovery of builds you trigger, read from the `/builds` listing once a minute, with a soft
  acknowledgement chime played once per cycle.
- Discovery toggle and an `AUTO` tag in the popup.

### Fixed
- The `/builds` HTML parser scoped each build link to its own row, so one build could no longer inherit its
  neighbour's state.

### Performance
- Watched builds covered by the discovery listing reuse that state and skip their own status fetch.

## [0.3.0] — 2026-09-03

### Added
- **Recently finished** list showing the last twelve builds that chimed, colour-coded by outcome.
- The popup footer shows the running version, so a reload can be confirmed at a glance.

### Changed
- "Needs input" notifications stay on screen until dismissed.

## [0.2.0] — 2026-09-03

### Fixed
- Parse Buildkite's internal build JSON: `started` is normalised to `running`, blocking is read from
  `blocked_state`, and `finished_at` decides completion. In-progress builds previously failed to poll at all.

## [0.1.0] — 2026-09-03

Initial version: watch a build from its page, chime on pass, fail, or block.
