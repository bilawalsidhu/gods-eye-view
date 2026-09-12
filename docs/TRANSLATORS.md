# Translator's guide (English / Spanish / French)

This is the working guide for translating God's Eye View. The authoritative
contract — file ownership, namespace registration, and the keep-English
boundaries in full — is [`docs/TRANSLATORS.md`](../docs/TRANSLATORS.md);
this file is the practical summary a translator needs.

## Which locales ship, and which pair is offered

Three catalogs ship: **en** (source of truth and unconditional fallback),
**es** and **fr** (both fully translated; each mirrors
en key-for-key with English values). Which pair the app actually *offers* is
configuration, not code: `GEV_DEFAULT_LOCALE` (default `en`) and
`GEV_SECONDARY_LOCALE` (default `es`) in `.env`, injected into the browser via
vite defines. Invalid or degenerate values fall back to the built-in en+es
pair (dev-server-only `console.warn`). English is always resolvable — it is
the fallback catalog — even when not part of the configured pair.

## How the catalog system works

All application-owned UI text lives in four flat message catalogs per locale:

```text
src/i18n/
  locale.js                  pair config + resolution + storage + <html lang>/<html dir>
  index.js                   catalog registry, t(), Intl formatters, DOM apply
  locales/en/{shell,cockpit,layers,setup}.js
  locales/es/{shell,cockpit,layers,setup}.js
  locales/fr/{shell,cockpit,layers,setup}.js   (fully translated)
```

| Namespace | Surface |
| --- | --- |
| `shell.*` | Document chrome: title, dock actions, panels, global status chip, sync chips, toasts, locale selector |
| `cockpit.*` | Cockpit HUD readouts, Context panel, CCTV scene summary, Display/panel chrome, visual presets, Radio utility |
| `layers.*` | Data-layer presentation: layer names, feed-state labels, row meta, vessel/flight/satellite/mission/CCTV/Radio/awareness cards and readouts |
| `setup.*` | First-run launcher, key setup (POWER UP), scenes/director status, map-stack chips |

Each catalog file exports `NAMESPACE` and a default map of
namespace-relative keys; `mergeNamespace()` prefixes them (`cockpit.…`) and
`buildCatalog()` rejects duplicates. English is the default and the fallback
locale: a key missing in another locale renders its English value
(dev-server-only `console.warn`). At the time of writing the catalogs mirror
each other — shell 35, cockpit 364, layers 384, setup 115 keys (898 per
locale).

## Key naming

- Markup surfaces: `<namespace>.<surface>.<element>` — e.g.
  `shell.panels.dataLayers`, `cockpit.readout.altitude`.
- Runtime flows/states: `<namespace>.<flow>.<state>` — e.g.
  `shell.status.loadingLiveData`, `layers.missions.telemetry.km`.
- Names are semantic and stable. Never rename, reorder, or renumber an
  existing key: `data-i18n` attributes and runtime `t()` call sites in other
  files reference them.

## Append-only rules

- New keys are **appended to the end** of your namespace file in **every**
  shipped locale directory (`locales/en/`, `locales/es/`, `locales/fr/`) in the
  same change. Never edit another namespace's files, and never touch the
  registration arrays in `src/i18n/index.js` without reading the ownership
  manifest first.
- A fifth namespace is a last resort (prefer fitting one of the four); the
  registration recipe for one is in the ownership manifest.
- Parity is enforced by tests, not goodwill: es may never carry a key en
  lacks, and every shared key must keep identical placeholder names and
  plural-variant shapes (`src/i18n/catalog.test.mjs`).

## Placeholder, plural, and typography rules

- Interpolation uses named `{camelCase}` placeholders: `'Flying to {place}…'`.
  The **same placeholder names must exist in every locale** — the parity gate
  fails on a renamed `{name}` because it would break interpolation at runtime.
- Plurals are `{ one, other }` variant objects carrying a `{count}`
  placeholder, selected per active locale through `Intl.PluralRules`:
  ```js
  'clear.toast.cleared': { one: 'Cleared {count} data layer', other: 'Cleared {count} data layers' },
  ```
- Locale-aware numbers, dates, and relative times go through the
  `formatNumber` / `formatDate` Intl helpers in `src/i18n/index.js` — do not
  hand-format in a new catalog string's call site.
- Style: the English catalog is ALL-CAPS for tactical labels, readouts, and
  status text; Spanish follows the same convention. The `·` separator used
  between metadata segments is part of the surface style and is reproduced in
  translations.
- Instrument codes stay identical across languages (see the aviation terms
  below); units (KTS, FT, km, km²) are never translated.
- Spanish runs ~25% longer than English. Prefer concise glossary-approved
  copy over CSS surgery; fixed-width `nowrap` panels must be checked at
  narrow viewports. The one sanctioned es-scoped CSS rule so far is
  `html[lang='es'] .cctv-controls { flex-wrap: wrap; }` (`style.css`) — add
  others only when Spanish demonstrably clips and no shorter copy works.
- Spanish review conventions that produced fixes in the past: `o → u`
  before i- words ("BUQUE U INSTALACIÓN"), adjective agreement with the
  fallback noun ("entidad … COMPARTIDA"), consistent word order
  ("RESPALDO DE SUPERFICIE"), and no copy that ellipsis-truncates in its
  container ("Mantén Espacio para hablar").

## Glossary

Approved recurring terms (from the Spanish catalog — reuse these verbatim):

| English | Spanish | Catalog evidence |
| --- | --- | --- |
| Contacts | Contactos / CONTACTOS | `cockpit.context.standbyContactsDesc` |
| Context | Contexto | `layers.name.globalContext` ("Contexto global") |
| Tracked / Tracking | Rastreado / Rastreo | `cockpit.context.tr3bAriaLabel` ("contacto rastreado"), `cockpit.hud.metaFeedLive` ("RASTREO EN VIVO") |
| Coverage | Cobertura | `layers.cctv.coverageOn` ("COBERTURA ACTIVADA") |
| Layer | Capa | `shell.panels.dataLayers` ("CAPAS DE DATOS") |
| Feed | Fuente | `cockpit.hud.metaFeedStale` ("FUENTE DESACTUALIZADA") |
| View | Vista | `shell.actions.resetView.title` ("vista del globo completo") |
| Cockpit | Cabina | `cockpit.exit.label` ("SALIR DE CABINA") |
| POWER UP (key setup) | ENCENDER | `setup.keySetup.chip`, `setup.keySetup.chipWaiting` ("ENCENDER · {count} CLAVE(S) EN ESPERA") |

Aviation terms: ground speed → **VEL. SUELO**, altitude → **ALTITUD**,
heading/course → **RUMBO** (`cockpit.readout.*`). Bearing keeps the compact
instrument codes **BRG** / **DEST** — the Spanish review reverted a
spelled-out `MARC —` (MARCACIÓN) to `BRG —` under the instrument-code rule:
readout codes a pilot reads identically in every language stay identical.

## Keep-English boundary (summary)

Never catalog these — they are contracts, not copy:

- Internal layer IDs and registry keys (`military-installations`, `ais-live-vessels`, stack ids).
- Status enums and machine values (`FEED_STATE_LABELS` keys, lifecycle states, detection/context modes) — translate only the final label at the presentation boundary.
- URL/hash contracts: share-link parameters, `?welcome=`, `?lang=`, storage schemas.
- API fields, voice tool names/schemas, `/api/setup/*` payloads.
- Provider/dataset/product names, callsigns, vessel/satellite/place names from data, news headlines, license/source attributions.
- Console diagnostics, QA pin scripts, and existing exact-English test expectations.
- User-authored content (annotations, labels drawn from live data).

The full, binding list is "Keep-English boundary" in
[`docs/TRANSLATORS.md`](../docs/TRANSLATORS.md).

## Adding a new locale

1. **Copy the four namespace files** from `src/i18n/locales/en/` into
   `src/i18n/locales/<locale>/` and translate the values. Keep every key,
   placeholder name, and plural-variant shape identical to English.
2. **Extend the resolution map in `src/i18n/locale.js`**: add the tag to
   `CATALOG_LOCALES` and a `LOCALE_METADATA` entry with the correct `dir`
   (all shipped locales are LTR). `normalizeLocale()` maps regional
   variants (`es-MX`, `fr_419`) to the primary tag automatically. Shipping a
   catalog does not activate it: activation is pair-scoped by
   `GEV_DEFAULT_LOCALE` / `GEV_SECONDARY_LOCALE` (see above).
3. **Register the catalogs in `src/i18n/index.js`**: one import and one
   array entry per namespace file, alongside the `en`/`es` blocks.
4. **Update the gates**: the shipped-locales pin in
   `src/i18n/catalog.test.mjs` asserts `['en', 'es', 'fr']` and must list the
   new locale in the same change. The strict parity gate
   (`REQUIRE_FULL_PARITY`) covers **every** shipped locale and is **on**;
   while your new catalog is incomplete you may stage work with
   `GEV_I18N_REQUIRE_FULL_LOCALE_PARITY=0 npm test` (the older
   `GEV_I18N_REQUIRE_FULL_ES_PARITY` spelling still works), then rely on the
   default once translation completes (record flips in the ownership
   manifest, as done for Spanish in commit `c91a923`).
5. **Selector aria-label**: add `shell.locale.<code>.ariaLabel` for the new
   locale code to every `shell.js` catalog — the runtime-rendered dock switch
   reads that key per offered locale.

## Running the i18n test gates

```sh
node --test src/i18n/            # 38 tests: core + pair config, catalog parity, markup coverage, repair-pass anchors
npm test                         # full suite (see below for the known environmental caveat)
```

- `src/i18n/i18n.test.mjs` — resolution precedence, guarded storage,
  fallback, interpolation, plural selection, DOM application.
- `src/i18n/catalog.test.mjs` — key + placeholder + plural-shape parity for
  every shipped locale against en, strict `REQUIRE_FULL_PARITY` gate.
- `src/i18n/markupCoverage.test.mjs` — every `data-i18n*` attribute in
  `index.html` must resolve in both catalogs; unknown attribute spellings
  fail loudly.
- `src/i18n/repairPass.test.mjs` — byte-identity anchors for English
  literals and the reviewed Spanish fixes.

Full-suite caveat: `src/devFreshDotenv.test.mjs`'s external-keys provenance
test fails when a provider key (e.g. `OPENAI_API_KEY`) is exported in the
running shell — an environmental false positive unrelated to i18n.
