# Publishing to the Chrome Web Store

A checklist for taking a tagged release from this repo to a live listing. All the copy referenced here is in
[`listing.md`](listing.md); all the images are in this directory.

Two things worth knowing before you start:

- **A public repo is not required to publish.** The store takes a zip and never reads your source. What *is*
  required is a publicly reachable **privacy policy URL** — which is why this repo is public and why the
  policy link points at `PRIVACY.md` on `main`.
- **The one-time fee is US$5**, charged per developer account rather than per extension.

---

## 1. Cut the release

```bash
git checkout main
git pull
npm ci && npm run lint && npm test        # what CI runs
git tag v1.0.0
git push origin v1.0.0
```

The release workflow builds the package, refuses to continue if the tag disagrees with `manifest.json` or
`package.json`, and attaches `buildkite-build-watcher-1.0.0.zip` to a GitHub Release.

**Download that zip and upload it.** It is the artefact CI verified; a locally built one may differ.

## 2. Register as a developer

1. Open the [developer dashboard](https://chrome.google.com/webstore/devconsole).
2. Sign in with the Google account that should own the listing. Choose deliberately between a personal and a
   work account — moving an item between accounts later is awkward.
3. Accept the developer agreement.
4. Pay the one-time **US$5** registration fee.
5. Set your **publisher display name** and verify your **contact email**. Do this now: publishing is blocked
   until the email is verified, and it is an annoying thing to discover at the end.

## 3. Create the item

**Add new item** → upload the zip. Then work through the tabs.

### Store listing
Name, short description, detailed description, category **Developer Tools**, language — all from
`listing.md`. Upload the three 1280×800 screenshots, `promo-small.png` as the small promo tile, and
`store-icon-128.png` as the store icon. Homepage URL is the GitHub repo.

The store icon is deliberately not the same file as the one in the package: Google asks for 96×96 of artwork
inside a 128×128 canvas, so `store-icon-128.png` carries 16px of transparent padding that `icons/icon128.png`
does not. Both are generated from the same drawing by `npm run icons`.

### Privacy
The tab reviewers read most closely. From `listing.md`: the single-purpose statement, a separate
justification for each of the four permissions plus the host permission, and the privacy policy URL. Declare
**no data collected** in every category and tick all four certifications — all four are true here.

### Distribution
**Public**, all regions, free.

## 4. Submit

Submit for review. Expect a few days; a first submission carrying a host permission can take longer than a
later update. You will get an email either way.

If it is rejected, the message names the specific policy. In practice the common causes are a
permission justification that does not explain *why the feature needs it*, or a screenshot that shows
something other than the extension. Both are fixed by editing text, not code.

On approval the item gets a permanent extension ID. Add the store link to the README.

## 5. Shipping an update later

1. Bump the version in **both** `manifest.json` and `package.json`. CI fails if they disagree, which is the
   point.
2. Add a `CHANGELOG.md` entry.
3. Tag `vX.Y.Z` and push; download the zip the release workflow produced.
4. Upload it to the existing item and submit. Updates review faster than the first submission.

## Before every submission

```bash
npm run lint && npm test          # unit tests and lint
npm run permissions               # proves no unnecessary permission crept back in
npm run contrast                  # WCAG AA, measured from rendered pixels
npm run smoke                     # popup renders, chimes play
npm run assets                    # regenerate screenshots if the UI changed
npm run icons                     # regenerate icons if the mark changed
npm run pack                      # inspect exactly what ships
```

The last one prints the file list. Anything unexpected in it is a bug — the package should contain only the
extension's runtime files, never tests, scripts or documentation.
