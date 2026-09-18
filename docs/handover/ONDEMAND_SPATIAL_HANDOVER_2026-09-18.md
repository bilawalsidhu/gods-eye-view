# OnDemand Spatial — handover 2026-09-18

Branch `ondemand-serverless` · remote `origin` = `https://github.com/mk42-ai/gods-eye-view.git` · upstream `bilawalsidhu/gods-eye-view` (MIT).
Prepared 2026-09-18 (UTC) as the close-out of the rebrand + MOVEMENT-layer repair. Every value below was read from the checkout or a live probe on that date; nothing is recalled from memory. Secret VALUES are never printed — only variable NAMES.

> **HEAD note.** The close-out was briefed against HEAD `4dc98fc`. At 18:00:16Z `git ls-remote origin ondemand-serverless` answered `6320b5818060ab439e27bc158c686f643ff3fcc4`: three further commits had been pushed to the same branch at 17:46–17:47Z by a parallel run (`1813f0d` feat(voice) OnDemand-only turn-based voice mode + `/api/ondemand/workflow/{execute,status,logs,outputs,stream}`; `bcf881f` feat(entity-chat) OnDemand chat overlay + `x-ondemand-key` override; `6320b58` docs(ondemand) live API re-validation §18, `ONDEMAND_SPATIAL_WORKFLOW_ID`, registration pack, plugin resolution, `.env.example`). The checkout was fast-forwarded (ff-only, no rewrite) and every gate in §1 was re-run on `6320b58`; this handover and the close-out decisions are committed on top of it.

## 1. Criterion ledger

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | UI rebranded to **OnDemand Spatial** | **DONE** | commits `ff596ee` (brand kit), `64d079e` (rename + alias-first flow version), `b26fc2f` (docs); browser-verified on the rebrand preview `https://sb-60dkzxm81yfw.vercel.run` — `document.title === 'OnDemand Spatial'`, header wordmark `OnDemand Spatial`, `--od-green-500 === #3bb795`, no `GodsEye` text in the rendered page (`.ui-proof/after-header-1440x900.png`) |
| 2 | Brand source | **DONE** | `BrandGuidelines.pdf` from the user's file store (mediaId `6a27c273a71063f6d0f8a6c2`, sha256 `2992badc47a6b137e3337124de45ec21c35876700e52614e88171bb008c5fe6a`; five later copies byte-identical); tokens in `src/brand/tokens.css` — `--od-green-500: #3BB795` (Primary 3, p9); ledger `docs/brand/BRAND_SOURCE.md` (§3 below) |
| 3 | Workflow renamed in the dashboard | **DONE (display name only)** | `PATCH /automation/api/workflow/6aace534859f7b0abb53d99a/name` → HTTP 200 at 2026-09-18T10:41:47.809Z; `GET` re-read 10:41:48.119Z: name `OnDemand Spatial Advanced Workflow`, id unchanged, `lastModifiedAtInMilliseconds` unchanged, 9 nodes; re-confirmed `GET … → 200` 16:20:55Z (`.env.example:306`) |
| 4 | `ONDEMAND_SPATIAL_FLOW_VERSION` on Vercel | **DONE (by the owner)** | project env id `siAgsm6hBOQrEYcY`, type plain, targets production + preview, created 2026-09-18 (Vercel env listing 2026-09-18); the code resolves alias-first so `GODS_EYE_FLOW_VERSION` (id `usC3wgbut65gTkaR`) still wins until deleted |
| 5 | MOVEMENT layers repaired | **DONE** | commits `04db22b` `aef74d7` `75a930d` `cfea752` `fb4c5ae` `4dc98fc`; preview `https://sb-5z1tt82ep4go.vercel.run` (2026-09-18 13:57–14:25Z): **0 UNAVAILABLE / 0 HTTP 502**; rows read `LIVE · CelesTrak`, `DEGRADED · adsb.lol · OpenSky unreachable …`, `LIVE · adsb.lol`, `Demo replay · No vessels in scene` (Austin) / `DEGRADED · Demo replay …` (Galveston Bay), `DEGRADED · TomTom · TOMTOM_API_KEY not set …` — 2 LIVE + 3 DEGRADED-with-reason pending keys (`.ui-proof/after-austin-1440x900.png`, `after-galveston-1440x900.png`) |
| 6 | Gates green | **DONE (re-run on 6320b58, 18:03:58–18:04:53Z)** | `format:check` 964 files ✓ · `check:boundaries` 760 modules ✓ · `npm test` **4,346 tests / 4,345 pass / 0 fail / 1 skipped** (pre-existing Node-24 allocation gate) · `test:ondemand` **219 pass** · `test:serverless` **54 pass** · `build` ✓ 4.78 s (prebuild TLE-snapshot step skipped, snapshot 4.7 h old). Baseline at `4dc98fc` was 4,223 / 192 / 47; the deltas (+122 / +27 / +7) are the parallel run's new suites — no failures |
| 7 | Serverless functions | **9 (unchanged, ≤ 12 Hobby)** | `api/[...route].js`, `api/ondemand/{chat,health,media,selftest,sessions,stt,tts,workflow}.js` (`api/ondemand/_config.js` is a private module); the new `/api/ondemand/workflow/*` routes ride the catch-all |
| 8 | Push status | see §12 (filled after the close-out commit) | `git ls-remote origin ondemand-serverless` before the commit: `6320b58…` = local HEAD (pushed = yes) |
| 9 | Real Vercel deployment into `ondemand-eand-spatial` | **NOT ACHIEVED** | this environment permits only ephemeral `sandbox create` previews (the `vercel` CLI here is a refusing shim; project deploys are policy-blocked); the CLI runbook (§6) is the path; a push to `mk42-ai/gods-eye-view` triggers nothing on that project (it is Git-linked to `mk42-ai/ondemand-eand-spatial`, production branch `main`) |
| 10 | Row-1 tool ID / agent ID | **AWAITING DASHBOARD REGISTRATION** | `src/registry/capabilities.json`: `capabilities[earthquake.search].ondemand_tool_id = null`, `ondemand.agent.pluginId = null`, all nine `ondemand.skills[].skillId = null`; agent / REST-plugin creation is dashboard-only (`docs/ONDEMAND_API_CURRENT.md` §8, §18.1) |
| 11 | Fires row (`fires.search`, NASA FIRMS) | **NOT STARTED beyond scaffold** | `docs/ONDEMAND_PROXY_DESIGN.md` §12 scaffold only; `ondemand_tool_id = null`; needs `FIRMS_MAP_KEY` |
| 12 | Rename-group decisions | **CLOSED** | `## Decisions closed 2026-09-18` appended to `docs/audit/rebrand-grep-report-2026-09-18.md` and `docs/ONDEMAND_PROXY_DESIGN.md` (this commit): Group 1 KEEP UNCHANGED, Group 2 LEAVE IN v1 |

## 2. Bundle / proof links (step-2 deliverables)

| Deliverable | Where |
|---|---|
| Movement-layers preview (ephemeral Vercel Sandbox, 2026-09-18) | `https://sb-5z1tt82ep4go.vercel.run` |
| Rebrand preview (ephemeral) | `https://sb-60dkzxm81yfw.vercel.run` |
| Earlier previews | `https://sb-307x6fgbxmou.vercel.run` (row-1 contract), `https://sb-pg1bhjba1gcs.vercel.run` (USGS earthquakes row-1) |
| Movement-layers source bundle (`4dc98fc`) | `https://airevprod.blob.core.windows.net/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6aab3596cc6f5bb3618917b7/6aad33576ee0bd14717728bb/generated/code-files-20260918-143239_v1.zip` |
| Workflow/selftest bundle (9 passes, 163 s execution, TTFL 657 ms, dashboard registration pack) | `https://airevprod.blob.core.windows.net/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6aab3596cc6f5bb3618917b7/6aacdaab6ee0bd14717722ed/generated/code-files-20260918-080112_v1.zip` |
| Plugin-inventory / benchmark bundle | `https://airevprod.blob.core.windows.net/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6aab3596cc6f5bb3618917b7/6aacdaab6ee0bd14717722ed/generated/code-files-20260918-070158_v1.zip` |
| Row-1 USGS earthquake bundle (commits `5da207c`, `fe2d1c3`) | `https://airevprod.blob.core.windows.net/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6aab3596cc6f5bb3618917b7/6aacbeed6ee0bd14717721db/generated/code-files-20260918-061656_v1.zip` |
| T2-tier health/selftest bundle | `https://airevprod.blob.core.windows.net/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6aab3596cc6f5bb3618917b7/6aacbeed6ee0bd14717721db/generated/code-files-20260918-055245_v1.zip` |
| API contract doc `ONDEMAND_API_CURRENT_v1.md` | `https://airevprod.blob.core.windows.net/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6aab3596cc6f5bb3618917b7/6aab7efbcc6f5bb3618919ab/generated/ONDEMAND_API_CURRENT_v1.md` |
| UI proofs | `after-austin-1440x900_v1.png`, `after-galveston-1440x900_v1.png` (run `6aad33576ee0bd14717728bb/ui-proof/`); `after-1440x900_v1.png`, `after-header-1440x900_v1.png` (run `6aad11aeb9401965d659271b/ui-proof/`); the user's "before" screenshot `canvas-screenshot-385x525.png` (all MOVEMENT rows UNAVAILABLE, Austin MGRS 14R PU 1994 4730) |
| This close-out | `ondemand-spatial-ondemand-serverless-<sha>.zip` (git archive of the close-out commit), `ONDEMAND_SPATIAL_HANDOVER_2026-09-18.md`, `ONDEMAND_SPATIAL_HANDOVER_2026-09-18.pdf` |

The blob URLs above are the **base paths**; the signed access URLs the platform issues (`?se=…&sig=…`) expire within ~7 days, so re-request a fresh link from the run that produced the file. Ephemeral `*.vercel.run` sandboxes stop after their 90-minute timeout.

## 3. Brand source record

_Verbatim copy of `docs/brand/BRAND_SOURCE.md` as of this commit (including the new "Dark-header logo variant" subsection)._

<!-- BRAND_SOURCE_BEGIN -->
### OnDemand brand — evidence ledger (BRAND_SOURCE)

| Field | Value |
|---|---|
| Generated (UTC) | 2026-09-18 (extraction run at ≈10:52Z; every retrieval timestamp below is from `/tmp/brand-src/manifest.txt`) |
| Method | Every value in `src/brand/tokens.css`, every file in `public/brand/` and every statement in `docs/BRANDING.md` was taken from the source files listed in §1–§2, read offline with PyMuPDF 1.28.2 (`page.get_text()`, `page.get_drawings()`), Pillow 12.3 and NumPy. No web fetch, no memory, no prior knowledge. |
| Citation format | `(src: <origin host/path>, retrieved <UTC>)` — the same convention as `docs/ONDEMAND_API_CURRENT.md`. Origins are Azure Blob paths with the SAS query (`?se=…&sig=…`) stripped; they are recorded for provenance only and are not public URLs. |
| Evidence labels | **DOCUMENTED** = printed as text in the guideline · **DOCUMENT-OBSERVED** = read from the guideline's own drawings (page grounds, logo fills) · **SAMPLED** = measured from a supplied PNG · **MEASURED-FROM-DIAGRAM** = geometry of the p3 clear-space diagram (no numeric text exists) · **DERIVED** = this repo's choice, the guideline is silent · **NOT DOCUMENTED** = absent from every source. |
| Not-found rule | Anything the guideline does not state is listed in §7 (MISSING) and is never presented as brand policy. |

#### 1. Source documents (the brand guideline PDF and its copies)

All six PDFs are **byte-identical**: `sha256 2992badc47a6b137e3337124de45ec21c35876700e52614e88171bb008c5fe6a`, 580,590 bytes, 9 pages of 1920 × 1080 pt (recomputed with `sha256sum` on 2026-09-18 and matched against `/tmp/brand-src/sha256.txt`). **diff = identical, no discrepancies.** The uploaded original is treated as the primary source; the other five are agent-generated re-uploads of the same bytes.

| File (local name) | Original name | mediaId | Created (UTC) | Origin host/path (SAS stripped) | sha256 | Retrieved (UTC) | Role |
|---|---|---|---|---|---|---|---|
| `BrandGuidelines_upload_6a27c273.pdf` | `BrandGuidelines.pdf` | `6a27c273a71063f6d0f8a6c2` | 2026-06-09T07:36:19Z | `airevprod.blob.core.windows.net/on-demand-prod/media/6692b763e851d28a036ab30e/BrandGuidelines.pdf` | `2992badc…c5fe6a` | 2026-09-18T10:34:42Z | **PRIMARY** (uploaded original) |
| `ondemand_brand_6a34a316.pdf` | `ondemand_brand.pdf` | `6a34a3162974aa36b01a97cf` | 2026-06-19T02:01:58Z | `airevprod.blob.core.windows.net/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6a349bcd64c53d8c058fd676/6a349d3864c53d8c058fd67f/generated/ondemand_brand_v1.pdf` | identical | 2026-09-18T10:34:42Z | duplicate |
| `BrandGuidelines_6a38a959.pdf` | `BrandGuidelines.pdf` | `6a38a959c2712430c9b2cf38` | 2026-06-22T03:17:45Z | `airevprod.blob.core.windows.net/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6a38a89fd482c9678b28604a/6a38a8a95e5e6970ca97e068/generated/BrandGuidelines_v1.pdf` | identical | 2026-09-18T10:34:43Z | duplicate |
| `brand_guidelines_6a38a9bc.pdf` | `brand_guidelines.pdf` | `6a38a9bc83580b7170393791` | 2026-06-22T03:19:24Z | `airevprod.blob.core.windows.net/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6a38a92d5e5e6970ca97e071/6a38a9357136611a337783a9/generated/brand_guidelines_v1.pdf` | identical | 2026-09-18T10:34:42Z | duplicate |
| `brand_guidelines_6a3c15fa.pdf` | `brand_guidelines.pdf` | `6a3c15fa79b03bef36d21c92` | 2026-06-24T17:38:02Z | `airevprod.blob.core.windows.net/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6a3c0d50423751f5706a14ec/6a3c102e00bad1c8a0d31118/generated/brand_guidelines_v1.pdf` | identical | 2026-09-18T10:34:43Z | duplicate |
| `brand_guidelines_6a3e749b.pdf` | `brand_guidelines.pdf` | `6a3e749beaae8134ff6ecf73` | 2026-06-26T12:46:19Z | `airevprod.blob.core.windows.net/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6a3e712dc459c8a8dbb631a9/6a3e716cc459c8a8dbb631ab/generated/brand_guidelines_v1.pdf` | identical | 2026-09-18T10:34:43Z | duplicate |

Page inventory of the primary (`page.get_text()`): p1 "01 / Brand Guidelines / Logo / 1.0" (section cover) · p2 "Logo 1.1" (lockup on light and dark ground, no body text) · p3 "Logo 1.2" (clear-space diagram, no body text) · p4 "Logo 1.3" (icon version + one paragraph) · p5 "Logo 1.4" (four wrong treatments) · p6 "02 / Typography / 2.0" (cover) · p7 "Typography 2.1" ("Söhne", "Download Font") · p8 "03 / Color / 3.0" (cover) · p9 "Color 3.1" (ten HEX values). The PDF embeds no named fonts (all text is Type3 glyph outlines) and no raster images.

#### 2. Supplied logo raster assets

All PNGs are RGBA with a transparent background. "Ink" is the most frequent fully-opaque RGB value.

| File (local name) | Original name / origin host/path (SAS stripped) | sha256 | Bytes | Pixels | Ink | Retrieved (UTC) | What it is |
|---|---|---|---|---|---|---|---|
| `OD_logo_black_upload.png` | uploaded original "OD logo - black.png" — `airevprod.blob.core.windows.net/on-demand-prod/6692b763e851d28a036ab30e/media/OD_logo_-_black_4jx1.png` (mediaId not supplied) | `e9af7e526fd7318586354c67e1df64b74745e7396d153f5a76235213d61fbd7e` | 139,765 | 4746 × 1755 (opaque bbox 4556 × 1456 at offset 95,95) | `#0D0D0D` | 2026-09-18T10:34:43Z | Highest-resolution raster, but a **different lockup design** from the guideline: circular mark 1198 × 1198 px + a mixed-case wordmark ("On" over "Demand", x-height wordmark taller than the mark) + a third line of small tagline glyphs (161 px tall, unreadable at raster level). Aspect 3.129:1 incl. the tagline. Used only as a cross-check of the mark silhouette. |
| `logo_green.png` = `ondemand_logo_green.png` = `logo_green_alt.png` (identical bytes) | `…/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6a38d1ac7136611a3377845b/6a38d1b77136611a3377845c/generated/logo_green_v1.png` · `…/6a38aaf0d452c967922ad9e2/6a38ab035e5e6970ca97e096/generated/ondemand_logo_green_v1.png` · `…/6a3c0d50423751f5706a14ec/6a3c102e00bad1c8a0d31118/generated/logo_green_alt_v1.png` (host `airevprod.blob.core.windows.net`) | `c7abbe0a73d652a681ec4499b54df9b44cf7f0428bf73fbd25946835c8c40d0b` | 27,888 | 420 × 136 (lockup 414 × 126 at alpha > 128) | `#0D5849` (2594 px; anti-aliased neighbours `#0D5749`, `#0E5E4E`) | 2026-09-18T10:34:43Z | Low-resolution raster of the guideline's ON/DEMAND lockup, recoloured to Primary 1. Aspect 3.286:1; mark = 29.2 % of the width. |
| `logo_header.png` = `logo_cover.png` = `brand_logo_header.png` (identical bytes) | `…/6a3c0d50423751f5706a14ec/6a3c102e00bad1c8a0d31118/generated/logo_header_v1.png` · `…/6a3c0d50423751f5706a14ec/6a3c102e00bad1c8a0d31118/generated/logo_cover_v1.png` · `…/6a3e712dc459c8a8dbb631a9/6a3e716cc459c8a8dbb631ab/generated/brand_logo_header_v1.png` (host `airevprod.blob.core.windows.net`) | `58c1684fc5afcb1caa5b310524bd2bc09a7aec97e7cc638edca9d40346f739d0` | 28,164 | 420 × 136 | `#0D5849` | 2026-09-18T10:34:43Z | Visually identical to the `logo_green` group (same silhouette, same ink); differs only in PNG encoding. |
| `logo_dark.png` | `…/6a386dbbd452c967922ad915/6a386e39d482c9678b285d78/generated/logo_dark_v1.png` (host `airevprod.blob.core.windows.net`) | `ed05df27dd3e398e0d3a678130ea5471ca0e14a5dcb7efb12ca0c498561d602f` | 31,395 | 844 × 273 (lockup 833 × 251 at alpha > 128) | `#000000` (26,391 px) + 818 red pixels | 2026-09-18T10:34:43Z | A crop of the p3 clear-space diagram: black lockup with `#FF4949` guide-line residue along the top edge. **Not a clean logo**; not used. Aspect 3.319:1; mark = 29.4 % of the width. |

None of the supplied files is a vector (SVG/PDF/EPS logo). The vector lockup shipped in `public/brand/*.svg` was therefore **recovered from the PDF page drawings** (§4).

#### 3. Colour values

Ten hex values are printed on p9 under two group labels, "Primary" and "Neutrals", and the swatch rectangles on the same page are filled with exactly those values (`page.get_drawings()` on p9: swatches at y 269–522 pt filled `#0D5849 #108B70 #3BB795 #ADEDD6 #EDFCF6`, at y 657–910 pt filled `#5B5B5B #999999 #C6C6C6 #D8D8D8 #F3F3F3`). **No per-colour names and no usage roles are printed anywhere.** Two further colours are the guideline's own page grounds and are used as the logo's grounds on p2/p4; they are listed as DOCUMENT-OBSERVED and are not part of the named palette.

| Token | Hex | Brand name in guideline | Usage role (assigned by this repo) | Evidence | Source, page, retrieval |
|---|---|---|---|---|---|
| `--od-green-900` / `--od-brand` | `#0D5849` | not named; group label "Primary" (1st of 5) | brand colour, primary button on light ground, favicon tile, `logo-dark.svg` fill | DOCUMENTED (p9 text + swatch); also SAMPLED — ink of `logo_green.png` / `logo_header.png` coincides with this value | `BrandGuidelines.pdf` p9 "HEX: #0D5849" (src: `airevprod.blob.core.windows.net/on-demand-prod/media/6692b763e851d28a036ab30e/BrandGuidelines.pdf`, retrieved 2026-09-18T10:34:42Z); PNGs retrieved 2026-09-18T10:34:43Z |
| `--od-green-700` | `#108B70` | not named; "Primary" (2nd) | hover / secondary green on light ground; large text only (3.96:1 on `#F7F7F5`) | DOCUMENTED | p9 "HEX: #108B70", same src/retrieval |
| `--od-green-500` / `--od-accent` | `#3BB795` | not named; "Primary" (3rd) | accent on the dark UI; dark ink on top of it | DOCUMENTED | p9 "HEX: #3BB795" |
| `--od-green-200` / `--od-accent-soft` | `#ADEDD6` | not named; "Primary" (4th) | soft accent / highlighted text on dark ground; tinted chips on light ground | DOCUMENTED | p9 "HEX: #ADEDD6" |
| `--od-green-50` | `#EDFCF6` | not named; "Primary" (5th) | tinted panel background on light ground; text on `#0D5849` | DOCUMENTED | p9 "HEX: #EDFCF6" |
| `--od-neutral-600` | `#5B5B5B` | not named; group label "Neutrals" (1st of 5) | secondary text on light ground | DOCUMENTED | p9 "HEX: #5B5B5B" |
| `--od-neutral-400` | `#999999` | not named; "Neutrals" (2nd) | muted text on dark ground only, icons, placeholders | DOCUMENTED | p9 "HEX: #999999" |
| `--od-neutral-300` | `#C6C6C6` | not named; "Neutrals" (3rd) | borders / dividers on light ground, disabled text on dark | DOCUMENTED | p9 "HEX: #C6C6C6" |
| `--od-neutral-200` | `#D8D8D8` | not named; "Neutrals" (4th) | hairlines, input borders | DOCUMENTED | p9 "HEX: #D8D8D8" |
| `--od-neutral-100` / `--od-text-on-dark` | `#F3F3F3` | not named; "Neutrals" (5th) | body text on dark surfaces; light card surface | DOCUMENTED | p9 "HEX: #F3F3F3" |
| `--od-ink` / `--od-surface-dark` / `--od-text-on-light` | `#161616` | not in the palette | dark surface; mark colour on the light icon tile | DOCUMENT-OBSERVED — p2 right-half ground rect (960,0)–(1920,1080); p4 dark tile (401,515)–(559,676) and the mark on the light tile (1382,540)–(1491,649) | p2, p4, same src/retrieval |
| `--od-paper` / `--od-surface-light` | `#F7F7F5` | not in the palette | light surface; the light logo variant (`logo-light.svg`, `mark-light.svg`, mark on `mark.svg`) | DOCUMENT-OBSERVED — p2 left-half ground (0,0)–(960,1080), p3/p4/p5 page grounds, fill of the p2 right-half lockup (items 16–24) and of the mark on the p4 dark tile | p2, p3, p4, p5 |
| `--od-logo-black` | `#000000` | — | `logo-black.svg` fill, as printed | DOCUMENT-OBSERVED — p2 items 26–34 and p3 items 11–19 fill `#000000` | p2, p3 |
| (not a token) | `#FF4949` | — | guide lines of the clear-space diagram only — never a UI colour | DOCUMENT-OBSERVED p3 items 1–8 | p3 |
| (not a token) | `#DEDEDE` | — | the four half-scale ghost lockups in the p3 diagram — never a UI colour | DOCUMENT-OBSERVED p3 items 20–55 | p3 |
| (not a token) | `#0D0D0D` | — | ink of the uploaded `OD_logo_black_upload.png` (a different lockup design) | SAMPLED from PNG | `OD_logo_-_black_4jx1.png`, retrieved 2026-09-18T10:34:43Z |
| (not a token) | `#0A0B0B` | — | the app's existing page background (`--bg-dark` in `src/ui/styles/foundation.css`); kept by the app, **not** from the guideline; listed because the contrast table is computed against it | NOT DOCUMENTED (app value) | — |

Ordering note: the tokens are numbered 900→50 / 600→100 in the order the guideline prints them (darkest first); the numbers are this repo's scale, not the guideline's.

#### 4. Logo: what the guideline shows and how the vector was recovered

**Lockup (p2, "Logo 1.1").** Left half: `#F7F7F5` ground with the lockup in `#000000`; right half: `#161616` ground with the identical lockup in `#F7F7F5`. The lockup = a circular mark (a ring whose vertical stem joins the ring at the bottom) followed by a **stacked uppercase wordmark, "ON" over "DEMAND"**, set to the right of the mark. Drawing items on p2 (`page.get_drawings()` index): 34 = mark, 79.346 × 79.346 pt, rect (345.0, 500.0)–(424.346, 579.346), 15 path segments (`cclllccccllllcc`), two subpaths, `even_odd = True`; 33–32 = "O","N" (y 501.7–531.8); 31–26 = "D","E","M","A","N","D" (y 548.3–577.7); wordmark x 438.15–614.665. Items 16–24 are the same shapes at x + 960 in `#F7F7F5`; items 1–14 are hidden leftovers painted underneath the background rectangles and were ignored. Tight bbox of the lockup: **269.665 × 79.346 pt, aspect 3.3986:1**; mark = 29.4 % of the width; gap mark→wordmark = 13.8 pt (0.174 × mark); wordmark line heights 30.1 pt ("ON", y 501.7–531.8) and 29.4 pt ("DEMAND", y 548.3–577.7), line gap 16.5 pt.

**Recovery method.** For each item the PyMuPDF path segments were converted to SVG path data: `('l', p1, p2)` → `L`, `('c', p1, p2, p3, p4)` → `C p2 p3 p4`, `('re', rect)` / `('qu', quad)` → closed polygons; a new subpath (`M`) starts whenever a segment's start point differs from the previous end point; every subpath is closed with `Z`; `fill-rule="evenodd"` is set only where `d['even_odd']` is true (the mark). Coordinates were translated so the viewBox origin is the lockup bbox corner minus a 1.587 pt pad (2 % of the height) on every side → `viewBox="0 0 272.839 82.52"` (mark files: `0 0 82.52 82.52`). The fill is a single attribute on one `<g>`.

**Verification.** `logo-black.svg` rendered with MuPDF at 4000 px: opaque bbox 3954 × 1163 px, aspect **3.3998:1** (matches the source bbox). ImageMagick's independent SVG renderer gives 3.375:1 on a 600 px render (its own edge sampling). Against the supplied rasters: the same-design `logo_green.png` measures 3.286:1 and `logo_dark.png` 3.319:1 at an alpha > 128 threshold (low resolution + anti-aliasing), with the mark at 29.2 % / 29.4 % of the width — the silhouettes match (ring + bottom-joined stem, "ON" over "DEMAND"). The uploaded `OD_logo_black_upload.png` measures 3.129:1 but is a different design (mixed-case wordmark plus a tagline line; 3.80:1 without the tagline), so its ratio is not comparable — only its circular mark motif matches.

**Icon version (p4, "Logo 1.3").** Verbatim text: *"Icon version is used wherever long version would not be reconizable because of size or where icon version is visually more appealing. Example: Social Media Profile Icons"*. Drawings: dark tile `#161616` (401,515)–(559,676) = 158 × 161 pt with the mark in `#F7F7F5` at (425,543)–(528,646) = 103 pt (65 % of the tile width, insets 24/31 left/right, 28/30 top/bottom); light tile `#F7F7F5` (1361,515)–(1519,676) with the mark in `#161616` at (1382,540)–(1491,649) = 109 pt (69 %). Both tiles have **square** corners. `mark.svg` follows the dark tile (mark at 65 %, centred) but uses the Primary-1 green `#0D5849` as the tile and a 20 % corner radius — both **DERIVED** choices, not shown on p4.

#### 5. Typography

- p7 prints exactly two strings besides the running header: **"Söhne"** (set at 194 pt) and **"Download Font"** (40 pt). p6 is the section cover ("Typography / 02"). DOCUMENTED (src: primary PDF p6–p7, retrieved 2026-09-18T10:34:42Z).
- **Nothing else is documented**: no weights, no sizes, no line-heights, no letter-spacing, no type scale, no secondary/mono face, no web-font licence note. The PDF embeds no font programs (all glyphs are Type3 outlines), so the family cannot be sampled from the file either.
- Söhne is a commercial family (Klim Type Foundry) and is not bundled in this repository. `--od-font-brand` therefore lists `"Söhne"` first and falls back to Inter, which `index.html` already loads from Google Fonts. `--od-font-mono` (JetBrains Mono) is an app convention, NOT DOCUMENTED.

#### 6. Rules with page references

| Rule | Evidence | Detail |
|---|---|---|
| Clear space | MEASURED-FROM-DIAGRAM, p3 "Logo 1.2" | Red `#FF4949` guides: vertical x = 646.5–647.5, 796.5–797.5, 1093.5–1094.5, 1243.5–1244.5; horizontal y = 424.5–425.5, 478.5–479.5, 570.5–571.5, 620.5–621.5 (each 1 pt thick, drawn as filled rectangles). Black lockup at (810.0, 483.0)–(1079.7, 562.3). Horizontal bands 647→797 and 1094→1244 = **150 pt = 0.556 × lockup width**; vertical bands 425→479 = 54 pt and 571→621 = 50 pt = **0.63–0.68 × lockup height**. Four grey `#DEDEDE` ghost lockups sit in the corner bands, each 148.3 × 43.7 pt = **55 % scale** (mark 43.6 pt), e.g. (647.7, 430.6)–(796.0, 474.3). Measured from the lockup's own edges to the outer guides: 163 / 164.3 pt left/right (0.60–0.61 W), 58 / 58.7 pt top/bottom (0.73–0.74 H). No numeric text is printed → tokens `--od-logo-clear-space: 0.56` (× width, sides) and `--od-logo-clear-space-y: 0.65` (× height, top/bottom). |
| Icon version | DOCUMENTED text + measured drawings, p4 "Logo 1.3" | See §4. Use the bare mark where the full lockup "would not be recognizable because of size" — e.g. profile icons, favicons. |
| Minimum size | NOT DOCUMENTED | No numeric minimum size on any page; p4 only gives the qualitative "not recognizable because of size" trigger. |
| Wrong treatments | DOCUMENTED, p5 "Logo 1.4" | Verbatim: "Not enough contrast between background and logo" · "The logo proportions should be kept intact" · "The logo should not be rotated" · "The logo should have enough space around it". Intro text: "Here are couple of examples of wrong logo treatments. Please always make sure you're following rules from this guide." (The strings "Produkt Driven" / "Growth" also appear on p5 as text inside one of the example layouts.) |
| Colour variants of the logo | DOCUMENT-OBSERVED, p2/p4 | Only `#000000` on `#F7F7F5` (p2 left), `#F7F7F5` on `#161616` (p2 right, p4 dark tile) and `#161616` on `#F7F7F5` (p4 light tile) are shown. A **green** lockup is not shown in the guideline; the green `#0D5849` used by `logo-dark.svg` / `mark.svg` is taken from the supplied PNG assets (SAMPLED) and equals Primary 1 (DOCUMENTED). |

#### 7. MISSING — what the guideline does not provide

1. No per-colour brand names — only the group labels "Primary" and "Neutrals" (p9).
2. No usage roles for any colour (no "background / text / accent / button" mapping) — every role in `tokens.css` is assigned by this repo.
3. No type scale, weights, sizes or line-heights — only the family name "Söhne" (p7); no secondary or monospace face.
4. No numeric minimum size for the lockup or the mark (p4 gives a qualitative trigger only).
5. No numeric clear-space rule — p3 is a diagram only; the 0.56 W / 0.65 H figures are measured from its geometry.
6. No SVG/vector logo file supplied — the vector was recovered from the p2 page drawings (§4).
7. No dark-mode **green** variant of the logo — the documented light variant is off-white `#F7F7F5` on `#161616`.
8. No favicon / app-icon specification beyond the p4 "icon version" tile (square corners, mark ≈ 65–69 % of the tile); no corner-radius, safe-zone or maskable-icon guidance.
9. No social/OG image, photography, iconography, motion, tone-of-voice or layout-grid sections.
10. No product-specific mark or lockup for "OnDemand Spatial" — the guideline covers the OnDemand company brand only.

#### 8. DOCUMENTED vs SAMPLED vs DERIVED (summary)

| Class | Items |
|---|---|
| DOCUMENTED (text in the PDF) | the ten hex values and their two group labels (p9); the typeface name "Söhne" (p7); the icon-version paragraph (p4); the four wrong-treatment captions (p5) |
| DOCUMENT-OBSERVED (drawings in the PDF) | the lockup geometry and its vector paths (p2); the light-variant colour `#F7F7F5` and the grounds `#F7F7F5` / `#161616` (p2, p4); the `#000000` print colour (p2, p3); the icon-tile proportions (p4); the clear-space geometry (p3, MEASURED-FROM-DIAGRAM) |
| SAMPLED (from supplied PNGs) | `#0D5849` as the ink of the green logo rasters (coincides with documented Primary 1); `#0D0D0D` ink and the alternative mixed-case lockup of the uploaded PNG; `logo_dark.png` being a p3 crop |
| DERIVED (this repo's decisions) | every semantic alias and usage role; the 900/700/500/200/50 and 600–100 numbering; the green tile + 20 % radius of `mark.svg`; the 65 % mark ratio applied to a 512 px tile; the og-image composition (60 % width lockup on `#161616`); the 2 % viewBox pad; the font fallback stack; `--od-font-mono`; `site.webmanifest` names and colours |

##### Dark-header logo variant (recorded 2026-09-18)

**What the dark header actually renders.** The application header
(`src/ui/templates/scene-chrome.html`, lines 13–14) wires the lockup through a
`<picture>` element:

```html
<picture class="brand-wordmark-logo" aria-hidden="true"><source srcset="/brand/logo-dark.svg" media="(prefers-color-scheme: light)" /><img src="/brand/logo-light.svg" alt="" /></picture>
<h1><span class="title-logo brand-logo" data-logo-gaze data-logo-src="/brand/mark-light.svg" aria-hidden="true"><img src="/brand/mark-light.svg" alt="" /></span> <span class="brand-product">OnDemand <span class="title-accent">Spatial</span></span></h1>
```

- Default (and on every dark-scheme client, i.e. the console's own dark UI):
  **`public/brand/logo-light.svg`** — the full lockup recovered as vector from
  BrandGuidelines.pdf p2, single fill `#F7F7F5` (the guideline's documented
  light variant for dark grounds, p2 right half), plus the bare mark
  **`public/brand/mark-light.svg`** (`#F7F7F5`) in the `h1` logo slot
  (`data-logo-src="/brand/mark-light.svg"`, inlined by the logo-gaze module).
- Only when the operating system reports `prefers-color-scheme: light` does the
  `<source>` swap the lockup to **`public/brand/logo-dark.svg`** (fill
  `#0D5849`, Primary 1). The loading screen
  (`src/ui/templates/hud-loading.html`, lines 7–8) uses the identical pair.
- Favicons/OG are separate assets (`public/brand/mark.svg` tile,
  `favicon*.png`, `og-image.png`) and are not affected by a header swap.

**Decision: RETAINED AS-IS** (2026-09-18) — the light lockup on the dark header
is the guideline-documented pairing (p2) and passes contrast (`#F7F7F5` on
`#161616` ≈ 16.9:1).

**Alternative variants available in the user's file store** (all listed in §2
above with origins and hashes) should a swap ever be wanted:

| Asset | What it is | Suitability for the dark header |
|---|---|---|
| `logo_green.png` / `logo_header.png` (420×136, ink `#0D5849`) | the same lockup rasterised in Primary 1 green | low contrast on `#161616` (≈ 2.2:1) — would need a light tile behind it |
| `OD logo - black.png` (4746×1755, ink `#0D0D0D`) | a *different* mixed-case "On/Demand" design with a tagline line | black on a dark header is unreadable; also not the guideline lockup |
| `logo_dark.png` (844×273) | a crop of the BrandGuidelines.pdf p3 clear-space diagram (black lockup plus red guide lines) | not a clean logo asset — diagram artefact |
| `public/brand/logo-black.svg` (repo) | the p2 print variant, fill `#000000` | for light/print surfaces only |

**How a swap would be done (one-file change):** either replace the bytes of
`public/brand/logo-light.svg` with the chosen asset (keeping the file name so
no template changes), or point the single `<img src="/brand/logo-light.svg">`
in `src/ui/templates/scene-chrome.html` (and its twin in
`src/ui/templates/hud-loading.html`) at the new file under `public/brand/`.
Nothing else references the header lockup.
<!-- BRAND_SOURCE_END -->

## 4. Vercel environment-variable matrix — project `ondemand-eand-spatial`

Project `prj_VbHbEhFSDFkdXCqlq8XqONoFWQHO`, team `schoolhack-web-team`, framework `vite`, Git-linked to `mk42-ai/ondemand-eand-spatial` (production branch `main`). Names/types/targets from the project's env listing on 2026-09-18 — no values.

**PRESENT (20):**

| Name | Type | Targets | Note |
|---|---|---|---|
| `ONDEMAND_SPATIAL_FLOW_VERSION` | plain | production, preview | id `siAgsm6hBOQrEYcY`, created 2026-09-18 |
| `ONDEMAND_REASONING_ENDPOINT_ID` | sensitive | production, preview | |
| `ONDEMAND_SELFTEST_TOKEN` | sensitive | production, preview | |
| `GODS_EYE_FLOW_VERSION` | plain | production, preview | id `usC3wgbut65gTkaR` — alias, checked FIRST; **delete after** a deployment's `GET /api/ondemand/health` shows `config.flowVersion.source = ONDEMAND_SPATIAL_FLOW_VERSION` |
| `ONDEMAND_FULFILLMENT_ENDPOINT_ID` | sensitive | production, preview | |
| `VITE_SERVERLESS_MODE` | plain | production, preview | |
| `ONDEMAND_BASE_URL` | plain | production, preview | |
| `ASK_ENABLED` | plain | production, preview, development | |
| `ONDEMAND_API_KEY` | sensitive | production, preview, development | |
| `CI` | plain | preview, production | |
| `ONDEMAND_API_BASE` | sensitive | production, preview | alias of `ONDEMAND_BASE_URL` |
| `ONDEMAND_ENDPOINT_ID` | sensitive | production, preview | alias for both endpoint ids |
| `ONDEMAND_KNOWLEDGE_PLUGIN_IDS` | sensitive | production, preview | deny-listed by the app (never read) |
| `ONDEMAND_REASONING_MODE` | sensitive | production, preview | |
| `ASK_THE_DEAL_ALLOWED_ORIGIN` | sensitive | production, preview | not read by this app |
| `DOC_BUSINESS_PLAN_URL`, `DOC_BUSINESS_PLAN_PDF_URL`, `DOC_MOU_URL`, `DOC_GANTT_URL` | sensitive | production, preview | not read by this app |
| `ELEVENLABS_API_KEY` | sensitive | production, preview | deny-listed by the app (never read) |

**MISSING (needed for live data — names only):**

| Name | Read by | Effect when set |
|---|---|---|
| `ONDEMAND_SPATIAL_WORKFLOW_ID` (canonical; alias `ONDEMAND_SPATIAL_FLOW_ID`) | `server/ondemand/config.js` `WORKFLOW_ID_ENV` (canonical first) | pins the workflow id; without it the built-in default `6aace534859f7b0abb53d99a` (the real v1 id) is used — set only if the workflow is re-imported into another company |
| `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` | `server/providers/aircraft/opensky.js:236-237` | OpenSky OAuth2 client credentials (note: OpenSky black-holes cloud egress; see §7) |
| `AISSTREAM_API_KEY` | `server/providers/vessels/ais-serverless.js`, `ais-live.js` | live AIS via the bounded collector (demo replay otherwise) |
| `TOMTOM_API_KEY` | `server/providers/traffic.js:173,273,370,559` | live flow tiles + Flow Segment Data |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` **or** `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (optional) | `server/providers/vessels/kv-store.js:27-28` | shares AIS snapshots across function instances (`KV_URL` is **not** read) |
| `AISHUB_USERNAME` (optional) | `server/providers/vessels/ais-serverless.js:282` | keyless delayed AIS fallback |

**Deployment baseline (2026-09-18):** latest READY preview `dpl_FKoHEVctqpLzNMaHV9sSRdmzcrw6` (exec-brief v1.4.0 build, alias `ondemand-eand-spatial-opal.vercel.app`, branch `feat/exec-brief-v1.4-b7c0d3d`) — that host serves a **different** Vite app; production `dpl_7CAoCxdEQRQ7W12mzwz4iGKDK4V9` state **BLOCKED** ("The deployment was blocked because Vercel couldn't find a Git account for the commit author"; commit `e799775a`; alias answers `404 DEPLOYMENT_NOT_FOUND`). Every Git-triggered deployment authored by the bot account is BLOCKED for the same reason. A push to `mk42-ai/gods-eye-view` triggers nothing on this project.

## 5. Dashboard registration pack pointer

- Pack for the agent + nine skills + row-1 tool: **`docs/audit/dashboard-registration-pack.md`** (regenerated under the OnDemand Spatial names on 2026-09-18; also in the `code-files-20260918-080112_v1.zip` bundle in §2). Companion pack for the six REST plugins (new on `6320b58`): `docs/registration/ONDEMAND_REGISTRATION_PACK.md` with per-plugin specs under `docs/plugins/<id>/openapi.json` and `docs/PLUGIN_RESOLUTION.md` ("ids pending" table).
- The nine skills (`docs/ondemand-skills/`): `ondemand-spatial-spatial-context-reader`, `ondemand-spatial-intent-classifier`, `ondemand-spatial-capability-resolver`, `ondemand-spatial-map-action-planner`, `ondemand-spatial-seismic-analyst`, `ondemand-spatial-aviation-analyst`, `ondemand-spatial-maritime-analyst`, `ondemand-spatial-evidence-verifier`, `ondemand-spatial-structured-response-writer` — all `skillId: null` in `src/registry/capabilities.json`.
- The `earthquake_search` OpenAPI tool: `docs/ondemand-tools/earthquake_search.json` (extension key `x-ondemand-spatial`), server URL to be set to `<deployment>/api/sources/earthquakes` of the permanent deployment (also `docs/plugins/earthquakes/openapi.json` in the six-plugin pack).
- **Two IDs still awaited from the owner after dashboard registration:** the **tool ID for `earthquake_search`** (`capabilities[earthquake.search].ondemand_tool_id`, currently `null`) and the **agent ID for the OnDemand Spatial Intelligence Agent** (`ondemand.agent.pluginId`, currently `null`; env `ONDEMAND_SPATIAL_AGENT_ID`). Agent / REST-plugin creation is dashboard-only — no public REST create exists (`docs/ONDEMAND_API_CURRENT.md` §8 / §18.1).

## 6. CLI deploy runbook — into `ondemand-eand-spatial`

Run on an operator machine with a Vercel login (or `VERCEL_TOKEN` exported for CI). Names only for secrets.

```bash
# 1. Get the exact tree of the close-out commit
unzip ondemand-spatial-ondemand-serverless-<sha>.zip && cd gods-eye-view
# 2. Install, test, build (Node 24 recommended — the allocation gate is calibrated on it)
npm ci
npm test && npm run test:ondemand && npm run test:serverless
npm run build            # runs the prebuild TLE-snapshot refresh first
# 3. Link the checkout to the existing project (no Git push involved)
npx vercel link --scope schoolhack-web-team --project ondemand-eand-spatial --yes
# 4. In the Vercel dashboard → Settings → Environment Variables add (production + preview):
#    OPENSKY_CLIENT_ID, OPENSKY_CLIENT_SECRET, AISSTREAM_API_KEY, TOMTOM_API_KEY
#    optional: ONDEMAND_SPATIAL_WORKFLOW_ID, KV_REST_API_URL, KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN), AISHUB_USERNAME
# 5. Preview deployment, then production
npx vercel deploy                 # prints the preview deployment URL to stdout
npx vercel deploy --prod          # promotes a production deployment
# 6. Verify (replace <host>)
curl -s https://<host>/api/ondemand/health?envNames=1 | jq '.ondemand, .config.flowVersion, .config.spatialFlowId'
#    expect config.flowVersion.source = ONDEMAND_SPATIAL_FLOW_VERSION (resolvedVia canonical) once GODS_EYE_FLOW_VERSION is gone;
#    until then it reports source = GODS_EYE_FLOW_VERSION, resolvedVia = alias (by design)
curl -s 'https://<host>/api/sources/earthquakes?hours=24&minMagnitude=2.5' | jq '.ok, .data.count'
curl -s -H "x-selftest-token: $ONDEMAND_SELFTEST_TOKEN" https://<host>/api/ondemand/selftest | jq '.summary'
#    expect 9 passed / 0 failed / 1 skipped (step 4 skips until an agent/plugin id exists)
curl -s 'https://<host>/api/opensky?lat=30.2672&lon=-97.7431' -D - -o /dev/null | grep -i x-provider-
# 7. Delete GODS_EYE_FLOW_VERSION (env id usC3wgbut65gTkaR) in the dashboard, redeploy, re-check step 6
# 8. Unblock Git-triggered production: Team → Members — link the committer GitHub accounts
#    ("Vercel couldn't find a Git account for the commit author") or deploy via the CLI as above.
```

Vercel documentation: deployments can be created via Git, Vercel CLI, Deploy Hooks or the REST API (https://vercel.com/docs/deployments); CLI authentication in CI via the `VERCEL_TOKEN` environment variable and `vercel deploy` printing the deployment URL to stdout (https://vercel.com/docs/cli/deploy, https://vercel.com/docs/cli).

## 7. Movement-layer status table

| Row | Upstream chain | Root cause found (2026-09-18) | Current status on preview | Key required | Expected with key |
|---|---|---|---|---|---|
| Satellites | CelesTrak (`celestrak.org` → `celestrak.com`) → stale cache → bundled TLE snapshot `data/celestrak-active-snapshot.json` | our side: no retries/fallback; a cold instance re-fetched 7 groups and answered 502 when CelesTrak throttled the egress IP | **LIVE** (`LIVE · CelesTrak · <age>`; 20 station + 10,700 Starlink TLEs; edge `s-maxage=3600`) | none | LIVE |
| Live Flights | OpenSky (`OAuth2 client-credentials`, scene bbox ±1.5°) → adsb.lol `/v2/lat/lon/dist/250` → adsb.fi → (opt-in) airplanes.live → last-good | OpenSky connect-timeouts (`UND_ERR_CONNECT_TIMEOUT`) from cloud egress; old proxy fetched the whole world with no timeout → 502 | **DEGRADED · adsb.lol regional** (617 aircraft within 250 nm of Austin; reason text names OpenSky) | `OPENSKY_CLIENT_ID` + `OPENSKY_CLIENT_SECRET` | LIVE via OpenSky on hosts OpenSky does not block; on Vercel egress the breaker keeps adsb.lol/adsb.fi in front (network-level block, not auth) |
| Military Flights | adsb.lol `/v2/mil` (+ `/v2/point` mode) → adsb.fi `/api/v2/mil` → (opt-in) airplanes.live (returns 403 without approval) → last-good | upstream reachable; old proxy had no timeout and relayed failures as 502 | **LIVE** (`LIVE · adsb.lol · just now`; 139 within 600 nm, 395 worldwide) | none | LIVE |
| Live Vessels | bounded AISStream collector (≤ 8 s WebSocket per 0.25° scene box) + memory/KV cache → AISHub → labelled demo replay | hard-disabled in serverless (501 + client short-circuit) | Austin: `Demo replay · No vessels in scene`; Galveston Bay: `DEGRADED · Demo replay · AISSTREAM_API_KEY not set - demo replay, not live AIS` | `AISSTREAM_API_KEY` (+ optional KV names) | LIVE, possibly intermittent — AISStream issue #15 (filed 13 Mar 2026): subscription accepted but zero messages delivered; the collector reports that as DEGRADED + last-good |
| Street Traffic | TomTom Flow Segment Data + flow vector tiles, on the Overpass (OSM) road network | TomTom 401 keyless (no `TOMTOM_API_KEY`); public Overpass mirrors 406 / time-outs from this egress | **DEGRADED · TomTom · TOMTOM_API_KEY not set — showing simulated flow on live OSM roads …** (road geometry itself subject to the Overpass block, §8) | `TOMTOM_API_KEY` | LIVE flow colours/speeds; road network still subject to Overpass |

## 8. Overpass road-network decision (owner decision required)

The Street Traffic layer paints flow on OSM road geometry fetched through `/api/overpass`. On 2026-09-18 `overpass-api.de` (and `lz4.` / `z.`) answered **HTTP 406 Not Acceptable** for every request from both the Vercel sandbox and a residential network (even `/api/status`); `overpass.kumi.systems` and `overpass.private.coffee` timed out (25–45 s); `overpass.osm.ch` answered 200 but is a Switzerland-only extract; `overpass.openstreetmap.ru` connect-timed-out; `maps.mail.ru` 504. Options:

1. **Self-hosted Overpass instance** (planet or a North-America extract; durable, ~hours to stand up, needs a VM with 100+ GB disk) — the app's `OVERPASS_UPSTREAMS` env var already accepts a custom mirror list.
2. **Alternative road-network source**: a pre-processed regional OSM extract served as vector tiles (e.g. Protomaps/PMTiles or tilemaker output), Postpass, or a commercial vector road dataset — swap `src/layers/traffic/source.js#requestRoads` to the new source.
3. **TomTom traffic vector tiles as the road geometry** alongside the flow data (one provider, needs `TOMTOM_API_KEY`; geometry and flow stay consistent).
4. **Retry the public mirrors with a compliant `User-Agent` + the query in the POST body per the 2026 rules** — the proxy already sends `ondemand-spatial/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)` and a URL-encoded POST body and still receives 406 from this egress, so this is a mitigation only, not durable.

Until decided, the row reads `DEGRADED · OpenStreetMap · OpenStreetMap roads unavailable — public Overpass mirrors refuse this deployment (HTTP 406); simulated traffic needs OSM roads` once a road fetch fails, and `DEGRADED · TomTom · TOMTOM_API_KEY not set …` while loading.

## 9. Cited findings (step-3 research, 2026-09-18)

- **Overpass 406 / mirror health** — OpenStreetMap community: public Overpass instances returning HTTP 406 since the April 2026 rule changes; setting a descriptive `User-Agent` header and sending the query in the POST body resolves 406 for some clients; the main `overpass-api.de` instance described as unreliable for months and alternative mirrors partially stale (two `private.coffee` servers days behind). https://community.openstreetmap.org/t/overpass-api-error-406/143198 · https://community.openstreetmap.org/t/overpass-api-performance-issues/140598
- **OpenSky REST API** — root `https://opensky-network.org/api`, `GET /states/all` with optional `lamin/lomin/lamax/lomax` bounding box; rate limits apply to anonymous callers. https://openskynetwork.github.io/opensky-api/rest.html — and the OAuth2 **client-credentials** grant is the correct machine-to-machine flow for server-side calls (`POST https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token`, `grant_type=client_credentials`). https://developer.okta.com/blog/2021/05/05/client-credentials-spring-security
- **TomTom Traffic APIs** — Flow and Incidents, updated every 30 s, free trial available; Intermediate Traffic evaluation account for bulk flow. https://www.tomtom.com/products/traffic-apis/ · https://docs.tomtom.com/intermediate-traffic-service/documentation/introduction
- **AISStream** — GitHub issue aisstream/aisstream#15 (2026-03-13): subscription accepted, socket open, zero messages for minutes (handled as DEGRADED + last-good by the collector); bounding boxes must be `[[[lat,lon],[lat,lon]]]` (issue #84 "Subscription Object Is Malformed").
- **Vercel deployments** — created via Git, Vercel CLI, Deploy Hooks or the REST API; CLI auth in CI through `VERCEL_TOKEN`; `vercel deploy` prints the deployment URL to stdout. https://vercel.com/docs/deployments · https://vercel.com/docs/cli/deploy · https://vercel.com/docs/cli
- **Measured this project (not third-party):** OpenSky `UND_ERR_CONNECT_TIMEOUT` from Vercel egress (13:2xZ), CelesTrak 200, adsb.lol/adsb.fi 200, airplanes.live 403, TomTom 401 keyless, Overpass 406 — `docs/MOVEMENT-LAYERS.md` §1.

## 10. Next-run backlog

1. Owner confirms the flow-ID variable name (`ONDEMAND_SPATIAL_WORKFLOW_ID`, alias `ONDEMAND_SPATIAL_FLOW_ID`) or approves relying on the code default `6aace534859f7b0abb53d99a`.
2. Keys added in Vercel: `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`, `AISSTREAM_API_KEY`, `TOMTOM_API_KEY` (optional KV / `AISHUB_USERNAME`).
3. CLI deploy per §6; paste the resulting deployment URL and the health/selftest output back; then delete `GODS_EYE_FLOW_VERSION`.
4. Badge text pasted back (the DATA LAYERS rows as rendered on the permanent deployment).
5. Tool ID (`earthquake_search`) + agent ID (OnDemand Spatial Intelligence Agent) + the six REST-plugin ids from the dashboard → `src/registry/capabilities.json` / `ONDEMAND_SPATIAL_AGENT_ID`.
6. Fires row (`fires.search`, `FIRMS_MAP_KEY`).
7. Overpass road-network decision (§8).
8. Optional: confirm `mk42-ai/gods-eye-view` as the canonical remote (write access verified by the pushes of 2026-09-18) or nominate another.

## 11. Character-exact configuration facts (quoted 2026-09-18 18:01Z)

- `.env.example:313` → `ONDEMAND_SPATIAL_WORKFLOW_ID=6aace534859f7b0abb53d99a` (flow/workflow-ID variable); `.env.example:314` → `# ONDEMAND_SPATIAL_FLOW_ID=6aace534859f7b0abb53d99a   # alias — same value, checked second`
- `.env.example:364` → `ONDEMAND_SPATIAL_FLOW_VERSION=1`; `.env.example:365` → `# GODS_EYE_FLOW_VERSION=1`
- `server/ondemand/config.js:239-247` → `FLOW_VERSION_ENV = { canonical: 'ONDEMAND_SPATIAL_FLOW_VERSION', alias: 'GODS_EYE_FLOW_VERSION', order: ['GODS_EYE_FLOW_VERSION', 'ONDEMAND_SPATIAL_FLOW_VERSION', 'default'] }`; `:511-515` → `reconcileAliasFirst(FLOW_VERSION_ENV.alias, FLOW_VERSION_ENV.canonical, FLOW_DEFAULTS.flowVersion)`
- `server/ondemand/config.js:264-272` → `WORKFLOW_ID_ENV = { canonical: 'ONDEMAND_SPATIAL_WORKFLOW_ID', alias: 'ONDEMAND_SPATIAL_FLOW_ID', order: ['ONDEMAND_SPATIAL_WORKFLOW_ID', 'ONDEMAND_SPATIAL_FLOW_ID', 'default'] }`; `:499-503` → `reconcile(WORKFLOW_ID_ENV.canonical, WORKFLOW_ID_ENV.alias, FLOW_DEFAULTS.spatialFlowId)`
- `server/ondemand/config.js:423` → `spatialFlowId: '6aace534859f7b0abb53d99a',` (24 hex characters — the 26-character spelling `6aace534859f9f7b0abb53d99a` seen in one operator prompt is invalid and answers 404); `api/ondemand/_config.js:41` and `:69` quote the same literal.

## 12. Close-out commit and push

Filled in by the close-out run (see the PDF and the final response): commit `docs: close-out decisions and handover 2026-09-18` on top of `6320b58`, pushed to `origin ondemand-serverless`; `git ls-remote` after the push must equal `git rev-parse HEAD`.
