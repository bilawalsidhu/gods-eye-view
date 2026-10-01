# Translator's guide (i18n foundation — English shipped)

This is the working guide for translating God's Eye View. The i18n
foundation ships **English only**: the locale core, the English
catalogs, and the parity gates are in, and every additional locale lands
as its own stacked PR, one locale at a time, following the
[locale-addition recipe](#the-locale-addition-recipe) below. That recipe
is the deliberate design artifact of this phase — a locale is not
"translated into the app", it is *shipped* through the same gate every
time.

## Which locale ships, and which pair is offered

One catalog ships: **en** (source of truth and unconditional fallback).
Shipping is catalog-driven (`CATALOG_LOCALES` in `src/i18n/locale.js`):
while only English ships, the built-in locale pair is en-only and the
dock language switch renders a single EN button. Which pair the app
*offers* is configuration, not code: `GEV_DEFAULT_LOCALE` and
`GEV_SECONDARY_LOCALE` in `.env`, injected into the browser via vite
defines. Both values are validated against the shipped catalogs — an
invalid, unshipped, or degenerate pair (e.g. the same locale twice)
degenerates to the built-in en-only shape with a dev-server-only
`console.warn`. English is always resolvable — it is the fallback
catalog — even when not part of the configured pair.

## How the catalog system works

All application-owned UI text lives in four flat message catalogs (en
today; one directory per locale once shipped):

```text
src/i18n/
  locale.js                  pair config + resolution + storage + <html lang>/<html dir>
  index.js                   catalog registry, t(), Intl formatters, DOM apply
  locales/en/{shell,cockpit,layers,setup}.js
```

| Namespace | Surface |
| --- | --- |
| `shell.*` | Document chrome: title, dock actions, panels, global status chip, sync chips, toasts, locale selector |
| `cockpit.*` | Cockpit HUD readouts, Context panel, CCTV scene summary, Display/panel chrome, visual presets, Radio utility |
| `layers.*` | Data-layer presentation: layer names, feed-state labels, row meta, vessel/flight/satellite/mission/CCTV/Radio/awareness cards and readouts |
| `setup.*` | First-run launcher, key setup (POWER UP), scenes/director status, map-stack chips |

Each catalog file exports `NAMESPACE` and a default map of
namespace-relative keys; `mergeNamespace()` prefixes them (`cockpit.…`)
and `buildCatalog()` rejects duplicates. English is the default and the
fallback locale: a key missing in another locale renders its English
value (dev-server-only `console.warn`). The en catalogs hold 912 keys
(shell 34, cockpit 369, layers 388, setup 121).

## Key naming

- Markup surfaces: `<namespace>.<surface>.<element>` — e.g.
  `shell.panels.dataLayers`, `cockpit.readout.altitude`.
- Runtime flows/states: `<namespace>.<flow>.<state>` — e.g.
  `shell.status.loadingLiveData`, `layers.missions.telemetry.km`.
- Names are semantic and stable. Never rename, reorder, or renumber an
  existing key: `data-i18n` attributes and runtime `t()` call sites in other
  files reference them.

## The locale-addition recipe

Every locale PR follows the same steps, in this order. Nothing here is
optional — the gates below fail the build if a step is skipped.

1. **Catalogs.** Copy `src/i18n/locales/en/` to
   `src/i18n/locales/<code>/` and translate all four files
   (`<code>` is the primary language tag: `es`, not `es-419`). Keep the
   en key order, keep key names byte-identical, and translate VALUES
   only. A locale may never carry a key en lacks.
2. **Registration.** In `src/i18n/index.js`: add the four import lines
   and one `<CODE>_NAMESPACES` array, then one entry in the `CATALOGS`
   map. Registration is append-only; nothing else in the file changes.
3. **Shipping.** Append `'<code>'` to `CATALOG_LOCALES` in
   `src/i18n/locale.js`. This single constant is what makes the locale
   normalizable-to-shipped: pair config, `?lang=`, storage, and the
   selector all read from it. Regional variants (`es-MX`, `es_419`)
   already normalize — locale-code hygiene is shipped ahead of the
   locales on purpose.
4. **Selector labels.** Append
   `'locale.<code>.ariaLabel': 'Switch to <Language>'` to the `shell`
   catalog of EVERY shipped locale (en included — the en catalog names
   the new button; the new catalog names the English one).
   `markupCoverage.test.mjs` requires a label for every shipped code in
   every catalog, so this cannot be forgotten.
5. **Plurals.** Plural entries are variant objects carrying a `{count}`
   placeholder, selected per active locale through `Intl.PluralRules`.
   English entries use `{ one, other }`. Your locale must keep every en
   variant and may add ONLY categories `Intl.PluralRules` reports valid
   for it (e.g. a Slavic locale adds `few`/`many`) —
   `catalog.test.mjs` enforces this shape against the live ICU data.
   Pin your locale's real-catalog plural agreement in
   `src/i18n/i18n.test.mjs` (one/few/many/other counts where relevant).
6. **Layout.** Prefer concise glossary-approved copy over CSS surgery;
   fixed-width `nowrap` panels must be checked at narrow viewports. A
   locale-scoped wrap rule (`html[lang='<code>'] .cctv-controls {
   flex-wrap: wrap; }` in `src/ui/styles/cctv.css`) is added ONLY when
   the locale demonstrably clips, with a comment recording the measured
   widths — the English layout stays pixel-identical, and
   `repairPass.test.mjs` rejects a wrap rule shipping ahead of its
   locale.
7. **Gates.** `node --test src/i18n/` must be green with the strict
   parity gate ON: exact key-set equality with en, identical
   placeholder names, plural-shape superset. While a new catalog is a
   staged untranslated seed, CI may run with
   `GEV_I18N_REQUIRE_FULL_LOCALE_PARITY=0` (subset mode) — record every
   such flip here, and record the flip back.
8. **Docs.** Add the locale's section + glossary to this file, note it
   in `docs/CURRENT-STATE.md` (Internationalization) and `CHANGELOG.md`,
   and update the shipped-locales wording in `.env.example`.

## Append-only rules

- New keys are appended to the END of the namespace file in EVERY
  shipped locale directory in the same change. Never edit another
  namespace's files, and never touch the registration arrays in
  `src/i18n/index.js` without re-reading this guide first.
- A fifth namespace is a last resort (prefer fitting one of the four); its
  registration recipe is the same append-only pattern as a locale (step 2
  of the recipe above), applied to every shipped locale at once.
- Parity is enforced by tests, not goodwill: no locale may carry a key en
  lacks, and every shared key must keep identical placeholder names
  and a plural-variant set that includes every en variant plus only
  categories `Intl.PluralRules` reports for that locale
  (`src/i18n/catalog.test.mjs`).

## Placeholder, plural, and typography rules

- Interpolation uses named `{camelCase}` placeholders:
  `'Flying to {place}…'`. The **same placeholder names must exist in
  every locale** — the parity gate fails on a renamed `{name}` because
  it would break interpolation at runtime.
- Locale-aware numbers, dates, and relative times go through the
  `formatNumber` / `formatDate` / `formatRelativeTime` helpers in
  `src/i18n/index.js` — do not hand-format in a catalog call site.
- Style: the English catalog is ALL-CAPS for tactical labels, readouts,
  and status text; translations follow the same convention in their
  script's norms. The `·` separator used between metadata segments is
  part of the surface style and is reproduced in translations.
- Instrument codes stay identical across languages; units (KTS, FT, km,
  km²) are never translated.
- Romance languages run ~25% longer than English and Slavic languages
  compound that on multi-word tactical labels — plan string budgets and
  check fixed-width panels before review (see step 6 above).

## Keep-English boundary (summary)

Never catalog these — they are contracts, not copy:

- Internal layer IDs and registry keys (`military-installations`,
  `ais-live-vessels`, stack ids).
- Status enums and machine values (`FEED_STATE_LABELS` keys, lifecycle
  states, detection/context modes) — translate only the final label at
  the presentation boundary.
- URL/hash contracts: share-link parameters, `?welcome=`, `?lang=`,
  storage schemas.
- API fields, voice tool names/schemas, `/api/setup/*` payloads.
- Provider/dataset/product names, callsigns, vessel/satellite/place
  names from data, news headlines, license/source attributions.
- Console diagnostics, QA pin scripts, and existing exact-English test
  expectations.
- User-authored content (annotations, labels drawn from live data).

Adjudicated exceptions live in "Internationalization" in
[`docs/CURRENT-STATE.md`](./CURRENT-STATE.md) (accepted deferrals — do not
"fix" them silently).

## Glossary

Approved recurring terms per locale. Each locale PR appends its
 glossary here (English term · translation · catalog evidence) so later
 translators reuse approved copy verbatim. None yet — the first entry
 arrives with the first translated locale.

## Running the i18n test gates

```sh
node --test src/i18n/            # 40 tests: core + pair config, catalog parity, markup coverage, repair-pass anchors
npm test                         # full suite (see below for the known environmental caveat)
```

- `src/i18n/i18n.test.mjs` — resolution precedence, guarded storage,
  fallback, interpolation, plural selection (contract + synthetic
  missing-category degradation; real-catalog plural pins arrive with
  each locale PR), DOM application.
- `src/i18n/catalog.test.mjs` — key + placeholder + plural-shape parity for
  every shipped locale against en, strict `REQUIRE_FULL_PARITY` gate
  (vacuous while only en ships; each locale PR meets it from day one).
- `src/i18n/markupCoverage.test.mjs` — every `data-i18n*` attribute in
  `index.html` must resolve in every shipped catalog; unknown attribute
  spellings fail loudly.
- `src/i18n/repairPass.test.mjs` — byte-identity anchors for English
  literals; per-locale value anchors arrive with each locale PR.

Full-suite caveat: `src/devFreshDotenv.test.mjs`'s external-keys provenance
test fails when a provider key (e.g. `OPENAI_API_KEY`) is exported in the
running shell — an environmental false positive unrelated to i18n.
