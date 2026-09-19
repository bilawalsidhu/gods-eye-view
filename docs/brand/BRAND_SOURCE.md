# OnDemand brand — evidence ledger (BRAND_SOURCE)

| Field | Value |
|---|---|
| Generated (UTC) | 2026-09-18 (extraction run at ≈10:52Z; every retrieval timestamp below is from `/tmp/brand-src/manifest.txt`) |
| Method | Every value in `src/brand/tokens.css`, every file in `public/brand/` and every statement in `docs/BRANDING.md` was taken from the source files listed in §1–§2, read offline with PyMuPDF 1.28.2 (`page.get_text()`, `page.get_drawings()`), Pillow 12.3 and NumPy. No web fetch, no memory, no prior knowledge. |
| Citation format | `(src: <origin host/path>, retrieved <UTC>)` — the same convention as `docs/ONDEMAND_API_CURRENT.md`. Origins are Azure Blob paths with the SAS query (`?se=…&sig=…`) stripped; they are recorded for provenance only and are not public URLs. |
| Evidence labels | **DOCUMENTED** = printed as text in the guideline · **DOCUMENT-OBSERVED** = read from the guideline's own drawings (page grounds, logo fills) · **SAMPLED** = measured from a supplied PNG · **MEASURED-FROM-DIAGRAM** = geometry of the p3 clear-space diagram (no numeric text exists) · **DERIVED** = this repo's choice, the guideline is silent · **NOT DOCUMENTED** = absent from every source. |
| Not-found rule | Anything the guideline does not state is listed in §7 (MISSING) and is never presented as brand policy. |

## 1. Source documents (the brand guideline PDF and its copies)

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

## 2. Supplied logo raster assets

All PNGs are RGBA with a transparent background. "Ink" is the most frequent fully-opaque RGB value.

| File (local name) | Original name / origin host/path (SAS stripped) | sha256 | Bytes | Pixels | Ink | Retrieved (UTC) | What it is |
|---|---|---|---|---|---|---|---|
| `OD_logo_black_upload.png` | uploaded original "OD logo - black.png" — `airevprod.blob.core.windows.net/on-demand-prod/6692b763e851d28a036ab30e/media/OD_logo_-_black_4jx1.png` (mediaId not supplied) | `e9af7e526fd7318586354c67e1df64b74745e7396d153f5a76235213d61fbd7e` | 139,765 | 4746 × 1755 (opaque bbox 4556 × 1456 at offset 95,95) | `#0D0D0D` | 2026-09-18T10:34:43Z | Highest-resolution raster, but a **different lockup design** from the guideline: circular mark 1198 × 1198 px + a mixed-case wordmark ("On" over "Demand", x-height wordmark taller than the mark) + a third line of small tagline glyphs (161 px tall, unreadable at raster level). Aspect 3.129:1 incl. the tagline. Used only as a cross-check of the mark silhouette. |
| `logo_green.png` = `ondemand_logo_green.png` = `logo_green_alt.png` (identical bytes) | `…/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6a38d1ac7136611a3377845b/6a38d1b77136611a3377845c/generated/logo_green_v1.png` · `…/6a38aaf0d452c967922ad9e2/6a38ab035e5e6970ca97e096/generated/ondemand_logo_green_v1.png` · `…/6a3c0d50423751f5706a14ec/6a3c102e00bad1c8a0d31118/generated/logo_green_alt_v1.png` (host `airevprod.blob.core.windows.net`) | `c7abbe0a73d652a681ec4499b54df9b44cf7f0428bf73fbd25946835c8c40d0b` | 27,888 | 420 × 136 (lockup 414 × 126 at alpha > 128) | `#0D5849` (2594 px; anti-aliased neighbours `#0D5749`, `#0E5E4E`) | 2026-09-18T10:34:43Z | Low-resolution raster of the guideline's ON/DEMAND lockup, recoloured to Primary 1. Aspect 3.286:1; mark = 29.2 % of the width. |
| `logo_header.png` = `logo_cover.png` = `brand_logo_header.png` (identical bytes) | `…/6a3c0d50423751f5706a14ec/6a3c102e00bad1c8a0d31118/generated/logo_header_v1.png` · `…/6a3c0d50423751f5706a14ec/6a3c102e00bad1c8a0d31118/generated/logo_cover_v1.png` · `…/6a3e712dc459c8a8dbb631a9/6a3e716cc459c8a8dbb631ab/generated/brand_logo_header_v1.png` (host `airevprod.blob.core.windows.net`) | `58c1684fc5afcb1caa5b310524bd2bc09a7aec97e7cc638edca9d40346f739d0` | 28,164 | 420 × 136 | `#0D5849` | 2026-09-18T10:34:43Z | Visually identical to the `logo_green` group (same silhouette, same ink); differs only in PNG encoding. |
| `logo_dark.png` | `…/6a386dbbd452c967922ad915/6a386e39d482c9678b285d78/generated/logo_dark_v1.png` (host `airevprod.blob.core.windows.net`) | `ed05df27dd3e398e0d3a678130ea5471ca0e14a5dcb7efb12ca0c498561d602f` | 31,395 | 844 × 273 (lockup 833 × 251 at alpha > 128) | `#000000` (26,391 px) + 818 red pixels | 2026-09-18T10:34:43Z | A crop of the p3 clear-space diagram: black lockup with `#FF4949` guide-line residue along the top edge. **Not a clean logo**; not used. Aspect 3.319:1; mark = 29.4 % of the width. |

None of the supplied files is a vector (SVG/PDF/EPS logo). The vector lockup shipped in `public/brand/*.svg` was therefore **recovered from the PDF page drawings** (§4).

## 3. Colour values

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

## 4. Logo: what the guideline shows and how the vector was recovered

**Lockup (p2, "Logo 1.1").** Left half: `#F7F7F5` ground with the lockup in `#000000`; right half: `#161616` ground with the identical lockup in `#F7F7F5`. The lockup = a circular mark (a ring whose vertical stem joins the ring at the bottom) followed by a **stacked uppercase wordmark, "ON" over "DEMAND"**, set to the right of the mark. Drawing items on p2 (`page.get_drawings()` index): 34 = mark, 79.346 × 79.346 pt, rect (345.0, 500.0)–(424.346, 579.346), 15 path segments (`cclllccccllllcc`), two subpaths, `even_odd = True`; 33–32 = "O","N" (y 501.7–531.8); 31–26 = "D","E","M","A","N","D" (y 548.3–577.7); wordmark x 438.15–614.665. Items 16–24 are the same shapes at x + 960 in `#F7F7F5`; items 1–14 are hidden leftovers painted underneath the background rectangles and were ignored. Tight bbox of the lockup: **269.665 × 79.346 pt, aspect 3.3986:1**; mark = 29.4 % of the width; gap mark→wordmark = 13.8 pt (0.174 × mark); wordmark line heights 30.1 pt ("ON", y 501.7–531.8) and 29.4 pt ("DEMAND", y 548.3–577.7), line gap 16.5 pt.

**Recovery method.** For each item the PyMuPDF path segments were converted to SVG path data: `('l', p1, p2)` → `L`, `('c', p1, p2, p3, p4)` → `C p2 p3 p4`, `('re', rect)` / `('qu', quad)` → closed polygons; a new subpath (`M`) starts whenever a segment's start point differs from the previous end point; every subpath is closed with `Z`; `fill-rule="evenodd"` is set only where `d['even_odd']` is true (the mark). Coordinates were translated so the viewBox origin is the lockup bbox corner minus a 1.587 pt pad (2 % of the height) on every side → `viewBox="0 0 272.839 82.52"` (mark files: `0 0 82.52 82.52`). The fill is a single attribute on one `<g>`.

**Verification.** `logo-black.svg` rendered with MuPDF at 4000 px: opaque bbox 3954 × 1163 px, aspect **3.3998:1** (matches the source bbox). ImageMagick's independent SVG renderer gives 3.375:1 on a 600 px render (its own edge sampling). Against the supplied rasters: the same-design `logo_green.png` measures 3.286:1 and `logo_dark.png` 3.319:1 at an alpha > 128 threshold (low resolution + anti-aliasing), with the mark at 29.2 % / 29.4 % of the width — the silhouettes match (ring + bottom-joined stem, "ON" over "DEMAND"). The uploaded `OD_logo_black_upload.png` measures 3.129:1 but is a different design (mixed-case wordmark plus a tagline line; 3.80:1 without the tagline), so its ratio is not comparable — only its circular mark motif matches.

**Icon version (p4, "Logo 1.3").** Verbatim text: *"Icon version is used wherever long version would not be reconizable because of size or where icon version is visually more appealing. Example: Social Media Profile Icons"*. Drawings: dark tile `#161616` (401,515)–(559,676) = 158 × 161 pt with the mark in `#F7F7F5` at (425,543)–(528,646) = 103 pt (65 % of the tile width, insets 24/31 left/right, 28/30 top/bottom); light tile `#F7F7F5` (1361,515)–(1519,676) with the mark in `#161616` at (1382,540)–(1491,649) = 109 pt (69 %). Both tiles have **square** corners. `mark.svg` follows the dark tile (mark at 65 %, centred) but uses the Primary-1 green `#0D5849` as the tile and a 20 % corner radius — both **DERIVED** choices, not shown on p4.

## 5. Typography

- p7 prints exactly two strings besides the running header: **"Söhne"** (set at 194 pt) and **"Download Font"** (40 pt). p6 is the section cover ("Typography / 02"). DOCUMENTED (src: primary PDF p6–p7, retrieved 2026-09-18T10:34:42Z).
- **Nothing else is documented**: no weights, no sizes, no line-heights, no letter-spacing, no type scale, no secondary/mono face, no web-font licence note. The PDF embeds no font programs (all glyphs are Type3 outlines), so the family cannot be sampled from the file either.
- Söhne is a commercial family (Klim Type Foundry) and is not bundled in this repository. `--od-font-brand` therefore lists `"Söhne"` first and falls back to Inter, which `index.html` already loads from Google Fonts. `--od-font-mono` (JetBrains Mono) is an app convention, NOT DOCUMENTED.

## 6. Rules with page references

| Rule | Evidence | Detail |
|---|---|---|
| Clear space | MEASURED-FROM-DIAGRAM, p3 "Logo 1.2" | Red `#FF4949` guides: vertical x = 646.5–647.5, 796.5–797.5, 1093.5–1094.5, 1243.5–1244.5; horizontal y = 424.5–425.5, 478.5–479.5, 570.5–571.5, 620.5–621.5 (each 1 pt thick, drawn as filled rectangles). Black lockup at (810.0, 483.0)–(1079.7, 562.3). Horizontal bands 647→797 and 1094→1244 = **150 pt = 0.556 × lockup width**; vertical bands 425→479 = 54 pt and 571→621 = 50 pt = **0.63–0.68 × lockup height**. Four grey `#DEDEDE` ghost lockups sit in the corner bands, each 148.3 × 43.7 pt = **55 % scale** (mark 43.6 pt), e.g. (647.7, 430.6)–(796.0, 474.3). Measured from the lockup's own edges to the outer guides: 163 / 164.3 pt left/right (0.60–0.61 W), 58 / 58.7 pt top/bottom (0.73–0.74 H). No numeric text is printed → tokens `--od-logo-clear-space: 0.56` (× width, sides) and `--od-logo-clear-space-y: 0.65` (× height, top/bottom). |
| Icon version | DOCUMENTED text + measured drawings, p4 "Logo 1.3" | See §4. Use the bare mark where the full lockup "would not be recognizable because of size" — e.g. profile icons, favicons. |
| Minimum size | NOT DOCUMENTED | No numeric minimum size on any page; p4 only gives the qualitative "not recognizable because of size" trigger. |
| Wrong treatments | DOCUMENTED, p5 "Logo 1.4" | Verbatim: "Not enough contrast between background and logo" · "The logo proportions should be kept intact" · "The logo should not be rotated" · "The logo should have enough space around it". Intro text: "Here are couple of examples of wrong logo treatments. Please always make sure you're following rules from this guide." (The strings "Produkt Driven" / "Growth" also appear on p5 as text inside one of the example layouts.) |
| Colour variants of the logo | DOCUMENT-OBSERVED, p2/p4 | Only `#000000` on `#F7F7F5` (p2 left), `#F7F7F5` on `#161616` (p2 right, p4 dark tile) and `#161616` on `#F7F7F5` (p4 light tile) are shown. A **green** lockup is not shown in the guideline; the green `#0D5849` used by `logo-dark.svg` / `mark.svg` is taken from the supplied PNG assets (SAMPLED) and equals Primary 1 (DOCUMENTED). |

## 7. MISSING — what the guideline does not provide

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

## 8. DOCUMENTED vs SAMPLED vs DERIVED (summary)

| Class | Items |
|---|---|
| DOCUMENTED (text in the PDF) | the ten hex values and their two group labels (p9); the typeface name "Söhne" (p7); the icon-version paragraph (p4); the four wrong-treatment captions (p5) |
| DOCUMENT-OBSERVED (drawings in the PDF) | the lockup geometry and its vector paths (p2); the light-variant colour `#F7F7F5` and the grounds `#F7F7F5` / `#161616` (p2, p4); the `#000000` print colour (p2, p3); the icon-tile proportions (p4); the clear-space geometry (p3, MEASURED-FROM-DIAGRAM) |
| SAMPLED (from supplied PNGs) | `#0D5849` as the ink of the green logo rasters (coincides with documented Primary 1); `#0D0D0D` ink and the alternative mixed-case lockup of the uploaded PNG; `logo_dark.png` being a p3 crop |
| DERIVED (this repo's decisions) | every semantic alias and usage role; the 900/700/500/200/50 and 600–100 numbering; the green tile + 20 % radius of `mark.svg`; the 65 % mark ratio applied to a 512 px tile; the og-image composition (60 % width lockup on `#161616`); the 2 % viewBox pad; the font fallback stack; `--od-font-mono`; `site.webmanifest` names and colours |

### Dark-header logo variant (recorded 2026-09-18)

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
