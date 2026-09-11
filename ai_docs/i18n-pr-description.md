# PR draft: EN/ES interface localization (i18n)

> Working draft for the feature/i18n pull request. Trim or adapt when opening
> the PR; all counts and file references verified at branch HEAD `2db4440`.

## Summary

The application-owned interface now ships in English and Spanish. UI text
moved into four flat message catalogs per locale
(`src/i18n/locales/{en,es}/{shell,cockpit,layers,setup}.js` — 897 keys per
locale at HEAD: shell 34, cockpit 364, layers 384, setup 115) with a small
runtime (`src/i18n/locale.js`, `src/i18n/index.js`) owning locale
resolution, guarded storage, interpolation, plural selection, Intl
formatters, and DOM application. English stays the default, the source
catalog, and the fallback: a key missing in Spanish renders its English
value. Translator-facing documentation is in
[`docs/TRANSLATORS.md`](../docs/TRANSLATORS.md); the binding ownership and
keep-English contract is `ai_docs/i18n-ownership.md`.

## What changes

- **Catalogs.** Four namespaces per locale (`shell`, `cockpit`, `layers`,
  `setup`), mirrored key-for-key between `en` and `es`. Key naming is
  `<namespace>.<surface>.<element>` (markup) and
  `<namespace>.<flow>.<state>` (runtime). Names are append-only and never
  renamed.
- **Locale resolution.** `?lang=<locale>` URL override (search string only;
  one-shot) → stored preference (`gev:locale:v1` in local storage) →
  `navigator.languages` (regional variants like `es-MX` / `es_419` normalize
  to `es`) → `en`. Unsupported values defer to the next step.
  `<html lang>` / `<html dir>` always reflect the rendered language.
- **Selector.** A compact EN|ES switch in the command dock
  (`.dock-locale-switch` / `.dock-locale-btn` in `index.html`, wired by
  `ui.js` `_initLocaleSelector()`). A click stores `gev:locale:v1` and
  reloads the page, preserving the URL hash (an active share link survives
  the switch) and stripping any `?lang=` param.
- **Runtime API.** `t(key, params)` with named `{camelCase}` placeholders
  and `{ one, other }` plural variants selected through
  `Intl.PluralRules`; `formatNumber` / `formatDate` Intl helpers;
  `applyDocumentTranslations()` for `data-i18n*` markup.
- **Gates.** Four test files under `src/i18n/` (31 tests):
  `catalog.test.mjs` (en/es key, placeholder-name, and plural-shape parity,
  with the strict `REQUIRE_FULL_ES_PARITY` gate ON — flipped by commit
  `c91a923`; `GEV_I18N_REQUIRE_FULL_ES_PARITY=0` stages incomplete work),
  `markupCoverage.test.mjs` (every `data-i18n*` attribute in `index.html`
  resolves in both catalogs; unknown spellings fail), `i18n.test.mjs`
  (precedence, guards, fallback, interpolation, plurals, DOM apply), and
  `repairPass.test.mjs` (en byte-identity anchors + the eleven reviewed es
  one-string fixes).
- **Docs.** `docs/TRANSLATORS.md` (translator guide: namespaces, append-only
  rules, glossary, keep-English boundary, locale recipe, gates),
  CHANGELOG entry, and an Internationalization section in
  `docs/CURRENT-STATE.md` (including accepted deferrals).

## What does NOT change

- **Machine-facing contracts stay English byte-for-byte:** internal layer
  IDs and registry keys, status enums and lifecycle values, voice tool
  names and schemas (`src/voice/gevActions.js` tool results included),
  `/api/setup/*` payloads, share-link parameters and the `?lang=` /
  `?welcome=` / storage schema contracts, provider and dataset names, and
  license/source attribution strings.
- **Existing English output is pinned:** `repairPass.test.mjs` anchors the
  extracted English literals byte-identical; all English test expectations
  are unchanged (one sanctioned exception is called out in the reviewer
  notes below).
- **No new runtime dependencies:** the subsystem uses only `Intl`,
  `localStorage`, `URL`, and `node:test` in tests.
- **No behavioral change for English users:** default resolution still ends
  at `en`, and share links, hashes, and stored layer state resolve exactly
  as before the branch.

## How to test

1. **i18n gates** (fast, deterministic):

   ```sh
   node --test src/i18n/        # expect: 31 tests, 31 pass, 0 fail
   ```

2. **Full suite:**

   ```sh
   npm test
   ```

   Expect green except two pre-existing, non-i18n caveats:

   - `src/devFreshDotenv.test.mjs` "external-keys provenance" fails when a
     provider key (e.g. `OPENAI_API_KEY`) is exported in the running
     environment; it passes in a clean environment (the shell block under
     test is correct — a clean-env probe prints an empty provenance CSV).
     The same file's bash-probe test skips on Windows (`win32`).
   - `src/keySetupHardening.test.mjs` "Windows production hardener…" skips
     on non-Windows and runs on Windows.

   Observed on macOS / Node 26 at this head: **2738 tests, 2736 passed,
   1 skipped, 1 failed** (the environmental one above). Under Node 24 —
   the runtime the GC-bracketed allocation budgets are calibrated on — the
   two allocation microbenchmark files additionally run (see
   `scripts/run-unit-tests.mjs`), so the exact total varies a little by
   platform and engine; the caveats, not the raw total, are the contract.

3. **Manual `?lang=es` walkthrough:**

   1. Serve the app (`npm run dev`) and open it with `?lang=es` — the UI
      renders Spanish; `<html lang="es" dir="ltr">` is set; the dock shows
      ES active.
   2. Reload without `?lang=` — Spanish persists (stored
      `gev:locale:v1`), and the URL never re-gains `?lang=`.
   3. Click EN in the dock — the page reloads with the hash preserved and
      renders English; clicking ES switches back.
   4. Spot-check surfaces: cockpit readouts (`VEL. SUELO` / `ALTITUD` /
      `RUMBO`, `BRG —` instrument codes kept), Context panel
      (`CONTACTOS`, `CONTEXTO GLOBAL`), layers panel (`CAPAS DE DATOS`),
      CCTV coverage toast (`COBERTURA ACTIVADA`), key-setup chip
      (`ENCENDER · N CLAVE(S) EN ESPERA`), toasts and the clear-layers
      plural toast (`Se limpió 1 capa de datos` / `Se limpiaron N capas de
      datos`).
   5. Confirm keep-English boundaries: layer IDs in the URL/hash, provider
      names, news headlines, and callsigns are untouched; the cockpit-brief
      tab tokens `SIG` / `NEWS` / `LOCAL` stay as-is (their aria-labels are
      localized).

## Screenshots

- [ ] Shell + dock with the EN|ES switch (EN)
- [ ] Same view in ES (`?lang=es`)
- [ ] Cockpit HUD in ES (readouts: VEL. SUELO / ALTITUD / RUMBO)
- [ ] Layers panel in ES (CAPAS DE DATOS, feed-state labels)
- [ ] Key setup / POWER UP chip in ES (ENCENDER)
- [ ] Clear-layers plural toast in ES (one/other)

## Reviewer notes

Two pre-approved edits to existing test expectations — everything else
English-side is byte-identical:

1. **Sanctioned es-plural test edit** (commit `f145246`): the two es-seed
   assertions in `src/i18n/i18n.test.mjs` for `layers.clear.toast.cleared`
   had pinned the transitional stage-3 English seed values. They now assert
   the translated es values ("Se limpió 1 capa de datos" / "Se limpiaron 3
   capas de datos") and still exercise `one`/`other` selection through
   `Intl.PluralRules` with counts 1 and 3. The `en` assertions in the same
   test are byte-identical.
2. **Strict parity flip** (commit `c91a923`, recorded in the ownership
   manifest by `c1c056e`): `REQUIRE_FULL_ES_PARITY` in
   `src/i18n/catalog.test.mjs` defaults ON now that all four es catalogs
   are fully translated. `GEV_I18N_REQUIRE_FULL_ES_PARITY=0` remains as the
   escape hatch for staging future locales, not for shipping drift.

Also worth knowing: the es clip fix is the single sanctioned es-scoped CSS
rule (`html[lang='es'] .cctv-controls { flex-wrap: wrap; }`, commit
`acb357b`) — Spanish copy elsewhere was shortened rather than patched with
per-locale CSS.

## Non-goals

- **RTL locales:** both shipped locales are LTR; the `<html dir>` machinery
  exists, but no RTL locale ships and no RTL styling audit happened.
- **Regional variants:** `normalizeLocale()` maps `es-MX` / `es_419` →
  `es`, but no per-variant catalogs or regional copy differences ship.
- **README translation:** the README stays English; translators get
  `docs/TRANSLATORS.md` instead.
- **Locale-aware number formatting policy:** the pre-i18n `toLocaleString`
  call sites (e.g. `src/ui.js`, `src/data/satellites.js`,
  `src/data/flights.js`, `src/data/rocketLaunches.js`) are deferred and
  documented in `docs/CURRENT-STATE.md`; the `formatNumber` helper exists
  for when that policy lands.

> **`npm run test:track`**: run on an otherwise-idle machine — the SwiftShader harness is CPU-bound, and concurrent heavy processes (builds, containers, extra dev servers) can produce protocol timeouts and fixture-cleanup races unrelated to this change.
