# San Antonio-area USGS water observations

`san-antonio-usgs-water` is one site-grouped layer of latest USGS observations
inside `bbox=-98.85,29.05,-98.08,29.85`. This rectangle includes neighboring
counties and does not establish complete coverage of San Antonio or Bexar County.
It is independent of the City parks/trails contribution.

## Use

Enable **Data Layers > San Antonio > San Antonio USGS Water**, then click a
station. Blue markers have at least one numeric reading; gray markers have
timestamped observations without numeric values. Colors describe availability,
not danger. Both classes retain station markers and source provenance.

The selected card shows one series at a time. **Reading** controls step through
every series, including two series for the same parameter. Cards show original
numeric text, source units, measurement time in UTC, approval status, qualifiers,
parameter/statistic codes, computation, sublocation, series identity, and a
separate retrieval time. Clicking the card opens the official station page.

**Area** selects the entire rectangle; **Bexar** selects stations with
`state_code='48'` and `county_code='029'`. Neighboring counties retain their own
names. Filters and reading selection are local session controls. Share links
preserve layer visibility and initially show the entire rectangle. **Refresh**
requests another complete snapshot when the source's retry hold permits it.

## Meaning and limits

- Zero and negative readings are valid. Null, blank, textual and nonfinite values
  are not converted to zero. The original source value text remains in records.
- Freshness uses observation `time`; `last_modified` describes database updates.
  A recent database update cannot revive a measurement outside the query window.
- Gage height is not necessarily river depth. Groundwater parameter `72019` is
  depth below land surface. Neither measurement sets a marker's map altitude.
- Parameter `00045` is precipitation, total. Selecting observations within a
  24-hour window does not establish a 24-hour rainfall total.
- USGS provisional observations can be revised. The layer does not classify
  flooding, risk, closures or safe travel. Historical charts are outside its scope.

## Acquisition contract

The standalone keyless adapter uses the current Water Data OGC v1 collections:

- [`latest-continuous`](https://api.waterdata.usgs.gov/ogcapi/v1/collections/latest-continuous/items):
  `f=json`, the fixed rectangle, a dynamic UTC `datetime=<now minus 24 hours>/..`,
  and an explicit bounded limit.
- [`monitoring-locations`](https://api.waterdata.usgs.gov/ogcapi/v1/collections/monitoring-locations/items):
  batched `filter-lang=cql2-text` queries on `id IN (...)`.
- [`time-series-metadata`](https://api.waterdata.usgs.gov/ogcapi/v1/collections/time-series-metadata/items):
  batched `id IN (...)` queries for only the observation series.

The source joins observation `monitoring_location_id` to station `id`, and
`time_series_id` to series `id`, checking station, parameter and statistic
consistency. Missing metadata or conflicting duplicates reject the acquisition.
Same-parameter series remain separate. Null-only stations remain represented.
Station coordinates determine positions; observation values and metadata
altitudes do not. Only approved public fields leave the source.

Pagination follows same-origin, same-collection `rel=next` links with unchanged
query scope. Repeated/ambiguous links, stalled pages, changed limits, malformed
pages, conflicting identities, and mismatched `numberReturned` are errors.
`numberMatched` is optional; when supplied it must match the completed distinct
record count. With an absent count, completeness depends on the provider's
pagination links and completed metadata joins, not a fabricated expected count.

Default ceilings: 500 rows per page, 50 identifiers per metadata batch, 2,000
observations, 256 locations, 2,000 series, 64 total requests/pages, 8 MiB per
response, 32 MiB total, and a 60-second whole-acquisition deadline. Consumers
can lower these limits, not raise them. At most 64 readings can be displayed
at one station; exceeding that bound reports an error instead of truncating.

Observation snapshots use a 15-minute memory cache. Metadata uses bounded
per-identifier memory caches with a 24-hour TTL. Returned snapshots are
defensive copies. Only complete successful acquisitions publish caches.
Failure does not serve expired source data as fresh. An enabled layer keeps
its prior display with a stale/error indication after a failed refresh.

HTTP 429 recognizes delta-seconds and HTTP-date `Retry-After`, with a maximum
one-day hold. Other failures back off from five seconds to five minutes. Calls
during a hold make no provider requests; there is no unbounded retry loop.
Caller cancellation does not impose failure backoff. Deadlines include fetch
and body reads even for injected implementations that ignore AbortSignal.

This adapter supports keyless access. It does not accept or embed operator API
keys. A future authenticated adapter must keep private keys server-side and use
`X-Api-Key`, never a browser key or query-string credential.

## Ownership

`src/layers/usgsWater/` owns configuration, bounded acquisition, plain grouped
records, marker rendering and lifecycle/selection. Package consumers can import
`gods-eye-view/layers/usgs-water` and `gods-eye-view/layers/usgs-water/source`
independently. `sources['usgs-water']` supplies `getSnapshot({signal, force})` to
the catalog. A null source makes the layer unavailable before acquisition.
Construction does not fetch. Disable aborts work and removes owned data sources,
entities, click handlers and cards. Late asynchronous insertion is compensated.

Selected text uses the shared world overlay; no Cesium text labels are added.
Renderer/source state belongs to factory instances rather than global services.

## Source rights and attribution

Credit **U.S. Geological Survey** and link the source and the
[provisional-data statement](https://waterdata.usgs.gov/provisional-data-statement/).
[USGS copyrights and credits](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits)
states that USGS-authored data and information are in the U.S. public domain;
third-party materials can retain their rights. Acquisition is restricted to
USGS station identities and `agency_code='USGS'`. This contribution does not
copy logos, third-party imagery or other copyrighted materials from USGS pages.
The repository's MIT code license is separate from source-data rights.
See [DATA_SOURCES.md](../DATA_SOURCES.md#san-antonio-area-usgs-water) for credit.

## Share token coordination

Reviewed upstream `7661cd349c935077994e01c794e9cd6faae06117` assigns the next
available token `3` to this layer. This allocation is provisional until merge.
The separate City PR also proposes `3`, `4`, and `5`. If that PR merges first,
remove only this contribution's unpublished registry/ledger entry and run
`npm run layer-token:next -- san-antonio-usgs-water` against refreshed main;
it should then allocate the next free token. Never change a published City
token or reserve unused tokens to skip the allocation order.

## Verification

The tests use invented observations and locations. The browser gate intercepts
only the three official OGC collections while exercising the real catalog,
controls, renderer, map picking, cards, share restoration, cache and 429 recovery.
A separate bounded live check records counts and join completeness without
committing downloaded observation payloads.

```sh
npm ci
npm run doctor
npm run build
npm test
npm run format:check
npm run check:boundaries
npm run layer-token:check -- --base-ref upstream/main
# With npm run dev on localhost:4173:
npm run test:track -- --headful
node scripts/qa-usgs-water.mjs --headful
node scripts/qa-usgs-water-live.mjs
```

Current v1 schemas were fetched directly. Actual October 11 research confirmed
that qualifiers can be lists (`EQUIP`, `UNAVAIL`) as well as null/text, despite
the schema's string declaration; the implementation preserves those lists.
Reference docs: [CQL queries](https://api.waterdata.usgs.gov/docs/ogcapi/complex-queries/),
[efficiency](https://api.waterdata.usgs.gov/docs/ogcapi/efficiency/),
[keys](https://api.waterdata.usgs.gov/docs/ogcapi/keys/), and
[migration](https://api.waterdata.usgs.gov/docs/ogcapi/migration/).

## Contribution validation — October 11, 2026 (America/Chicago)

Reviewed against upstream `591f299d11f38a612629a274463196d57ae3862e` using
Windows, Node 24.19.0, npm 11.6.0 and full Chrome for Testing 152.0.7977.75.
The dependency lockfile is unchanged.

- `npm ci`, `npm run doctor`, `npm run build`, `npm run format`,
  `npm run format:check` (1,320 adopted/runtime files), package boundaries,
  token checks against `upstream/main`, and whitespace checks passed.
- The focused browser gate passed 38 checks, including actual drawing/picking,
  cards, units/time/status, qualifier text, safe provider text, local filtering,
  cleanup, cache reuse, fresh share restoration and 429/retry behavior. Each
  scenario had no uncaught page or Cesium render errors.
- The final `npm test` main phase reported **6,262 passed, 1 failed, 10 skipped**.
  The remaining failure is Windows installed-executable resolution in
  `src/codexOauthRealtime.test.mjs`: expected `\home\fixture\.local\bin\codex`,
  received `codex`. A fresh targeted run on unchanged upstream reproduced it.
  Earlier Windows Pinokio fixture cleanup also failed, but passed in the final
  full run. No onboarding test was changed or skipped to accommodate this layer.
- Because a failing main phase prevents allocation phases from running, the
  Node 24 GC-bracketed allocation probes were run separately: **14 passed**.
  That does not make the full required `npm test` command green.
- Final tracking rerun: **109 passed, 0 failed, 0 skipped**, with clean console
  and HTTP 5xx checks. Unchanged upstream also passed 109/0/0. The first
  contribution run had 107 passes and two M3 camera age-out failures: altitude
  delta 295.46 km and horizontal delta 392.01 km against 2 km budgets. Those
  failures did not reproduce in the unchanged-upstream comparison or clean
  contribution rerun (both deltas 0.00 km). Their cause remains unproven;
  aircraft/camera runtime files and the tracking harness are unchanged, and the
  USGS layer stayed disabled throughout those tracking runs. Both reveal-timing
  checks passed at frame 4 with zero heading error in all three runs.

The bounded live gate at **2026-10-12 04:26 UTC** (October 11 local time) recorded:

| Scope | Locations | Series/readings | Numeric readings | Numeric locations | No numeric locations |
| --- | ---: | ---: | ---: | ---: | ---: |
| San Antonio-area rectangle | 45 | 141 | 136 | 43 | 2 |
| Bexar subset of that rectangle | 30 | 103 | 98 | 28 | 2 |

All **45/45 station identities** and **141/141 series identities** joined.
No observations were excluded for being outside the query window. All returned
observations were Provisional. The Bexar subset contained 25 stream sites and
five wells across 11 parameters. These are timestamped observations, not pinned
correctness assertions or guarantees of current coverage. The script saved
only aggregate evidence under ignored `qa-shots/usgs-water/`.

Keep the PR draft pending a green required unit gate or maintainer disposition
of the reproduced upstream failure. Tracking intermittency and merge-time token
reallocation also remain explicit review items. The unchanged lockfile reported
three existing audit findings (one low, two high); no dependency remediation is
included in this source contribution.

## Current-main update — October 14, 2026

This USGS water update merges upstream main `1d9d7c71d5c4c3cd222223ca35bc2088b52dcc41` into the existing
published draft, preserving its implementation commits and separate scope.
The initial changelog and formatting-scope conflicts retain both contributions
and current upstream entries. A later upstream refresh also retains the Director
dateline and portable Chrome changes. Runtime revision validated:
`55d39aeee3852f9b15aacf8aa424cba94c215a93`. The final documentation commit adds this record only.

Required checks passed on the actual updated tree: doctor JSON, format/check
(1353 adopted files), boundaries, whitespace, immutable
token checking, full unit runner and production build. The full unit runner
reported **6542 main passes / 0 failures / 1 skip**, followed by
**1 focus allocation pass and 13 overlay allocation passes** (6556
passes total). The skip is the Windows-native DACL test on Linux. Build warnings
about large chunks remain. The USGS gate passed all 38
checks; tracking passed **109/0/0**, with clean console and HTTP 5xx ledger.
Built-preview inspection passed 15 checks, including picks,
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

The initial browser gate failed with 4 passing checks and an absent GPU pick
on its fifth assertion, in both standalone and combined updates. An isolated
probe found the clamped markers became pickable after about 2.2 and 1.3 seconds;
all original 38 assertions then passed. The reviewed gate now waits up to 30
seconds for the same observable pick before performing its original assertion
and click/selection checks. No production renderer or assertion was weakened.

Against current main alone, the allocation helper retains provisional USGS
token `3`, preserving all 29 permanent assignments. City draft #1002 also
provisionally uses `3`; these are alternatives until an integration order is
chosen. The local City-first combined candidate uses USGS `6`. If City merges
first, merge that refreshed main and reallocate USGS rather than publishing an
ambiguous token or consuming unreserved digits out of order.

Fresh live validation returned 45 locations and 141 readings, 136 numeric,
with complete station/series joins; Bexar contained 30 locations and 103 readings.
USGS credit, provisional-data cautions and third-party-rights caveats remain
explicit. Current availability does not change those terms or prove complete coverage.

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
The final tested runtime is `4288710d24bc85f78c9231875c6b2c97c19c462e`.

The refreshed full unit runner passed **6546 main / 1 focus / 13 overlay
checks, 0 failures, 1 Windows-only skip** (6560 passes total). Doctor,
format/check, boundaries, token checking, whitespace and production build passed.
The applicable feature gate passed 38 checks, tracking
passed **109/0/0**, and built-preview inspection passed 15 checks,
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

Standalone USGS retains provisional token `3` against this main. If City merges
first, refresh main and allocate the next valid token using the real helper;
`6` is only the current local City-first integration proposal. Never alter a
published or retired reservation.
