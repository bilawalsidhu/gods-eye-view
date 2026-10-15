# San Antonio parks and trails

This contribution adds three municipal reference collections to God's Eye View:
park boundaries, trail network segments and trailhead locations. Each has its own
control, source result and share-state identity. The scope is the City-published
collection, which can include regional features; no feature count is presented as
the number of distinct City parks or named trails.

## Try the layers

1. Use a supported Node version, run `npm ci`, then `npm run dev`.
2. Open `http://localhost:4173` and navigate to San Antonio, Texas.
3. Expand Data Layers > San Antonio and enable Parks, Trails or Trailheads.
4. Click a mapped feature to see its source name, available type/surface/length
   facts and the ArcGIS data-edit date. The card opens the corresponding City
   catalog entry.
5. Share links preserve all three visibility choices. Turning a layer off removes
   its graphics and selected card. A subsequent activation can use the six-hour
   session cache without another download.

Parks are green, trails amber, and trailheads cyan. These are map categories;
color does not indicate current access, closure, risk or conditions. Trailhead
markers disappear beyond 250 km viewing distance. Trail and polygon geometry is
clamped to the map surface, with polygon holes and multipart features retained.

## Source contract and ownership

`src/layers/sanAntonio/config.js` owns the three fixed URLs, public fields and
presentation descriptions. `source.js` owns network acquisition and its bounded
in-memory cache. `records.js` owns geometry validation, stable IDs, cleaned text
and card anchors. `renderer.js` owns Cesium resources. `index.js` owns acquisition
lifetime, replacement, cancellation, selection and stats. The adapter in
`src/app/layers/sanAntonio.js` supplies the application's pointer, picking and
overlay services; reusable modules do not import the standalone application.

Package exports:

```js
import { createSanAntonioLayer, getSanAntonioDataset } from
  'gods-eye-view/layers/san-antonio';
import { createSanAntonioSource } from
  'gods-eye-view/layers/san-antonio/source';

const source = createSanAntonioSource({ fetchImpl: fetch });
const layer = createSanAntonioLayer({
  dataset: getSanAntonioDataset('san-antonio-parks'),
  source,
});
```

The source method is `getSnapshot({ datasetId, signal })`. It returns
`{ features, sourceUpdatedAt, fetchedAt, sourceCount }`, with timestamps in epoch
milliseconds and an unknown source date represented by `null`. Construction does
not fetch. `sources['san-antonio']` supplies this contract to application catalog
composition; standalone creates the default City adapter. A null source makes
the three controls unavailable instead of treating missing configuration as an
empty dataset.

### Fields

| Layer ID | Requested fields |
| --- | --- |
| `san-antonio-parks` | `OBJECTID, ParkID, ParkName, AltParkName, ParkType` |
| `san-antonio-trails` | `OBJECTID, Trail_ID, TrailType, TrailSubtype, TrailName, TrailMiles, TrailSource` |
| `san-antonio-trailheads` | `OBJECTID, Name` |

IDs combine the layer ID and City OBJECTID. Missing names use a type/ID fallback;
missing mileage is not treated as zero. Provider text is bounded and cleaned
before presentation. Only fixed City catalog URLs can be opened from cards.
Neither owner records nor internal staff fields are requested.

### Completeness and lifecycle

The adapter requests layer metadata and a current record count, then pages in
OBJECTID order with `outSR=4326`, `f=geojson`, explicit fields and no M/Z values.
It rejects ArcGIS error envelopes, malformed or incomplete responses, duplicate
IDs and source changes detected by the final count/edit-date check. No partially
downloaded result enters the cache. Default acquisition ceilings are 2,000 rows
per page, 10,000 features, 10 pages, 16 MiB per page, 32 MiB across responses and
60 seconds for the whole acquisition. The cache contains at most the three
approved collections for six hours.

Geometry normalization additionally caps parts, rings and coordinate counts.
It validates finite WGS84 coordinates within a regional envelope wider than
Bexar County. It rejects entire invalid features, records their omitted count and
marks the layer partial; it never cuts a polygon ring or line to fit a cap.
A nonempty source with no usable geometry is an error. A valid empty collection
is a successful empty result. Failed refreshes retain the prior complete display
with a stale/error state.

Parks and trails use batched ground primitives instead of thousands of dynamic
entities. Only trailhead points use a small Cesium data source. Disable and
destroy cancel pending acquisition and renderer installation, remove primitives,
points and click handlers, and clear selected-card entries. The source cache
contains ordinary data only. Late asynchronous results cannot revive a disabled
layer. There is no camera-frame network polling or permanent data archive.

## Terms and source dates

See [DATA_SOURCES.md](../DATA_SOURCES.md#san-antonio-parks-and-trails) for the
conditional City terms, exact catalog/service links, attribution and licensing
limits. Source data is separate from the repository's MIT code license. No real
City GeoJSON is committed; the tests use invented fixtures.

Original catalog publication dates are 2017-08-21 for Park Boundaries and Park
Trailheads, and 2019-10-17 for Park Trails. Current data-edit dates come from
ArcGIS at runtime; a schema/catalog metadata edit is not represented as a new
data observation. Download times indicate when this app retrieved a snapshot.

## Validation before a pull request

The implemented source and normalizer acquired all three live services on
2026-10-11 at 04:54 UTC. All 5,396 returned features were accepted without
omitting a geometry. These are observations from that run, not pinned runtime
counts or guarantees that the City catalog remains unchanged.

| Collection | Accepted features | ArcGIS data-edit date (UTC) |
| --- | ---: | --- |
| Park Boundaries | 337 | 2025-01-23 16:50:08.029 |
| Park Trails | 4,976 | 2026-07-20 04:03:46.910 |
| Park Trailheads | 83 | 2026-07-20 04:04:04.680 |

The acquisition contained 48 multipart park features, nine polygon holes and
four multipart trail features. Geometry equality checks confirmed that every
accepted source coordinate was preserved by normalization. One missing trail
mileage remained missing. Renderer tests additionally execute Cesium's ground
polyline geometry builder for closed boundaries, including repeated closing
vertices, to prevent zero-length outline segments from breaking the globe.

With the dev server running on port 4173:

```bash
npm run build
npm test
npm run test:track
node scripts/qa-san-antonio.mjs
npm run format:check
npm run check:boundaries
npm run layer-token:check -- --base-ref origin/main
```

The source and lifecycle unit tests cover pagination and failure atomicity,
bounded responses, cancellation, invalid geometry, stale display and selection.
The browser gate supplies synthetic ArcGIS responses to the real app and checks
rendering, selection, resource cleanup, cached reactivation and share restoration.
It does not depend on the City service being online. A separate live acquisition
check is useful before submission to verify current schema and network behavior;
do not commit downloaded City data as a test fixture.

The three share tokens are provisional until merge: parks `3`, trails `4`,
trailheads `5`. After rebasing, preserve all upstream reservations and follow
the allocation procedure in [CONTRIBUTING.md](../CONTRIBUTING.md#share-link-layer-tokens).

## Continuation review — October 11, 2026

The packaged patch was applied to `591f299d11f38a612629a274463196d57ae3862e`,
reproducing its recorded tree `76df4fd84f3963ec315247237b6d355c3b1dabc7`.
Fetching and rebasing onto upstream main retained that same base. Implementation
commit: `7bc2bb1a88fa1fb3e572915729b9a4ab8f540748`. All 29 upstream token
reservations remain intact; the three new allocations remain `3`, `4`, and `5`.

Checks used Windows, Node 24.19.0, npm 11.6.0 and Puppeteer's full Chrome for
Testing 152.0.7977.75. Dependencies were installed with the unchanged lockfile.
`npm run doctor`, production build, formatting and package-boundary checks,
`npm run layer-token:check -- --base-ref upstream/main`, and whitespace checks
passed. The build retains large-chunk warnings. The City browser gate passed
all 62 checks with no uncaught browser or Cesium errors; scenario request counts
were 18, 18, and 7 for normal use, a fresh share recipient, and failure/retry.

### Tracking comparison

`npm run test:track -- --headful` passed all 109 checks on the contribution.
The same command against an unchanged upstream checkout on port 4174 also
passed all 109 checks. Both runs had a clean console and no HTTP 5xx responses.
The recorded aircraft arrival failures did not reproduce: commercial and
military reveal both occurred on frame 4, with zero settle/reveal heading error
and no model handoff, in both checkouts. Aircraft runtime files and the tracking
harness are unchanged by this contribution; no assertion was weakened.

The prior headless-shell frames 5/6 remain historical observations. Both fleet
loops throttle at 80 ms while the harness budgets four rendered frames; at
60 fps that is about 67 ms. This supports timing sensitivity as a hypothesis,
without proving the sole cause of the original failures. Initial local attempts
encountered Vite's `504 Outdated Optimize Dep` startup response; a fresh Vite
dependency cache and a complete real-GPU run supplied the results above.
The interrupted software-rendering retry is not counted as a completed gate.

### Required unit gate remains non-green

`npm test` completed its main phase with 6,271 passed, 2 failed and 10 skipped.
Unchanged upstream reproduced the same two failures with 6,231 passed,
2 failed and 10 skipped:

- `src/codexOauthRealtime.test.mjs`: installed-executable resolution expected
  `\home\fixture\.local\bin\codex` but received `codex` on Windows.
- `src/pinokioLauncherContract.test.mjs`: fixture cleanup failed with Windows
  `ENOTEMPTY` while removing a temporary directory containing a junction.

These failures stop the runner before its allocation phases. Running those
two probes separately under Node 24 with `--expose-gc --test --test-concurrency=1`
passed 1 focus test and 13 overlay tests. This does not turn `npm test` green.
The PR must remain draft pending a complete green required unit gate or explicit
maintainer disposition of the reproduced upstream failures.

The unchanged dependency lockfile reports three audit findings: one low
(`dompurify`) and two high (`sharp`, `source-map-js`). Dependency remediation is
outside this source contribution and remains a separate review item.

### Refreshed live source and terms review

At 2026-10-11 05:28 UTC, the implemented adapter and normalizer again acquired
337 boundaries, 4,976 trail segments and 83 trailheads, with zero omitted
features, finite anchors and every accepted geometry equal to its source.
Source edit dates matched the table above; 353 trail segments still carried
`TrailSource='MPO'`. No feature payload was saved in the repository.
At 05:34 UTC, a live browser activation loaded the same three complete counts
without errors or partial/stale flags. Visual inspection over San Antonio
confirmed green park boundaries, amber trail geometry and cyan trailheads over
the normal satellite basemap, with no uncaught browser errors.

The public CKAN API returned all three current service references, blank named
license fields, and the original `dcat_issued` dates shown above. These are
distinct from CKAN's 2023 record-import dates. ArcGIS item notices retain GIS
warranty disclaimers and trail-use notices. The January 8, 2020 City terms were
reviewed, including departmental attribution, source/publication citation,
modification identification, and separate permission for non-City content.
This confirms the documented conditional source basis, not unconditional
redistribution rights. Maintainer review of the City terms and MPO provenance
remains open before merge.

## A separate next contribution

USGS water observations are the next independent source family to evaluate.
Use the modern Water Data OGC API, group readings by monitoring location, preserve
units/parameter codes and provisional status, and distinguish valid zero values
from missing readings. Keep that work on its own branch/PR. It can add public
domain streamflow, gage-height, rainfall and groundwater observations after
source validation without expanding this parks-and-trails patch.

## Current-main update — October 14, 2026

This City parks, trails and trailheads update merges upstream main `1d9d7c71d5c4c3cd222223ca35bc2088b52dcc41` into the existing
published draft, preserving its implementation commits and separate scope.
The initial changelog and formatting-scope conflicts retain both contributions
and current upstream entries. A later upstream refresh also retains the Director
dateline and portable Chrome changes. Runtime revision validated:
`821b40b4c31f61ddbd90840e92efdf19b89b2ae6`. The final documentation commit adds this record only.

Required checks passed on the actual updated tree: doctor JSON, format/check
(1351 adopted files), boundaries, whitespace, immutable
token checking, full unit runner and production build. The full unit runner
reported **6552 main passes / 0 failures / 1 skip**, followed by
**1 focus allocation pass and 13 overlay allocation passes** (6566
passes total). The skip is the Windows-native DACL test on Linux. Build warnings
about large chunks remain. The City gate passed all 62
checks; tracking passed **109/0/0**, with clean console and HTTP 5xx ledger.
Built-preview inspection passed 13 checks, including picks,
source credits, activation/disable cleanup and a fresh share recipient.

Execution used WSL2 Ubuntu, Node 24.19.0, locked `npm ci` with npm 10.9.3,
and full Chrome for Testing 152.0.7977.75. Bubblewrap isolated mount, PID, user
and network namespaces, without host credentials or home directories. Browser
and server egress used an exact-host HTTPS allowlist; Chrome retained its own
namespace/seccomp sandbox. The actual renderer was ANGLE Vulkan SwiftShader
software. A restricted WSL hardware attempt could not create WebGL2, so hardware
performance remains unverified. Tracking's official `--offline-imagery` option
fixtures tile images while required fonts, metadata and terrain remain real.

PR #997 is now merged (`91ac5c119084fdb200362b2c6dd07cb2324fb081`). Fresh
native Windows 11 Pro build 22621, Node 24.19.0, `process.platform=win32`
verification of current main's exact `codexOauthRealtime.test.mjs` file passed
**8/8**. The prior Codex fixture failure is resolved; earlier Windows/Pinokio
and tracking records above remain historical. A complete native Windows suite
is not claimed by the Linux review. The prepared revision has not been pushed,
so it has no new GitHub CI result. The original draft's CI remains
`action_required`; local passes do not clear required CI or maintainer review.

Current main still has 29 permanent reservations. The allocation helper
retains provisional City tokens `3/4/5`, preserving every published/retired
assignment. USGS draft #1072 remains separate. The local combined candidate
proposes City first, then USGS `6`; approve an integration order and refresh
the permanent ledger before either source's final merge.

Fresh adapter reads returned 337 boundaries, 4,976 trail segments and 83
trailheads, with zero omissions and unchanged accepted geometry. 353 trail
segments retain MPO provenance. This is availability/schema evidence, not
permission. The prior conditional City terms, blank named-license records and
MPO/third-party provenance questions remain unresolved for maintainer disposition.

Fresh audits of candidate and the unchanged baseline lockfile remain identical:
one low (dompurify) and two high (sharp, source-map-js). No dependency change is
included. Review records retain the initial marker gate failure, the superseded
main runs, one interrupted tracking navigation during checkout refresh, and the
review proxy's rejected-socket EPIPE crash. That helper was fixed without widening
its allowlist, and affected completed gates were rerun. Those earlier attempts
are not counted as completed passing gates.

Keep the draft status. Source-rights disposition, applicable hardware evidence,
successful CI, maintainer acceptance and refreshed merge-time token allocation
remain conditions before merge. No force push, approval review or merge was performed.

## Final frozen-baseline refresh — October 14, 2026

Upstream advanced again during this review. The final frozen review baseline is
`81cf437ee52b3a0e57b8cfa652ccb287a86395e6`, which adds weather-missing-observation and Unicode
tool-string validation fixes. Contribution policies, CI, the dependency lockfile
and all 29 permanent share-token reservations are unchanged. This update merges
that baseline without rewriting the original draft or mixing source families.
The final tested runtime is `8821e83418388e1e20ff2ece9df5514568dffaeb`.

The refreshed full unit runner passed **6556 main / 1 focus / 13 overlay
checks, 0 failures, 1 Windows-only skip** (6570 passes total). Doctor,
format/check, boundaries, token checking, whitespace and production build passed.
The applicable feature gate passed 62 checks, tracking
passed **109/0/0**, and built-preview inspection passed 13 checks,
including share restoration. The records above describe the earlier completed
baseline and remain historical evidence rather than substituted final results.

One parallel browser attempt ended when WSL unexpectedly stopped. Its partial
logs are retained; the stopped instance restarted without a service shutdown or
stopping unrelated jobs, and final browser checks completed sequentially on the
same frozen runtime. This is a review-environment interruption, not a completed
passing gate or an attributed application regression. No assertions were waived.

The source-rights, audit, CI, native-Windows/full-suite and hardware-performance
limitations above remain. Prepared changes stay local and drafts stay drafts.
Refresh main and the permanent ledger again before an actual merge; published
tokens remain immutable. The final commit changes documentation only.

## Publication refresh — October 14, 2026

The publication candidate merges upstream `7661cd349c935077994e01c794e9cd6faae06117` without
rewriting published contributor commits. Intervening changes correct route-cap
reporting, duplicate Street Level tiles, missing imagery-box edges and warm
terrain batch-cache eviction. The
contribution policies, CI, dependency lockfile and permanent token ledger are
unchanged. No San Antonio production implementation changed in this refresh.

The earlier validation sections remain tied to their stated revisions. Fresh
publication validation records exact commands and candidate revisions separately;
earlier results are not substituted for checks of this refreshed candidate.
Source-rights questions, dependency findings and hardware-performance limitations
remain open. Publication keeps this PR draft and does not approve a merge.

City retains provisional parks/trails/trailheads tokens `3/4/5`. The proposed
order remains City first, then refresh the independent USGS draft against the
resulting main and permanent ledger.
