# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- The in-page banner rendered dark text on dark glass over Buildkite. It chose its contrast from
  `document.body`, which Buildkite leaves light while painting its dark theme on an inner wrapper. It now
  samples the element stack actually behind the bar, falling back to the document and then to the page's own
  text colour.
- Default-tier system colours were used as small text throughout the popup. `--sys-green` on white is 2.2:1,
  well below WCAG AA. Text roles now bind to the increased-contrast tier in every appearance, while fills and
  marks keep the default tier. Muted text was also too light at 3.2:1.
- The banner's primary action was white on `--sys-blue`, which is 3.5:1. It now uses the increased-contrast
  blue as its fill.

### Changed
- The chime buttons and the `AUTO` tag are neutral, carrying a coloured dot rather than a coloured background.
  Colour on its own tint cannot reach 4.5:1 without going darker than Apple's published tier, and the HIG asks
  for tint on one control per view rather than four.

### Added
- `npm run contrast` measures text contrast from rendered pixels in a real browser — both appearances, three
  page grounds — and fails below WCAG AA. Added to CI alongside the permission and smoke checks.

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
