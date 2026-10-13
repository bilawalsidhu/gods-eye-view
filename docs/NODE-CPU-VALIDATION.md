# Node server CPU — local optimization and validation

Local macOS validation on 2026-10-11, Node 24.19.0. CPU percentages use the
one-core scale: 100% means one fully occupied core, not the whole machine.

## Finding and changes

The worldwide AIS position handler scanned the complete vessel cache and all
pending track fixes for every incoming position. Once the 50,000-vessel limit
was reached, it also sorted the complete cache for every new MMSI. In the
controlled replay, V8 CPU profiling attributed approximately 81.8% of active
samples to `pruneAisStreamCache`.

The server now sweeps expired entries in batches, at most once every 30 seconds
while ingesting positions. Snapshots still filter against the exact 30-minute
cutoff, and track reads also refuse expired vessels even before physical cleanup.
With active traffic, expired retained objects can remain in memory for up to
30 extra seconds; an idle feed does not run a new cleanup timer. The vessel map
remains hard-bounded to 50,000 entries after every insertion.

Receipt recency is maintained in Map insertion order, so capacity overflow
evicts the oldest received vessel and releases its track in constant time rather
than sorting 50,000 entries. AIS report times still determine track sample times
and thinning. Each message's timestamp is parsed once for both its row and track.
The websocket decoder is reused and reads zero-copy byte views rather than
copying each Buffer's backing storage.

The subscription, worldwide coverage, message types, snapshots, live refresh,
single upstream connection and watchdog/backoff policy are preserved. Neither
an upstream filter nor a slower live update interval produces the CPU reduction.

## Measurements

Two complementary measurements are used:

1. **SIMULATED, controlled AIS replay**: separate Node processes ingest 30,000
   synthetic vessels, then decode and ingest exactly 500 messages/second over
   three 15-second samples. The pre-change source was saved locally with only
   its relative import path adapted. Both versions use the same fixture, report
   age, rate, sample count and V8 profiler. CPU time comes from
   `process.cpuUsage()`, divided by measured wall time. Profiling uses an
   in-process inspector session; no debugging network listener is opened.
2. **REAL, live local server and browser**: the existing
   `scripts/qa-power-budget.mjs --cpu` comparison measures cumulative macOS
   process CPU time. Its browser workload is the same controlled rendering
   scene as the previous power-saving validation; its Node server continues
   receiving real worldwide AISStream traffic. Three 15-second samples per
   rendering profile are used, with other repository build/test processes
   stopped during measurement. Real upstream traffic naturally varies.

Commands:

```sh
node scripts/qa-ais-store-cpu.mjs --profile
node scripts/qa-power-budget.mjs --cpu
```

The comparison to the preserved original source can be repeated with
`node scripts/qa-ais-store-cpu.mjs --baseline --profile` while the ignored
baseline copies in `output/playwright/` remain available. The script requires
no API key, network connection or live AIS records. Generated reports and CPU
profiles stay in ignored output, with no credentials or environment values.

## Controlled replay results

| AIS decode/cache replay | Before | After |
| --- | ---: | ---: |
| Mean process CPU | 23.24% | 5.10% |
| Individual 15-second samples | 25.26%, 21.78%, 22.69% | 4.84%, 5.25%, 5.21% |
| Messages processed per sample | 7,500 | 7,500 |
| Current vessels retained | 30,000 | 30,000 |

CPU fell **78.1%** at the matched replay rate and cache population. The pruning
function fell from 81.8% to 1.3% of non-idle V8 samples. These sampling shares
identify the removed hotspot; they are not separate OS CPU percentages.

## Checks

Focused store, AIS sentinels, websocket decoder/adapter and watchdog tests:
97 passed. Added cases cover exact snapshot/track expiration without incoming
traffic, overflow beyond 50,000 records, refresh recency, track eviction and
reappearance, static metadata, out-of-order AIS report times, consistent
timestamp fallback, offset byte views, incomplete UTF-8 reset and detached
buffers. Existing transport failure, oversized frame, liveness and backoff
checks remain intact.

Build, formatting and import/package boundary checks passed. The complete
ordinary unit suite passed with concurrency limited to 4: 6,264 passed, no
failures, one existing skip (6,265 total). Both serialized Node 24 allocation
suites also passed all 14 checks.

## Live server results

The final live run used a clean Vite restart with `--force`, after a config
reload left stale optimized modules and the browser stuck during initialization.
That failed startup attempt was excluded from measurements. The live app and
automated rendering comparison both initialized successfully after the restart.

| Live CPU, three 15-second samples per rendering profile | Before | After |
| --- | ---: | ---: |
| Node server, High quality samples mean | 17.40% | 1.44% |
| Node server, Battery saver samples mean | 18.95% | 2.02% |
| Node server, all six samples mean | 18.18% | 1.73% |
| Browser tree, High quality samples mean | 46.11% | 63.08% |
| Browser tree, Battery saver samples mean | 26.26% | 38.69% |

The observed live Node reduction is 90.5%, but it is not the matched-workload
claim: the pre-change cache contained approximately 32,539 vessels, whereas
the post-restart cache was still warming and contained 16,828 at the end of the
measurement. Upstream rates vary too. Use the controlled replay's **78.1%**
reduction as the evidence at identical cache size and incoming rate. Browser
CPU was higher in this live run; this change does not establish an additional
browser CPU reduction or a fixed whole-app reduction. Rendering frame/pixel,
idle and background suspension regression gates still passed.

The real feed remained `live` in four 15-second-spaced observations overlapping
the CPU run; latest-message age was 42–129 ms. A separate pair of real snapshots
10 seconds apart retained all 18,276 common vessels and showed 677 changed
positions and 877 changed report times. Worldwide ingestion was not disabled
to obtain the CPU result.

Raw evidence: `output/playwright/ais-cpu-before.json`, `ais-cpu-after.json`,
`ais-before.cpuprofile`, `ais-after.cpuprofile`, `node-live-before.json`,
`node-live-after.json`, `node-live-cpu-summary.json`, `node-feed-during-cpu.json`,
`node-live-updates.json`, and `node-unit.log`. Reports stay local and ignored.

## Limits

CPU reductions are not battery discharge or watt measurements. The controlled
replay isolates AIS decode/cache cost and omits TLS, websocket decompression,
Vite and other providers. The live comparison includes those costs but has a
changing upstream message rate and cache population; its before/after result is
an observation, not a fixed-load causal benchmark. This is a local change and
has not been published or deployed.
