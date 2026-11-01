# Production bundle audit

Measurement-first follow-up to [issue #40](https://github.com/bilawalsidhu/gods-eye-view/issues/40)
and the [maintainer-endorsed first-PR scope](https://github.com/bilawalsidhu/gods-eye-view/issues/40#issuecomment-5973525744).

```sh
npm run build
npm run audit:bundle
npm run --silent audit:bundle -- --json > bundle-audit.json
node --test src/tooling/bundleAudit.test.mjs
```

Build first: the reporter reads the completed default `dist/` and its new
`.vite/manifest.json`. It neither builds nor executes the application. An optional
directory argument supports fixture builds. CI reports sizes after the existing
Linux Node 24/26 and Windows production builds. The existing 1,500 kB Vite warning
is unchanged. No dependency or runtime behavior changes are required.

## What the numbers mean

- Every deployed file is counted once, including public files and the Cesium
  plugin's copied library, widgets, workers and resources. The audit manifest
  itself is excluded. JSON lists every file, its kind, load group, source path
  when available, raw bytes and gzip bytes.
- Raw sizes are file byte lengths. Gzip uses Node's zlib at level 9, separately
  per text file (JS, CSS, HTML, JSON/GeoJSON/GeoJSONL, SVG, XML, TXT and GLSL).
  Binary sizes are raw only (`gzipBytes: null`). `gzipTextBytes` totals include
  only those text files. These are compression estimates, not a claim that a
  deployment sends gzip; headers, Brotli, caching and request overhead differ.
- `initial` means local script/stylesheet tags in generated `index.html`, plus
  their manifest static-import closure and associated CSS. This includes the
  externalized, locally copied `cesium/Cesium.js` and widgets CSS that Vite's
  normal chunk table omits. HTML is reported separately. The parser supports
  the default build's root/relative URLs and quoted HTML attributes; custom
  public base paths and other HTML entrypoints are outside this audit's scope.
- `dynamic` means reachable through a dynamic import edge, including each
  chunk's static dependencies and CSS where metadata connects it. Initial
  ownership wins when chunks are shared. This is a graph classification:
  dynamic imports can execute during startup, and a chunk is not automatically
  a feature-demand chunk.
- `unclassified` means request timing is not established. Manifest `assets`
  lists URL references, not fetch timing. Data packs, CSS-only entries without
  graph edges, worker URLs and copied resources stay here unless directly
  proven initial by HTML. In particular, initial data bytes are **unknown**,
  not zero. Images, CSS URL resources, runtime data/API calls and worker
  dependencies are not added to the initial JS/CSS total.
- Remote HTML script/stylesheets are listed but never fetched or sized. The
  current build references two Google Fonts stylesheets. Font responses,
  imagery/terrain and other provider traffic require a separate browser trace.

Output ordering uses file paths and integer bytes, with raw-size rankings
breaking ties by path. Reports contain no timestamps or absolute paths. Missing
metadata, referenced files or graph entries fail the audit rather than silently
shrinking its totals. A stale but internally consistent `dist/` cannot be
detected; always rebuild. The optional panel build has a different loading
contract and is outside this first PR.

## Baseline and largest costs

Measured on upstream main `a4d3701c3cd62b46c90383973f38cfdbedf91889`
(v0.3.0), Windows x64, Node 24.14.0, installed locked Vite 6.4.3, on
2026-10-28. Fresh `npm run build` runs on pristine main and this contribution
preserved all 447 deployed files byte-for-byte; the manifest is the only added
output. The same Node 24.14.0 audit on Ubuntu 24.04 under WSL2, using native Linux
dependencies and filesystem, produced matching raw/gzip measurements. Build-time
public environment inputs can change the entry chunk, so this is a recorded
local baseline, not a universal golden file.

| Scope                            |  Raw bytes | Gzip text bytes |
| -------------------------------- | ---------: | --------------: |
| Entire deployed tree (447 files) | 45,015,180 |      12,786,468 |
| Initial JS (2 files)             |  9,719,127 |       2,967,697 |
| Initial CSS (2 files)            |    377,544 |          64,993 |
| Initial HTML                     |     86,751 |          18,119 |
| Dynamic JS graph (6 files)       |  4,523,988 |       2,340,988 |

Largest individual costs (hashed filenames are available in each report):

| Asset                              | Raw bytes | Gzip bytes | Acquisition evidence / follow-up                                                                                                                      |
| ---------------------------------- | --------: | ---------: | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cesium/Cesium.js`                 | 5,726,887 |  1,698,436 | **startup**: script tag in generated HTML; the largest initial dependency                                                                             |
| Main `index-*.js`                  | 3,992,240 |  1,269,261 | **startup**: HTML module entry; module-level attribution would need another analysis pass                                                             |
| `names-*.json`                     | 3,856,476 |  1,715,185 | Installation context loader in `src/data/militaryNames.js`; emitted data, timing unclassified by metadata                                             |
| `states_provinces-*.json`          | 3,648,916 |  1,258,444 | **feature-demand** in `src/data/adminBoundaries.js`: first applicable outline lookup; metadata only proves a reference                                |
| `egm96-universal.esm-*.js`         | 2,770,496 |  1,849,986 | Dynamic edge, but **startup/first-visible** use is possible: `src/hud.js` requests the geoid for altitude readout; flight/vessel enables also warm it |
| `datacenters-*.geojsonl`           | 2,561,978 |    616,708 | Infrastructure dataset URL owned by `src/sources/infrastructureData.js`; timing unclassified by metadata                                              |
| `regions-*.json`                   | 1,987,099 |    682,241 | Natural Earth lookup pack in `src/data/naturalEarthRegions.js`; timing unclassified by metadata                                                       |
| `counties-*.json`                  | 1,541,464 |    530,798 | **feature-demand** in `src/data/adminBoundaries.js`: county outline lookup                                                                            |
| `events/bhote-koshi-2026/pre.webp` | 1,353,906 |        n/a | Copied event imagery; request timing unclassified                                                                                                     |
| `mapillary.module-*.js`            | 1,061,852 |    272,932 | **feature-demand**: `ensureLibrary()` in the Mapillary viewer; its separately imported CSS remains unclassified where Vite omits the graph edge       |
| `hls-*.js`                         |   595,074 |    185,290 | **feature-demand**: CCTV `videoPlayback.js` loads it for HLS playback                                                                                 |

The semantic labels above are source-inspection observations, not automatic
claims from chunk names. No asset is assigned `background-optional` without
evidence. A browser trace across default startup, restored views and cold first
use is needed before making complete acquisition or latency claims.

## Budget decision

This first PR enforces no byte threshold. The static JS/CSS portion is measurable,
but it is not the complete initial payload: geoid loading and URL-fetched data
can occur during startup outside that graph. The Windows/Linux Node 24.14.0
measurements match, but other Node versions and build inputs have not been
calibrated, and gzip output can vary with zlib versions. CI now exposes comparable
measurements on its existing environments. Use those results and a browser startup trace to choose
a narrow raw-byte scope and explicit headroom before adding a conservative
regression budget. Do not raise the Vite warning or invent per-feature limits
to make the current build pass.

No equivalent bundle audit or budget was found in main's build/QA scripts, CI,
or the open PRs inspected on 2026-10-28. Adjacent work includes [#763](https://github.com/bilawalsidhu/gods-eye-view/pull/763)
(Cesium plugin replacement, touching `build/vite.js`) and
[#1380](https://github.com/bilawalsidhu/gods-eye-view/pull/1380)
(build-stack dependency updates). Refresh the baseline after either lands.
