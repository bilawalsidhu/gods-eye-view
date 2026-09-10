# i18n implementation plan: English + Spanish

Status: implementation plan  
Branch: `feature/i18n`  
Primary locale: `en`  
Initial additional locale: neutral international Spanish (`es`)

## Objective

Add a maintainable localization system that makes the complete application-owned
UI available in English and Spanish without changing internal data contracts,
share-link formats, provider identifiers, or the existing English experience.

The result should be suitable for upstream review: small, dependency-light,
accessible, testable, visually checked at narrow and desktop layouts, and easy
for a future contributor to extend with another locale.

## Current constraints and findings

- The app is vanilla JavaScript + Cesium + Vite; there is no component framework
  or existing i18n boundary.
- `index.html` contains the static shell, controls, dialogs, cockpit HUD, and
  accessibility attributes.
- `src/ui.js` owns most runtime UI behavior and is the largest integration
  hotspot. Other runtime copy is spread across HUD, first-run, setup, scene,
  loading, overlay, voice, and data-layer modules.
- Existing tests assert exact English markup and presentation strings. English
  behavior must remain the default and those tests should not be needlessly
  rewritten.
- Several panels use fixed widths and nowrap/ellipsis rules. Spanish expansion
  requires layout QA and selective wrapping or concise translations.
- Internal status values, layer IDs, URL/hash keys, API fields, provider names,
  callsigns, place names, news headlines, and source attributions are not UI
  translations.

## Product decisions

1. Locale resolution order:
   `?lang=<locale>` override, stored preference, browser language list, then
   English.
2. Persist the preference under a guarded, versioned key such as
   `gev:locale:v1`.
3. The language control is a compact `EN / ES` selector placed in an existing
   settings/dock surface; do not add a new floating panel.
4. Changing the selector reloads the page while preserving the existing URL
   hash. This prevents stale text in already-rendered dynamic panels.
5. Set `<html lang>` and `dir` from locale metadata. Spanish is LTR.
6. English remains the source/fallback catalog and must be visually equivalent
   to the current interface.
7. Translation functions return text. Dynamic DOM writes continue to use
   `textContent`; do not translate arbitrary HTML by string replacement.
8. Use browser `Intl` APIs for numbers, dates, relative times, and plurals.
9. Keep voice tool names, schemas, protocol values, and server-side tool
   descriptions in English. Localize voice-control chrome and status text only
   in the first release.

## Proposed files

```text
src/i18n/
  index.js
  locale.js
  locales/
    en/
      shell.js
      cockpit.js
      layers.js
      setup.js
    es/
      shell.js
      cockpit.js
      layers.js
      setup.js
  i18n.test.mjs
  catalog.test.mjs
```

The exact split may be simplified if the catalogs remain reviewable. Separate
namespaces prevent parallel agents from editing one giant Spanish file.

Suggested public API:

```js
getLocale()
setLocale(locale)
t(key, values)
formatNumber(value, options)
formatDate(value, options)
applyDocumentTranslations(document)
```

Use semantic keys (`cockpit.controls.exit`) rather than English sentences as
keys. Support named interpolation and `one`/`other` plural variants. Missing
Spanish keys fall back to English and emit a development-only warning.

## Translation scope

### Translate

- Static shell, title/subtitle copy, loading and first-run experience
- Dock, Display, visual presets, map-source controls, and Data Layers
- Cockpit and Context panels
- CCTV, radio, scenes, Provider Settings, and key-setup feedback
- Toasts, loading/error/empty/retry states, live-region announcements
- App-authored map cards and telemetry labels
- `aria-label`, `title`, `placeholder`, and other accessible names
- Locale-sensitive number/date/duration/relative-time formatting
- Voice-control UI labels and connection/execution status

### Keep unchanged

- Product, provider, source, and dataset names
- Callsigns, vessel names, satellite names, coordinates, and user annotations
- News headlines and upstream source text
- License/source attribution strings required by providers
- Internal enum/status values, layer IDs, URL/hash parameters, and API schemas
- Console/developer diagnostics and raw upstream error details
- The full README and docs; add only a short language/contributor note

## Implementation phases

### Phase 0: maintainer alignment and baseline

- Confirm the locale selector location and neutral-Spanish terminology with the
  maintainers before broad extraction.
- Rebase `feature/i18n` onto the current upstream `main` before implementation.
- Run and record baseline `npm run build`, `npm test`, and `npm run test:track`.
- Create a string inventory distinguishing presentation copy from data and
  protocol values.

Deliverable: approved scope, ownership manifest, and baseline test evidence.

### Phase 1: localization core

- Add locale normalization (`es`, `es-*` → `es`; unsupported → `en`).
- Add catalog lookup, fallback, interpolation, plural selection, and `Intl`
  formatting helpers.
- Add guarded storage and query-string override.
- Set document language/direction before app initialization.
- Add English and Spanish catalog parity tests.

Deliverable: no visible behavior change in English; core tests pass.

### Phase 2: static markup extraction

- Add `data-i18n`, `data-i18n-title`, `data-i18n-aria-label`, and
  `data-i18n-placeholder` attributes to `index.html`.
- Keep nested icon spans and brand markup intact.
- Add the compact language selector.
- Translate static shell, first-run, cockpit, Context, Display, CCTV, radio,
  scenes, and setup markup.
- Add CSS fixes only where Spanish text demonstrably clips or overflows.

Deliverable: all static application-owned text has a catalog key.

### Phase 3: runtime presentation extraction

- Convert runtime UI strings in `src/ui.js` and `src/hud.js` first.
- Convert `main.js`, `firstRunExperience.js`, `keySetup.js`,
  `loadingFeedback.js`, `mapStackChips.js`, and `scenes/director.js`.
- Convert user-facing presentation paths in data-layer modules: manager,
  flights, military, vessels, CCTV, radio, launches, fires, installations,
  awareness, overlays, and tracked readouts.
- Leave machine-readable statuses and layer names used as identifiers intact;
  translate at the final presentation boundary.
- Replace hardcoded English locale formatting with the active locale while
  keeping coordinate conventions and units unchanged.

Deliverable: normal user flows no longer leak English presentation copy while
Spanish is selected.

### Phase 4: Spanish translation and glossary review

- Translate catalogs with the UI context visible.
- Establish a glossary for recurring terms such as Contacts, Context, Tracked,
  Coverage, Layer, Feed, and View.
- Preserve tactical abbreviations where they are operationally clearer.
- Have a native Spanish reviewer check grammar, tone, capitalization, and
  terminology.

Deliverable: reviewed `es` catalog with no missing or placeholder-only entries.

### Phase 5: verification and upstream handoff

- Add a markup/catalog coverage test for every localization attribute.
- Add tests for locale precedence, persistence, fallback, interpolation, and
  pluralization.
- Verify English snapshots and existing exact-string tests remain valid unless
  the assertion is intentionally made locale-aware.
- Run browser QA at 1440×900, 1280×720, and 390×844 in both locales.
- Exercise first-run, cockpit, Context, CCTV, radio, scenes, setup, loading,
  empty, unavailable, and error states.
- Check keyboard navigation, live regions, accessible names, and 200% zoom.
- Run the repository gates and update `docs/CURRENT-STATE.md`, `CHANGELOG.md`,
  and a short translator guide.

Deliverable: screenshots, test output, changed-file summary, and an upstream
PR description with explicit non-goals.

## Pi multi-agent execution plan

Use an architect/integrator as the parent and no more than four concurrent
workers. Every editing worker uses an isolated worktree and owns a declared set
of files. Workers return concise structured results: changed files, tests run,
remaining risks, and commit hash.

### Sequential setup

The architect creates the i18n core, catalog schema, namespace files, and
ownership manifest before fan-out. This prevents each worker from inventing a
different translation API.

### Parallel worktrees

1. **Static shell worker** — `index.html`, selector markup, static accessibility
   attributes, and related CSS.
2. **Core UI worker** — `src/ui.js`, `src/hud.js`, cockpit, Context, Display,
   and formatting helpers. This is the likely critical path.
3. **Layer presentation worker** — data-layer presentation strings, cards,
   statuses, overlays, loading, and tracked readouts.
4. **Supporting surfaces worker** — setup, first-run, scenes, voice chrome,
   map-stack chips, tests, docs, and catalog tooling.

Workers should use separate catalog namespaces. The integrator resolves the
small number of shared-import conflicts after cherry-picking; do not let
multiple workers freely edit the same catalog or whole-file region.

### Review pass

Run two read-only reviewers in parallel after integration:

- Correctness/security: fallback behavior, unsafe interpolation, internal vs
  display strings, share-link/API stability, and test regressions.
- Spanish/a11y/layout: missing accessible names, terminology, clipping,
  wrapping, and narrow-viewport behavior.

One repair pass follows the consolidated review. Browser screenshots and final
test execution happen only on the integrated worktree.

## Effort and cost estimate

With four GLM-5.3-Flash workers, expected elapsed work is:

- Architecture and inventory: 2–3 hours
- Parallel extraction/catalog work: 6–10 hours
- Integration: 3–5 hours
- Review and repairs: 3–6 hours
- Browser QA and handoff: 6–10 hours

Expected total: **24–40 elapsed hours**, or approximately **2–4 working days**
with an available human reviewer. A prototype may appear in 6–12 hours, but it
should not be treated as upstream-ready.

Using Pi's listed GLM-5.3-Flash rates ($0.075/M input, $0.25/M output, and
$0.015/M cached input), budget approximately **$3–8** for a clean run and set a
hard orchestration cap around **$15** for retries and review passes. Human native
Spanish review is separate and is likely 4–8 hours.

## Acceptance criteria

- English remains the default and is visually/functionally equivalent.
- `es` can be selected, persisted, overridden with `?lang=es`, and restored on
  reload without losing share-link state.
- No missing-key warnings occur during covered Spanish flows.
- Every static localization attribute resolves in both catalogs.
- Existing internal layer, voice, API, and share-link contracts are unchanged.
- Spanish accessible names and live-region announcements are translated.
- No tested viewport clips essential Spanish controls or status text.
- `npm run build`, `npm test`, and `npm run test:track` pass.
- `docs/CURRENT-STATE.md`, `CHANGELOG.md`, and translator guidance are updated.
- PR description includes screenshots, test commands/results, scope, and
  explicit exclusions.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Agents conflict in `src/ui.js` | Assign line/file ownership; use worktrees; integrate centrally. |
| Spanish strings overflow tactical panels | Screenshot all constrained layouts; prefer concise glossary-approved copy. |
| Internal statuses accidentally translated | Keep identifiers in English; translate only at the presentation boundary. |
| Existing source-string tests break | Preserve English defaults and update only intentional locale-aware assertions. |
| Catalog drift blocks future locales | Enforce key and placeholder parity in unit tests. |
| AI translation is grammatically plausible but operationally wrong | Require native review and maintain a glossary. |
| Upstream review scope is too large | Present the architecture first and retain reviewable commits or stacked PRs. |
