# OnDemand branding — assets, colour tokens, contrast, and what was intentionally left unchanged

Rebrand of the `ondemand-serverless` branch UI to **OnDemand Spatial Intelligence** (commit `chore(brand): rebrand UI to OnDemand`, 2026-09-18). Every asset below was fetched from an official OnDemand web property with HTTP 200 at the UTC time shown; nothing was invented. Derived files are marked and name their source.

## 1. Logo assets in `public/brand/`

| File | Kind | Source (HTTP 200, UTC) | Notes |
|---|---|---|---|
| `logo-light.svg` | **original** | `https://files.readme.io/69290e9-OD-full-Logo.svg` — the header logo of https://docs.on-demand.io (`<img alt="OnDemand AI" class="rm-Logo-img …" src=…>`), fetched 2026-09-18T10:02:56Z, 20,634 bytes, 571×190 | Full "OnDemand" wordmark with `fill="#FFFFFF"` (16 paths) — the light (white) variant for dark backgrounds; used in the app header and loading screen |
| `logo-dark.svg` | **derived from** `https://files.readme.io/69290e9-OD-full-Logo.svg` | same fetch | Same mark with every `#FFFFFF` fill replaced by `#0F0F10` (docs brand `primary_color`, see §2) — the dark variant for light backgrounds, served via `<picture>` `(prefers-color-scheme: light)` |
| `logo-light.png` / `logo-dark.png` | derived (ImageMagick 7 `convert -background none -density 300 … -resize 1142x380`) | from the two SVGs above | 1142×380, transparent background |
| `mark.svg` | **original** | `https://app.on-demand.io/favicon.svg` (`<link rel="icon" href="/favicon.svg" type="image/svg+xml">` on https://app.on-demand.io), fetched 2026-09-18T10:02:57Z, 620 bytes, 48×48 | The circular "OD" mark, single path `fill="#1DAC89"`; used as the animated logo slot (`data-logo-gaze`) and SVG favicon |
| `mark.png` | derived from `mark.svg` (`convert -density 600 … -resize 512x512`) | — | 512×512 transparent |
| `favicon-32.png` | derived from `mark.png` (`-resize 32x32`) | — | 32×32. (The official `https://app.on-demand.io/favicon-32.png` and `https://on-demand.io/favicon-32.png` were also fetched, HTTP 200, but the served file is 48×48 — the upstream 32/48 names are swapped — so the icon was regenerated from the SVG mark at the correct size.) |
| `apple-touch-icon.png` | derived from `mark.png` (`-resize 180x180 -gravity center -extent 180x180`) | — | 180×180 |
| `favicon.ico` | derived from `mark.png` (`-define icon:auto-resize=16,32,48,64`) | — | 16/32/48/64 px. (Official ICOs fetched for reference: `https://on-demand.io/logo-light.ico` 200, 6 sizes up to 256 px; `https://files.readme.io/52eb008-favicon.ico` 200 — not copied because the SVG mark is the cleaner source.) |

Other official assets fetched (HTTP 200, 2026-09-18T10:02:57Z) but not shipped: `https://app.on-demand.io/thumbnail.png` (679×354 og image), `https://on-demand.io/og-thumbnail.png` (1200×630), `https://files.readme.io/4c9cf4b-small-ondemand.png` (80×80). Pages inspected: `https://on-demand.io` (200, 10:02:37Z), `https://app.on-demand.io` (200, 10:02:38Z), `https://docs.on-demand.io` (200, 10:02:39Z), `https://on-demand.io/assets/index-VMQMQSoh.css` (200, 10:02:58Z). `public/logo.svg` (the previous mark) is kept only as the `logoGaze` fallback asset; its `<title>` now reads "OnDemand Spatial Intelligence (legacy mark)" and nothing references it.

## 2. Brand colour tokens (CSS variables in `src/ui/styles/foundation.css` `:root`)

| Token | Hex | Source (exact) | Applied to |
|---|---|---|---|
| `--brand-500` / `--accent` | `#1DAC89` | https://on-demand.io/assets/index-VMQMQSoh.css — Tailwind utilities `.bg-brand-500\/10 … \/70 {background-color:#1dac89…}` (13 occurrences); also `https://app.on-demand.io/favicon.svg` `<path … fill="#1DAC89">` | accent colour everywhere the UI previously used `#00d4ff` / `rgba(0,212,255,…)` (buttons, dividers, glows, active states), primary button background |
| `--brand-300` | `#5ED8B2` | same CSS — `.border-brand-300\/20 … {border-color:#5ed8b2…}` and gradient `linear-gradient(180deg,#5ED8B2,#0B9F80)` | title accent ("Spatial Intelligence"), primary button hover, replaces the former `rgba(0,246,255,…)` glow |
| `--brand-600` | `#0B9F80` | same CSS — `linear-gradient(180deg,#5ED8B2,#0B9F80)` and `linear-gradient(256.59deg,#0B9F80 26.48%,#0A4639 78.33%)` | reserved (gradients) |
| `--brand-900` | `#0A4639` | same CSS — gradient end `#0A4639 78.33%` | reserved (gradients) |
| `--brand-ink` / `--bg-dark` | `#0A0B0B` | same CSS — `.bg-\[\#0A0B0B\]\/60|80|90 {background-color:#0a0b0b…}` (site/header background) | page background, header background (`--header-bg: rgba(10,11,11,0.85)`), glass panels, primary button text, `<meta name="theme-color">` |
| docs primary | `#0F0F10` | https://docs.on-demand.io page config `"brand":{"primary_color":"#0f0f10"` (readme.io project settings embedded in the HTML) | fill colour of the derived `logo-dark.svg` |
| docs link | `#4E4E4E` | same page config `"link_color":"#4e4e4e"` | not applied (too low contrast on dark UI) |

Text colours unchanged: `--text-primary: #E8EAED`, `--text-secondary: rgba(232,234,237,0.5)`.

### WCAG AA contrast (normal text ≥ 4.5:1)

| Pair | Ratio | Result |
|---|---|---|
| `#E8EAED` text on `#0A0B0B` header/page background | **16.35:1** | AA/AAA |
| `#1DAC89` accent text on `#0A0B0B` | **6.86:1** | AA |
| `#5ED8B2` title accent on `#0A0B0B` | **11.21:1** | AA/AAA |
| Primary button: `#0A0B0B` text on `#1DAC89` background | **6.86:1** | AA (white text on `#1DAC89` would be 2.87:1 → rejected, hence dark ink on the button) |
| Primary button hover: `#0A0B0B` on `#5ED8B2` | **11.21:1** | AA/AAA |

## 3. What changed in the UI

`index.html` (title, description/og/twitter meta, theme-color, favicon + apple-touch-icon links to `/brand/*`), `src/ui/templates/scene-chrome.html` (header: `<picture>` logo-light/logo-dark by colour scheme + mark + wordmark text "OnDemand Spatial Intelligence", subtitle "POWERED BY ONDEMAND"), `src/ui/templates/hud-loading.html` (loading screen), `src/ui/styles/*.css` + `style.css` (brand tokens; every `#00d4ff` / `rgba(0,212,255,…)` / `rgb(0 212 255 / …)` / `rgba(0,246,255,…)` literal replaced by the brand values), `package.json` (`name: ondemand-spatial-intelligence`, description), `package-lock.json` root name, the 13 self-referencing package imports (`ondemand-spatial-intelligence/…`, they must match the package name), user-visible strings in `src/main.js` and `src/voice/realtimeViewport.js`, README.md and the user-facing docs under `docs/*.md` (product-name prose). Tests updated because they asserted user-facing values: `src/cockpitMarkup.test.mjs`, `src/panelStackLayout.test.mjs` (accent colour literals), `src/overpassProxy.test.mjs`, `src/tooling/nominatimSearchRoute.test.mjs` (User-Agent now `ondemand-spatial-intelligence/<version>`), plus the package-name import specifiers in 10 test files.

## 4. Intentionally unchanged internal identifiers

These are wired to persisted user state, the Vercel project, the OnDemand dashboard, or upstream repositories; renaming them would break behaviour or provenance. They remain the only matches of `grep -rniE "god'?s[ -]?eye"` outside `docs/audit/`.

| Identifier | Where | Reason |
|---|---|---|
| `GODS_EYE_FLOW_VERSION` (env var name) | `server/ondemand/config.js`, `api/ondemand/_config.js`, `.env.example`, `docs/ONDEMAND_PROXY_DESIGN.md`, tests | provisioned on the Vercel project (env id `usC3wgbut65gTkaR`) |
| `GodsEye Advanced Spatial Workflow` (workflow name, id `6aace534859f7b0abb53d99a`) | `server/ondemand/workflow-definition.js`, `src/registry/capabilities.json`, `docs/ondemand-workflows/*` | live Agents Flow Builder workflow; renaming would desync the export and the dashboard |
| `GodsEye Spatial Intelligence Agent`, skill slugs `godseye-*` | `src/registry/capabilities.json`, `docs/ondemand-skills/*`, `docs/audit/dashboard-registration-pack.md` | dashboard registration identifiers (pending) |
| `godsEyeView.*` localStorage keys (`sceneProject.v2`, `cctv.calibration.v2`, `v8.panelPos.*`, `v6.panelCollapsed.*`, `voiceCost.*`, `cockpitWeatherEffects.enabled`) | `src/scenes/director.js`, `src/layers/cctv/policy.js`, `src/ui/panelPositionControls.js`, `src/voice/realtimePreferences.js`, `src/cockpitCloudEffects.js`, documented in `docs/KNOWN-ISSUES.md`, `docs/SCENE-DOCUMENT.md`, `docs/CURRENT-STATE.md` | persisted user data — renaming would wipe saved scenes, calibrations and layouts |
| `window.__godsEyeView` debug global | `src/app/tools.js`, `src/voice/*.js`, `docs/APPLICATION.md`, QA scripts/tests | debugging contract used by the QA tooling |
| `godsEyeView_<name>` post-processing stage names | `src/ui/visualEffects.js`, `src/layers/transit/selection.js` | internal Cesium stage identifiers |
| `gods-eye-view-transit` / `gods-eye-view-transit-proxy/1.0` client identifiers, `Digitraffic-User: gods-eye-view` header | `src/data/transitFeeds.js`, `src/data/transitProxy.js`, `DATA_SOURCES.md` | registered `ET-Client-Name` / User-Agent / Digitraffic client values agreed with the feed operators |
| `gods-eye-view` in GitHub / Pinokio URLs and the `bilawalsidhu/gods-eye-view` repository slug | `package.json` (`homepage`, `repository`, `bugs`), README/CONTRIBUTING/SECURITY badges and clone instructions, `.github/ISSUE_TEMPLATE/config.yml`, `docs/MAINTAINER_WORKFLOW.md`, `docs/CURRENT-STATE.md`, `docs/media/README.md`, `src/registry/capabilities.json` license URL, UA `+https://github.com/bilawalsidhu/gods-eye-view` | real upstream repository location (the fork is `mk42-ai/gods-eye-view`) |
| `godseye-contract-test-*` / `godseye-selftest-*` externalUserId prefixes, `x-godseye` OpenAPI extension key | `server/ondemand/contract-steps.js`, `api/ondemand/selftest.js`, `docs/ondemand-tools/*.json`, `docs/ONDEMAND_API_CURRENT.md` §17 | recorded live values / tool-definition schema key |
| `docs/audit/*`, `docs/ondemand-workflows/*` historical records | — | audit history is immutable by policy |
| `scripts/*` QA/tooling messages | `scripts/qa-*.mjs`, `scripts/setup-doctor.mjs`, `scripts/track-regression.mjs` | developer tooling, not the shipped UI |
