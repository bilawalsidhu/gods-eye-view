# i18n ownership manifest — stage-2 fan-out

Status: architect's contract for the four extraction/translation workers
Branch: `feature/i18n` (phase 1 landed; see `ai_docs/i18n-implementation-plan.md`)

Read first: `ai_docs/vision.md` (principles, keep-English rules) and the plan
above (phases, API). This file is the operational contract: who owns which
files, which catalog namespace they write, how namespaces are registered, and
the seed string inventory that anchors key naming.

## Phase-1 foundation (already landed — do not rebuild)

```text
src/i18n/locale.js        resolution + storage + <html lang>/<html dir>
src/i18n/index.js         catalog registry, t(), Intl formatters, DOM application
src/i18n/locales/en/*.js  English source catalogs (shell, cockpit, layers, setup)
src/i18n/locales/es/*.js  Spanish seeds (SAME keys, English values, marked
                          'UNTRANSLATED STAGE-3 SEED' until stage 4)
src/i18n/i18n.test.mjs    precedence, guards, fallback, plurals, DOM application
src/i18n/catalog.test.mjs en/es key + placeholder + shape parity
```

`src/main.js` already calls `resolveLocale()` → `setLocale()` →
`applyDocumentLanguage()` before app init. English is the default and the
fallback; missing es keys render English with a dev-server-only
`console.warn`. Storage key: `gev:locale:v1`. `?lang=` is a one-shot override
that is never persisted and is stripped by `persistLocaleAndReload()`, which
preserves `window.location.hash` exactly.

## Worker → file → namespace map

One namespace per worker's edits; the namespace file is the worker's catalog
territory. **Never edit another worker's namespace file or `src/i18n/index.js`
registration arrays.**

| Worker | Source files owned | Catalog files owned | Namespace |
| --- | --- | --- | --- |
| **shell** | `index.html`, `style.css` (selector + overflow fixes only) | `src/i18n/locales/{en,es}/shell.js` | `shell.*` |
| **core-ui** | `src/ui.js`, `src/hud.js` | `src/i18n/locales/{en,es}/cockpit.js` | `cockpit.*` |
| **layers** | `src/data/*` presentation paths (manager, flights, military, vessels, CCTV, radio, launches, fires, installations, awareness, overlays, tracked readouts) | `src/i18n/locales/{en,es}/layers.js` | `layers.*` |
| **support** | `src/firstRunExperience.js`, `src/keySetup.js`, `src/loadingFeedback.js`, `src/mapStackChips.js`, `src/scenes/*`, `src/main.js` init copy, voice chrome (`src/voice/*` UI labels only), tests + docs | `src/i18n/locales/{en,es}/setup.js` | `setup.*` |

**Cross-surface rule (sequenced, not concurrent).** Phase 2 (static markup)
completes before phase 3 (runtime extraction) starts. The shell worker owns
ALL of `index.html` in phase 2, including static markup of cockpit/context,
Data Layers, first-run, and key-setup surfaces — it adds those keys to the
matching surface namespace (`cockpit.*`, `setup.*`, …), appending at the end
of each file. Because the surface owner only starts editing in phase 3, the
append-only overlap never becomes a live conflict; the integrator still
reviews it at merge.

**Shared runtime status surface.** `src/loadingFeedback.js` drives the global
status chip (`#global-loading-label`) and sync chips; those keys live in
`shell.*` (`shell.status.*`) because that is the surface they render on. The
support worker owns the runtime writes and appends runtime-only keys
(`shell.status.loadComplete`, …) to `shell.js`; the layers worker must not add
keys there — layer-row status copy belongs in `layers.*`.

## Append-only registration rules

1. **New namespace (only if a surface genuinely needs a fifth namespace —
   prefer the four above):** create `src/i18n/locales/<locale>/<ns>.js`
   exporting `const NAMESPACE = '<ns>'` and a default message map of
   namespace-relative keys, then in `src/i18n/index.js` append ONE import line
   per locale and ONE entry in that locale's array:
   ```js
   import * as enVoice from './locales/en/voice.js';   // appended
   const EN_NAMESPACES = [enShell, enCockpit, enLayers, enSetup, enVoice]; // appended
   ```
   `mergeNamespace()` prefixes keys (`voice.*`) and `buildCatalog()` rejects
   duplicates. Nothing else changes; concurrent workers merge trivially.
2. **New keys:** append to the END of the worker's own namespace files in BOTH
   `en/` and `es/` (es may temporarily hold the English value under the
   `UNTRANSLATED STAGE-3 SEED` convention; parity tests allow es ⊆ en but
   never extra es keys).
3. **Never** renumber, reorder, or rename existing keys — other workers'
   `data-i18n` attributes and call sites reference them.

## Parity flip (post-stage-4 gate)

`src/i18n/catalog.test.mjs` enforces: es ⊆ en, placeholder-name parity, and
plural-shape parity per shared key. **FLIPPED (stage-3 completion, commit c91a923):** strict exact-parity is now
the default (`GEV_I18N_REQUIRE_FULL_ES_PARITY=0` opts out). Originally: when
stage-4 translation completes, flip
`REQUIRE_FULL_ES_PARITY` in that file to `true` (or run CI with
`GEV_I18N_REQUIRE_FULL_ES_PARITY=1` to preview) — the gate then demands exact
en/es key-set equality so a forgotten translation cannot ship behind the
English fallback. Update this file's status line when flipped.

## Seed string inventory (representative keys → both write sites)

Static = `index.html` element (line numbers at phase-1 HEAD). Runtime =
source file + function that rewrites the same surface. "—" means the key is
extraction-ready from one side only today.

| Key | English value | Static site (index.html) | Runtime site (src) |
| --- | --- | --- | --- |
| `shell.title.subtitle` | NO PLACE LEFT BEHIND | `#title-bar .subtitle` (29) | — (never rewritten) |
| `shell.loading.initialStatus` | Initializing photorealistic world... | `.loader-status` (919) | `main.js` `init()` first `loaderStatus` write |
| `shell.loading.status.configuring` | Configuring viewer... | — (replaces initial) | `main.js` `init()` |
| `shell.loading.status.tilesUnavailable` | Google 3D Tiles unavailable ({detail})... | — | `main.js` `init()` photoreal fallback |
| `shell.loading.status.flying` | Flying to Austin, TX... | — | `main.js` `init()` no-share-state branch |
| `shell.status.loadingLiveData` | LOADING LIVE DATA | `#global-loading-label` (51) | `loadingFeedback.js` `presentLoadingFeedback()` |
| `shell.status.loadComplete` | LOAD COMPLETE | — (chip starts hidden) | `loadingFeedback.js` `presentLoadingFeedback()` terminal labels |
| `shell.status.trafficSyncing` | syncing road network | `#traffic-sync-label` (54) | `loadingFeedback.js` `reduceTrafficSyncFeedback()` fallback |
| `shell.actions.clearLayers.ariaLabel` | Clear selected data layers | `#clear-selected-layers` aria-label (40) | `ui.js` `clearSelectedLayers()` sets 'Clearing selected data layers' (new key needed) |
| `shell.actions.share.ariaLabel` | Copy share link | `#share-btn` aria-label (43) | — (toast copy is separate) |
| `shell.panels.dataLayers` | DATA LAYERS | `.panel-title` (582) | — |
| `cockpit.hud.sectionLabel` | Aircraft cockpit view | `#cockpit-hud` aria-label (72) | — |
| `cockpit.exit.label` | EXIT COCKPIT | `#map-view-switch` (350–352) | `ui.js` view-switcher state sync |
| `cockpit.readout.groundSpeed` | GROUND SPEED | `.cockpit-readout-label` (171) | — (values only are runtime) |
| `cockpit.context.kicker` | CONTACT | `.cockpit-context-kicker` (184) | `ui.js` cockpit context renderer |
| `cockpit.radio.station.ready` | READY | `#cockpit-radio-station` (328) | `ui.js` `_renderRadioState()` ('SYNCING'/'UNCERTAIN' become sibling keys) |
| `layers.status.unavailable` | UNAVAILABLE | — (layer rows are runtime-built) | `manager.js` `FEED_STATE_LABELS` via `_buildMetaText()` |
| `layers.name.liveFlights` | Live Flights | — | `flights.js` layer `name`, rendered by `manager.js` `_renderToggles()` |
| `layers.clear.toast.cleared` | Cleared {count} data layer(s) | — | `ui.js` `clearSelectedLayers()` result toasts |
| `setup.firstRun.kicker` | MISSION CONTROL · FIRST LAUNCH | `.first-run-kicker` (839) | — (status swaps need new keys: `firstRunExperience.js` `busyText`) |
| `setup.keySetup.chip` | POWER UP | `#key-setup-chip` label (902) | — (chip removed when API absent) |
| `setup.keySetup.status.saving` | Saving… | — | `keySetup.js` `submitUpdates()` `say()` |

Key-naming conventions (keep stable): `<namespace>.<surface>.<element>` for
markup; `<namespace>.<flow>.<state>` for runtime states; plurals as
`{ one, other }` objects with a `{count}` placeholder; interpolation with
`{camelCase}` names.

### Runtime-only static sites (phase-2 exceptions)

These index.html strings have catalog keys but NO static `data-i18n*`
attribute: an existing exact-string test pins the tag verbatim, so the
runtime write is the only legal localization point. The phase-3 surface
worker wires these keys at the runtime write and updates the pinning test in
the same commit.

| Key | Static site | Pinned by | Runtime localization point |
| --- | --- | --- | --- |
| `cockpit.context.kicker` | `.cockpit-context-kicker` (185) | `cockpitMarkup.test.mjs` (`class="cockpit-context-kicker">CONTACT<`) | `ui.js` cockpit context renderer |
| `setup.firstRun.description` | `#first-run-description` (850) | `firstRunExperience.test.mjs` (owner-verbatim line) | `firstRunExperience.js` description write |

Other key-only sites (nested markup or pinned literals, value seeded, no
attribute): `cockpit.presets.title` (dock-label-icon span),
`cockpit.presets.mapSourceLabel` + `cockpit.presets.mapSourceChipsAriaLabel`
(`mapStackChips.test.mjs` pins), `cockpit.display.title`
(`panelStackLayout.test.mjs` pins), `cockpit.brief.kicker` (live-dot `<i>`),
`cockpit.location.toolbarLabel` (dock-label-icon span),
`layers.radio.bandLabel` (`radioMarkup.test.mjs` pins).

Deferred to phase-3 core-ui (no key yet, static site carries markup the
attribute write would destroy): `#context-mode-standby` description text —
one span holding BOTH mode descriptions split by a literal `<br>`; split it
into two keys at the runtime write. `.cockpit-help` (`ESC EXIT · C TOGGLE`)
— keyboard-key syntax around a styled separator span; treat keys as machine
values and localize only the words if at all.

## Keep-English boundary (never catalog these)

- **Internal layer IDs and registry keys** — `military-installations`,
  `local-firms`, `ais-live-vessels`, stack ids (`photoreal`, `bing-aerial`,
  `osm`), and every `layer.id` used for state, persistence, and lookups.
- **Status enums / machine values** — the KEYS of `FEED_STATE_LABELS`
  (`nominal`, `degraded`, …), lifecycle states (`enabling`, `disabling`),
  `LAYER_STATE_REGISTRY` values, detection/context mode identifiers. Translate
  only the final label value at the presentation boundary.
- **URL/hash contracts** — share-link parameters (`cam`, `view`, `scene`, …),
  `?welcome=`, `?lang=` itself, and the `gev:layer-state:v2` storage schema.
- **API fields and protocol values** — upstream JSON field names, voice tool
  names/schemas, `/api/setup/*` payloads, provider capability flags.
- **Provider, dataset, and product names** — OpenSky, adsb.lol, AISStream,
  OpenStreetMap/Overpass, NASA FIRMS, TomTom, Radio Browser, Open-Meteo,
  Google, Cesium ion; callsigns, vessel/satellite names, place names from
  data, news headlines, and license/source attribution strings (required
  verbatim by providers).
- **Console diagnostics** — `console.warn/info` messages with `[Init]`,
  `[Data]`, `[MapStack]` prefixes: developer-facing, stay English.
- **QA pin scripts** — `scripts/qa-*.mjs`, `scripts/track-regression.mjs`
  (untouchable this branch) and `window.__gevQa*` hooks.
- **Existing test expectations** — `.test.mjs` files asserting exact English
  strings stay valid in the default locale; do not rewrite them while
  extracting. New locale-aware assertions go in new tests.
- **User-authored content** — annotations, labels drawn from live data.

## Open risks / notes for stage-2 workers

- Spanish expansion vs. fixed-width panels (`nowrap`/ellipsis): report
  clipping with screenshots; prefer concise glossary copy over CSS surgery.
- `?lang=` must never be written into share links; `sharelink.js` builds
  URLs from the hash only — keep it that way when touching share copy.
- The DEV-only missing-key warning does not fire under `node:test`; browser
  dev-server QA is the coverage surface for missing-key detection.
- `persistLocaleAndReload` cannot persist where storage is blocked (private
  mode): the reload still happens; the choice just does not survive.
