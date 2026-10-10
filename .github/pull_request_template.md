## What this changes

<!-- One or two sentences: what changed and why. Link the issue if there is one. -->

## How I verified it

- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run test:track` (dev server running)
- [ ] Feature gate for the area I touched: <!-- e.g. `node scripts/qa-radio.mjs`, or "none applies" -->

<!-- Screenshots are welcome for anything visual. -->

## New layer checklist

<!--
Fill this in if the PR adds a new data layer. Delete the whole section if it doesn't.
See "Adding a new layer" in CONTRIBUTING.md.
-->

**Screenshots**

<!-- At least one screenshot of the layer on the globe, plus its info card or panel if it has one. -->

**Recording**

<!--
Preferably 15 to 30 seconds: turn the layer on, move around, open a record.
Drag an .mp4 or .mov in here; GitHub accepts up to 10 MB on free accounts.
If it's bigger, link to it instead.
-->

**Proposed category**

<!--
Which layer-panel group should it sit in? The current groups are in PANEL_GROUPS
in src/ui/layerPanel.js: Movement, Cameras, Infrastructure, Events, Weather, Utilities.
If none fits, propose a new group and say why.
-->

Category:

**Data source and licence**

- Source (provider and endpoint):
- Licence or terms (link):
- Attribution shown in the app:
- Needs a key? (none / optional / required):
- Fetched at runtime, or bundled in the repo:

<!-- Bundled data must be data we have the right to redistribute. -->

- [ ] Added a row to `DATA_SOURCES.md`
- [ ] Credit is registered in `src/data/dataCredits.js`
- [ ] Share-link token assigned with `npm run layer-token:next`, if the layer is shareable

## Docs

- [ ] `docs/CURRENT-STATE.md` and `CHANGELOG.md` updated, or this PR doesn't change runtime behaviour
