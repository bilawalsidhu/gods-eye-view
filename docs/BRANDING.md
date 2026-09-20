# OnDemand Spatial branding — assets, tokens, usage rules, retained identifiers

Product name: **OnDemand Spatial** (package `ondemand-spatial`, agent "OnDemand Spatial Intelligence Agent", workflow "OnDemand Spatial Advanced Workflow"). The brand assets and colour tokens below come **only** from the uploaded OnDemand brand guideline (`BrandGuidelines.pdf`, mediaId `6a27c273a71063f6d0f8a6c2`, 9 pages, sha256 `2992badc…c5fe6a`) and the supplied logo PNGs. Every value carries an evidence label; the full ledger with origins, hashes, page numbers and retrieval timestamps is `docs/brand/BRAND_SOURCE.md`. This set **replaces** the earlier assets that had been fetched from on-demand.io / files.readme.io (2026-09-18T10:02Z) — those files were overwritten in place on 2026-09-18 so that the template paths keep working.

Evidence labels: **DOCUMENTED** (printed in the PDF) · **DOCUMENT-OBSERVED** (read from the PDF's own drawings) · **SAMPLED** (measured from a supplied PNG) · **MEASURED-FROM-DIAGRAM** (p3 geometry) · **DERIVED** (this repo's choice).

## 1. Assets in `public/brand/`

The lockup is the guideline's own vector geometry: the circular mark + the stacked uppercase wordmark ("ON" over "DEMAND") recovered path-for-path from page 2 of the PDF with PyMuPDF (`page.get_drawings()`, items 26–34). Tight bbox 269.665 × 79.346 pt → aspect **3.40 : 1**; SVG `viewBox="0 0 272.839 82.52"` (2 % pad). Rendered at 4000 px the SVG measures 3954 × 1163 px (3.3998 : 1); the supplied low-resolution rasters of the same lockup measure 3.29–3.32 : 1 with the mark at 29.2–29.4 % of the width in both, i.e. the silhouettes match. The fill is a single attribute on one `<g>`, so any colour variant is a one-attribute change.

| File | Bytes | Kind | Source | Notes |
|---|---|---|---|---|
| `logo-light.svg` | 3,888 | **original vector** (recovered) | PDF p2, right half (items 16–24 / 26–34) | Full lockup, `fill="#F7F7F5"` — the documented light variant for dark backgrounds (DOCUMENT-OBSERVED). Header lockup. |
| `logo-dark.svg` | 3,888 | derived from the same paths | PDF p2 geometry + colour of the supplied green PNGs | Full lockup, `fill="#0D5849"` = Primary 1 (DOCUMENTED p9; SAMPLED as the ink of `logo_green.png`). For light backgrounds. The guideline itself shows no green lockup — see §4. |
| `logo-black.svg` | 3,888 | **original vector** (recovered) | PDF p2, left half | Full lockup, `fill="#000000"`, exactly as printed. Print / monochrome use. |
| `mark-light.svg` | 653 | original vector (recovered) | PDF p2 item 34 | Bare mark, `fill="#F7F7F5"`, square `viewBox 0 0 82.52 82.52`. Used in the `h1` logo slot on the dark UI. |
| `mark-dark.svg` | 653 | derived | same path, `#0D5849` | Bare mark for light backgrounds. |
| `mark.svg` | 748 | derived (icon version) | PDF p4 "icon version" proportions | 512 × 512 tile `#0D5849` with the mark in `#F7F7F5` at 65 % of the tile, centred (p4 dark tile: 103 pt mark in a 158 pt tile = 65 %). Corner radius 20 % is this repo's choice — p4 shows square corners. SVG favicon. |
| `logo-light.png` / `logo-dark.png` | 45,495 / 43,223 | derived (MuPDF render of the SVGs) | — | 1200 × 363 px, RGBA transparent; single ink colour `#F7F7F5` / `#0D5849` (verified with PIL). |
| `mark.png` | 20,872 | derived (render of `mark.svg`) | — | 512 × 512 px RGBA (the tile, transparent outside the rounded corners). |
| `og-image.png` | 22,688 | derived | composition by this repo | 1200 × 630 px RGB, `#161616` ground with the `#F7F7F5` lockup centred at 60 % width (720 px). No text — no brand typeface is available (§2). |
| `favicon-16.png` / `favicon-32.png` / `favicon-48.png` | 579 / 1,150 / 1,759 | derived (direct renders of `mark.svg`) | — | 16 / 32 / 48 px RGBA. |
| `favicon.ico` | 15,086 | derived (`convert favicon-16.png favicon-32.png favicon-48.png favicon.ico`) | — | Contains three images: 16 × 16, 32 × 32, 48 × 48 (`identify favicon.ico`). |
| `apple-touch-icon.png` | 6,791 | derived (render of `mark.svg`) | — | 180 × 180 px. |
| `android-chrome-192.png` / `android-chrome-512.png` | 7,290 / 20,872 | derived (renders of `mark.svg`) | — | 192 × 192 / 512 × 512 px, referenced by `site.webmanifest`. |
| `site.webmanifest` | 410 | derived | — | `name` "OnDemand Spatial", `short_name` "OD Spatial", both android-chrome icons, `theme_color #0D5849`, `background_color #161616`, `display standalone`, `start_url /`. |

Not shipped: the supplied rasters themselves (`OD_logo_black_upload.png` is a different, mixed-case lockup with a tagline; the 420 × 136 green PNGs are low-resolution; `logo_dark.png` is a crop of the clear-space diagram with red guide-line residue). Details and hashes: `docs/brand/BRAND_SOURCE.md` §2.

## 2. Colour and type tokens — `src/brand/tokens.css`

All tokens are `--od-*` custom properties on `:root`, one per line, each with a comment stating hex, role, usage note and evidence label. The stylesheet is a standalone file; it takes effect only where it is imported. The pre-existing `--brand-*` variables in `src/ui/styles/foundation.css` are owned by the UI styles and were **not** modified by this extraction.

| Token | Hex | Guideline label | Role in this repo | Evidence |
|---|---|---|---|---|
| `--od-green-900` (`--od-brand`) | `#0D5849` | "Primary" 1 — no name | brand colour, favicon tile, `logo-dark.svg`, primary button on light ground | DOCUMENTED p9 (+ SAMPLED ink of the green PNGs) |
| `--od-green-700` | `#108B70` | "Primary" 2 | hover / secondary green on light ground — large text only | DOCUMENTED p9 |
| `--od-green-500` (`--od-accent`) | `#3BB795` | "Primary" 3 | accent on the dark UI; dark ink on top of it | DOCUMENTED p9 |
| `--od-green-200` (`--od-accent-soft`) | `#ADEDD6` | "Primary" 4 | soft accent / highlighted text on dark | DOCUMENTED p9 |
| `--od-green-50` | `#EDFCF6` | "Primary" 5 | tinted panel on light ground; text on `#0D5849` | DOCUMENTED p9 |
| `--od-neutral-600` | `#5B5B5B` | "Neutrals" 1 | secondary text on light ground | DOCUMENTED p9 |
| `--od-neutral-400` | `#999999` | "Neutrals" 2 | muted text on dark ground only | DOCUMENTED p9 |
| `--od-neutral-300` | `#C6C6C6` | "Neutrals" 3 | borders / dividers on light ground | DOCUMENTED p9 |
| `--od-neutral-200` | `#D8D8D8` | "Neutrals" 4 | hairlines, input borders | DOCUMENTED p9 |
| `--od-neutral-100` (`--od-text-on-dark`) | `#F3F3F3` | "Neutrals" 5 | body text on dark surfaces | DOCUMENTED p9 |
| `--od-ink` (`--od-surface-dark`, `--od-text-on-light`) | `#161616` | not in palette | dark surface | DOCUMENT-OBSERVED p2 / p4 grounds |
| `--od-paper` (`--od-surface-light`) | `#F7F7F5` | not in palette | light surface; the light logo colour | DOCUMENT-OBSERVED p2 / p4 |
| `--od-logo-black` | `#000000` | — | `logo-black.svg` | DOCUMENT-OBSERVED p2 / p3 |
| `--od-font-brand` | `"Söhne", "Inter", system-ui, …` | "Söhne" is the only typeface named (p7) | UI / brand type | DOCUMENTED family; commercial and not bundled → falls back to Inter (already loaded in `index.html`). **No weights, sizes or type scale are documented.** |
| `--od-font-mono` | `"JetBrains Mono", ui-monospace, …` | — | code / telemetry | NOT DOCUMENTED — app convention |
| `--od-logo-aspect` | `3.3986` | — | layout helper | MEASURED p2 |
| `--od-logo-clear-space` / `--od-logo-clear-space-y` | `0.56` / `0.65` | — | fraction of lockup width (sides) / height (top & bottom) to keep clear | MEASURED-FROM-DIAGRAM p3 |
| `--od-logo-icon-mark-ratio` | `0.65` | — | mark size inside the icon tile | MEASURED p4 |
| minimum logo size | — | — | — | NOT DOCUMENTED — no token defined |

### WCAG 2.x contrast (relative luminance per WCAG 2.1; AA normal text ≥ 4.5 : 1, AA large text ≥ 3 : 1)

`#0A0B0B` is the app's existing page background (`--bg-dark`), not a guideline colour; it is included because the dark UI renders on it.

| Foreground on background | Ratio | AA normal (≥ 4.5) | AA large (≥ 3) |
|---|---|---|---|
| `#F3F3F3` on `#161616` | 16.31 : 1 | PASS | PASS |
| `#F3F3F3` on `#0A0B0B` | 17.76 : 1 | PASS | PASS |
| `#3BB795` on `#0A0B0B` | 7.88 : 1 | PASS | PASS |
| `#3BB795` on `#161616` | 7.23 : 1 | PASS | PASS |
| `#ADEDD6` on `#0A0B0B` | 14.88 : 1 | PASS | PASS |
| `#0A0B0B` on `#3BB795` (button text on accent) | 7.88 : 1 | PASS | PASS |
| `#161616` on `#3BB795` | 7.23 : 1 | PASS | PASS |
| `#F7F7F5` on `#0D5849` (light logo / text on brand green) | 7.80 : 1 | PASS | PASS |
| `#EDFCF6` on `#0D5849` | 7.91 : 1 | PASS | PASS |
| `#108B70` on `#F7F7F5` | 3.96 : 1 | **FAIL** | PASS |
| `#0D5849` on `#F7F7F5` (green logo on light ground) | 7.80 : 1 | PASS | PASS |
| `#5B5B5B` on `#F3F3F3` | 6.12 : 1 | PASS | PASS |
| `#F7F7F5` on `#3BB795` (do not use light text on the accent) | 2.33 : 1 | **FAIL** | **FAIL** |
| `#999999` on `#F3F3F3` (do not use on light ground) | 2.57 : 1 | **FAIL** | **FAIL** |
| `#999999` on `#161616` | 6.35 : 1 | PASS | PASS |

## 3. How the app uses the files

Asset-to-slot contract (the markup itself lives in `index.html` and `src/ui/templates/*.html`):

| Slot | File(s) | Notes |
|---|---|---|
| Header (`#title-bar`) — the ONE brand mark | `<span class="title-logo brand-logo" data-brand-mark="mark" data-logo-gaze data-logo-src="/brand/mark-light.svg"><img src="/brand/mark-light.svg" alt=""></span>` beside the `OnDemand Spatial` title and the `SPATIAL INTELLIGENCE CONSOLE` subtitle | The bare mark, no tile — it sits directly on the dark header (use `mark-dark.svg` on a light surface). **Since 2026-09-20 the header renders this mark only**: the stacked ON/DEMAND lockup `<picture>` that used to sit above the title duplicated the mark in the same panel and was removed (§4 "One brand mark per surface"). |
| Loading screen (`#loading-screen`) — the ONE brand mark | `<span class="loader-logo brand-logo" data-brand-mark="mark" …>` + the `OnDemand Spatial` heading | Same rule: the animated mark is the single brand mark; the lockup `<picture>` it used to carry was removed on 2026-09-20. |
| Lockup files (`logo-light.svg` / `logo-dark.svg` / `logo-black.svg`) | not rendered by any UI surface | Kept as brand assets for the social preview composition, print and future light-scheme surfaces. |
| Favicons | `/brand/mark.svg` (`type="image/svg+xml"`), `/brand/favicon.ico` (`sizes="any"`), `/brand/favicon-32.png`, `/brand/apple-touch-icon.png` (180), `/brand/site.webmanifest` → `android-chrome-192/512.png` | All are the p4 icon version (mark on a green tile). `theme_color` `#0D5849`. |
| Social preview | `/brand/og-image.png` (1200 × 630, `og:image` / `twitter:image`) | Lockup on `#161616`, no text. |
| Print / monochrome | `/brand/logo-black.svg` | As printed on p2. |

Sizing: keep the lockup's aspect (`--od-logo-aspect` 3.3986) — set only its height and let the width follow; never stretch (p5 "The logo proportions should be kept intact").

## 4. Rules

- **One brand mark per surface (REPO RULE, 2026-09-20).** A header surface (`#title-bar`, `#loading-screen`, and any future panel/drawer/modal header) renders exactly ONE OnDemand brand mark — the circular mark next to the product name — and never the mark AND the stacked ON/DEMAND lockup together. Nothing in the guideline asks for both (p2 shows the lockup alone, p4 the icon version alone, and the p3 clear-space rule of 0.56 × lockup width would be violated by a mark sitting beside the lockup); the 2026-09-19 header showed both and was fixed on 2026-09-20. Every rendered mark carries `data-brand-mark`; `scripts/check-brand-marks.mjs` (part of `npm run check:boundaries`), `src/iconGlyphBoundary.test.mjs`, `src/tooling/brandMarks.test.mjs` and the headless `scripts/qa-icon-harness.mjs` (`[data-brand-mark]` count per surface) enforce it.
- **Clear space (MEASURED-FROM-DIAGRAM, p3).** Keep at least **0.56 × the lockup width** free on the left and right and **0.65 × the lockup height** free above and below. The diagram draws a 150 pt band beside a 269.7 pt-wide lockup and 50–54 pt bands above/below a 79.3 pt-tall lockup, each band holding a 55 %-scaled ghost copy of the lockup; no numeric rule is printed. Measured from the lockup's own edges to the outer guides the margins are 0.60–0.61 W and 0.73–0.74 H, so the tokens are the tighter of the two readings — treat them as minimums.
- **Icon version (DOCUMENTED, p4).** "Icon version is used wherever long version would not be recognizable because of size or where icon version is visually more appealing. Example: Social Media Profile Icons." The mark sits centred on a square tile at ≈ 65 % of the tile (p4 dark tile; the light tile shows 69 %). Documented tile pairs: `#F7F7F5` mark on `#161616`, `#161616` mark on `#F7F7F5`. The green tile + 20 % radius of `mark.svg` is this repo's derivation.
- **Minimum size.** NOT DOCUMENTED — no numeric minimum exists on any page. The only trigger is p4's qualitative one: switch to the icon version when the wordmark would no longer be recognizable at the rendered size. No pixel threshold is invented here.
- **Colour variants.** The guideline shows the lockup only in `#000000` on `#F7F7F5`, `#F7F7F5` on `#161616`, and the mark in `#161616` on `#F7F7F5`. The green `#0D5849` lockup/mark is taken from the supplied PNG assets; use it on light grounds (7.80 : 1) and never place light text on `#3BB795` (2.33 : 1).
- **Don'ts (DOCUMENTED, p5, verbatim captions):** "Not enough contrast between background and logo" · "The logo proportions should be kept intact" · "The logo should not be rotated" · "The logo should have enough space around it".
- **Typography.** The only documented typeface is Söhne (p7). It is commercial and not bundled; the token stack falls back to Inter. No weights, sizes or scale are documented, so the app's existing type scale is an app decision, not a brand rule.

## 5. Retained internal identifiers (intentionally unchanged)

The product name everywhere else is **"OnDemand Spatial"** (package `ondemand-spatial`, agent "OnDemand Spatial Intelligence Agent", workflow "OnDemand Spatial Advanced Workflow"). The following identifiers keep their historical `godsEyeView` / `gods-eye-view` spelling because they are wired to persisted user data, external registrations or upstream provenance:

- `godsEyeView.*` localStorage keys (`sceneProject.v2`, `cctv.calibration.v2`, `v8.panelPos.*`, `v6.panelCollapsed.*`, `voiceCost.*`, `cockpitWeatherEffects.enabled`) — persisted user data;
- `window.__godsEyeView` debug global — QA tooling contract;
- `godsEyeView_<name>` Cesium post-processing stage names;
- `gods-eye-view-transit` / `gods-eye-view-transit-proxy/1.0` ET-Client-Name + `Digitraffic-User: gods-eye-view` — client identifiers registered with feed operators;
- `bilawalsidhu/gods-eye-view` upstream repository references;
- `GODS_EYE_FLOW_VERSION` — kept as an accepted alias (checked first) of the canonical `ONDEMAND_SPATIAL_FLOW_VERSION`.
