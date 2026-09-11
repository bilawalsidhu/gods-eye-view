# i18n: English + Spanish + French interface localization with a configurable locale pair

## Summary

The entire application-owned interface is now localizable and ships fully translated in **English, Spanish, and French** — with the language pair configurable via environment. All machine-facing contracts (layer IDs, status enums, share-link schemas, API fields, voice tool schemas, provider names, attribution) are byte-for-byte unchanged, and the default English experience is byte-identical to `main`.

- **~910 catalog keys per locale** across four namespaces (`shell`, `cockpit`, `layers`, `setup`), mirrored key-for-key under strict CI parity — a missing translation in *any* locale fails the build.
- **Locale resolution:** `?lang=` override → stored preference (`gev:locale:v1`) → browser language (regional variants normalize: `es-MX`→`es`, `fr-CA`→`fr`) → configured default.
- **Dock selector** renders the configured pair dynamically (`EN | ES`, `FR | EN`, …) with native-name accessible labels; switching preserves the share-link hash exactly and never leaks `?lang` into copied links.
- **Configurable pair** via `.env`: `GEV_DEFAULT_LOCALE` (default `en`) / `GEV_SECONDARY_LOCALE` (default `es`). `en` always ships as the source-of-truth fallback; invalid or degenerate pairs fall back to `en`+`es` with a dev-only warning. Browser-language detection keeps priority over the configured default.
- **Zero new dependencies** — plain JS modules, `Intl`, `localStorage`, `URL`.

## What changes

| Area | Detail |
|---|---|
| `src/i18n/` | New subsystem: `locale.js` (normalization, resolution, storage, `<html lang/dir>`), `index.js` (`t()` with `{named}` interpolation + `{one,other}` plurals via `Intl.PluralRules`, Intl formatters, `applyDocumentTranslations()` for `data-i18n*` attributes, hash-preserving reload) |
| Catalogs | `src/i18n/locales/{en,es,fr}/{shell,cockpit,layers,setup}.js` — append-only, semantically keyed (`cockpit.readout.groundSpeed`), never renamed |
| Extraction | 266 static `data-i18n*` attributes in `index.html` + 444 runtime `t()` call sites across 28 modules; localization happens at the final presentation boundary only |
| Selector | Runtime-rendered in the command dock from the configured pair (`ui.js _initLocaleSelector`) |
| Config | `GEV_DEFAULT_LOCALE` / `GEV_SECONDARY_LOCALE` → `loadEnv` → explicit `import.meta.env` defines → `locale.js` (verified end-to-end in the built bundle: zero raw env names leak into assets) |
| Tests | `src/i18n/` suites — 38 tests: strict en↔es↔fr key/placeholder/plural parity, markup coverage for every `data-i18n*` attribute, resolution precedence, interpolation/plural/DOM application, en byte-identity anchors, review-repair anchors |
| Docs | `docs/TRANSLATORS.md` (glossary, conventions, add-a-locale recipe), Internationalization section in `docs/CURRENT-STATE.md`, CHANGELOG |
| Infra (bonus, droppable) | One `chore(docker)` commit adds an isolated local container setup (Dockerfile + compose, loopback-only port, own network) — unrelated to i18n mechanics; happy to move it to a separate PR |

## What does NOT change (compatibility guarantees)

- **Machine contracts stay English byte-for-byte:** layer IDs and registry keys, status enums/lifecycle values, voice tool names and schemas (incl. `gevActions` tool results), `/api/setup/*` payloads, share-link parameters, `gev:layer-state:v2` storage schema, provider/dataset names, license/source attribution.
- **English output is pinned by tests:** the extracted English literals are anchored byte-identical (`repairPass.test.mjs`); every pre-existing test expectation is unchanged except two disclosed edits (below).
- **No behavioral change for English users:** resolution still ends at `en` (default config), share links/hashes/stored state resolve exactly as before.

## How to test

```sh
node --test src/i18n/   # 38/38
npm test                # 2745 tests: 2743 pass, 1 skip (Windows-only), 1 known environmental
npm run build           # green
```

The one failure is **pre-existing and environmental**, not from this branch: `devFreshDotenv` "external-keys provenance" fails iff a provider key (e.g. `OPENAI_API_KEY`) is exported in the running shell; it passes in a clean environment (verified on `main` and at the branch base). Exact totals also vary slightly by platform (Node 24 runs two allocation microbenchmarks; a Windows-only hardening test skips elsewhere) — the caveats, not the raw total, are the contract.

**Manual walkthrough:**
1. `npm run dev` → open with `?lang=es` (or `?lang=fr`): UI renders translated, `<html lang>` set, dock selector marks the active locale.
2. Reload without `?lang=` — the language persists and the URL never re-gains the param.
3. Switch via the dock — reload preserves the share-link hash byte-exactly.
4. `GEV_DEFAULT_LOCALE=fr GEV_SECONDARY_LOCALE=en npm run dev` — boots with an `FR | EN` selector; a browser whose language matches a pair locale still wins (by design).
5. Keep-English spot-checks: layer IDs in the URL hash, provider names, callsigns, headlines, attribution untouched; cockpit instrument codes (`BRG`/`HDG`/`DEST`) stay as codes in all locales.

> **`npm run test:track`**: 108/108 on this branch and on the pre-i18n base under identical idle conditions — but run it on an otherwise-idle machine; the SwiftShader harness is CPU-bound and concurrent heavy processes can produce protocol timeouts and fixture-cleanup races unrelated to the code.

## Reviewer notes

1. **Sanctioned test edit** — two es-seed assertions in `i18n.test.mjs` had pinned transitional English seed values for `layers.clear.toast.cleared`; they now assert the real Spanish plural forms and still exercise `one`/`other` via `Intl.PluralRules`. All `en` assertions are byte-identical.
2. **Strict parity gate ON by default** — `catalog.test.mjs` demands exact key-set equality for every shipped non-en locale; `GEV_I18N_REQUIRE_FULL_LOCALE_PARITY=0` is the staging escape hatch for future locales, not for shipping drift.
3. **One locale-scoped CSS rule** — `html[lang='es'] .cctv-controls { flex-wrap: wrap; }` fixes a measured Spanish-only clip; French needed none (verified ≤ Spanish on every constrained surface). English pixels are untouched.
4. **Commit structure** — 58 commits grouped by stage (core → static extraction → runtime extraction → translation → review/repair → config/fr). A squash-merge is fine if you prefer a single commit; the stage grouping is preserved in `ai_docs/i18n-ownership.md` regardless.
5. **Known deferrals** (documented in `docs/CURRENT-STATE.md`): locale-aware number formatting policy (`toLocaleString` sites), README translation, RTL locales.

## Human checkpoints still open

Machine translation was dual-reviewed (correctness/security + language/a11y per locale) but **native review is still recommended** for es/fr terminology and tone — the judgment calls (taglines, aviation phrasing, glossary forks like `costo`/`coste`) are queued in `docs/TRANSLATORS.md`. A 390×844 visual pass on the two width watchlist rows is also pending.

## Screenshots

- [ ] Dock + shell, EN vs ES vs FR
- [ ] Cockpit HUD readouts (`VEL. SUELO` / `VITESSE SOL`)
- [ ] Data Layers panel + feed-state labels
- [ ] Key-setup chip (`ENCENDER` / `MISE SOUS TENSION`)
- [ ] Clear-layers plural toast (one/other) in es and fr

## Non-goals

RTL locales (the `dir` machinery exists, nothing ships); regional variants beyond normalization; README/docs translation; changing browser-language auto-detection priority; locale-aware number formatting policy.
