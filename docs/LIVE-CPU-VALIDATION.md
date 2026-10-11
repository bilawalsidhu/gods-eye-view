# CPU during live aircraft and vessel use

This is the historical run before the browser changes. Newer measurements and
their workload-comparison limits are in [browser CPU validation](BROWSER-CPU-VALIDATION.md).

REAL local validation on 2026-10-11, approximately 04:17:47–04:19:18 UTC.
Apple M4, 10 logical CPUs, macOS, Node 24.19.0 and headed Chrome for Testing
152.0.7977.75. This measures CPU time, not electrical power or battery discharge.

## Workload and method

Battery saver remained selected throughout: target 20 fps, render scale 0.75,
one MSAA sample and overlay DPR limit 1. Both Live Flights and Live Vessels were
enabled. Real Esri imagery and the application's normal live data routes were
used, with no request interception, synthetic contacts or forced render holds.
The natural continuous-render owners were `flights` and `ais-vessels`.

The camera remained stationary over Italy, 42.4 N / 12.25 E, at 1,050 km with a
vertical view. The CSS viewport was 1280 × 800 at device DPR 2; the Cesium
render buffer was 960 × 600. The geographic viewport covered approximately
38.59–45.68 N and 4.12–20.38 E. Camera position, layer health and Battery saver
were checked at every sample boundary. The scene warmed for 30 seconds; the
camera was reasserted after the startup flight, followed by five seconds to
settle. Three consecutive 30-second samples then ran, with no builds or unit
tests running alongside them.

CPU is the difference in cumulative macOS process CPU time divided by elapsed
wall time. Browser figures sum the dedicated browser and its child processes,
including renderer and helper processes. Node is the existing local server's
listening PID. A process disappearing during a sample fails the measurement.
The dedicated browser excludes unrelated user tabs from the browser CPU total.
The user's normal app tab remained open against the same backend, so Node
includes any requests from that tab too. Other host applications were not
stopped, and whole-machine CPU was not measured.

## Results

| Sample             | Browser CPU |  Node CPU | Rendered fps |
| ------------------ | ----------: | --------: | -----------: |
| 1                  |      96.07% |     2.33% |        20.01 |
| 2                  |      72.76% |     1.90% |        20.05 |
| 3                  |      85.89% |     2.66% |        20.02 |
| Time-weighted mean |  **84.91%** | **2.29%** |    **20.03** |

Combined mean: **87.20% of one logical CPU**, approximately 0.87 core-equivalents.
Here **100% means one fully occupied core**, matching macOS process CPU reporting.
It does not mean 87% of the entire M4. Dividing by ten gives 8.72% of the summed
logical-CPU time capacity, but M4 efficiency/performance cores are unequal, so
that is not a physical throughput or power estimate.

The dominant remaining cost is in the browser. The app maintains approximately
20 fps with both motion layers active, but this workload still uses most of one
core in total. These results describe the final live workload; they are not a
matched before/after optimization comparison and cannot be directly compared
with the controlled, layer-free rendering test in `qa-power-budget.mjs`.

## Live-data evidence

The browser held approximately 5,340 aircraft records and 12,000 vessels;
200–211 aircraft and 471–497 vessel observations fell within the geographic
viewport at sample boundaries. These are geographic membership counts, not a
guarantee that every contact has an unobstructed, labeled screen marker.

Flights used a real OpenSky snapshot initially. Normal 30-second polls returned
that cached snapshot as its source age rose from 25 to 115 seconds; it was not a
new position observation on every poll. During the final sample the normal
provider fallback supplied 146 fresh adsb.lol aircraft rows, labeled **250nm
regional fallback**, with a source snapshot age of 379 ms. The app retains its
existing worldwide aircraft records while refreshing the regional contacts.
That response updated coordinates for 135 contacts shared with the preceding
source response; 124 aircraft shared between the final sample's geographic
viewport snapshots changed raw latitude/longitude. This comparison uses source
observations rather than interpolated display positions.

AISStream remained `live`. During the CPU sampling window two vessel
responses arrived, with last-message ages of 104–117 ms. Consecutive responses
changed coordinates for 1,116 and 2,287 retained vessels. In the geographic
viewport, 32 vessels changed raw position during sample 1 and 53 during sample 3;
these counts can overlap and are not added as unique vessels. Sample 2 had no
new vessel snapshot. The configured periodic vessel interval remains 60 seconds;
the application can also refresh after camera changes and visibility restoration.
No polling interval was shortened for this test.

## Reproduction and artifacts

With the local dev server running, execute:

```sh
node scripts/qa-live-cpu.mjs
```

`QA_BASE_URL` can select a different local origin. The harness opens and then
closes its own headed browser. It fails if either layer has no observations in
the measured geographic viewport, if profile/visibility/health changes, or if
actual source position updates from both feeds do not arrive during the sample
window. It writes only aggregate feed evidence, counts and process CPU data;
contact lists, API keys and environment values are not exported.

Local ignored artifacts:

- `output/playwright/live-cpu.json`: CPU samples, profile/camera/layer state and
  aggregate feed response evidence.
- `output/playwright/live-cpu-benchmark.png`: measured Italy scene.
- `output/playwright/live-cpu-user-app.png`: user app with both layers and Battery
  saver selected.
- `output/playwright/live-cpu.log`: completion and sample summaries.

A preliminary attempt was excluded: the startup flight had moved the camera
away from the intended contacts and screenshot export also used an escaped URL
path. The completed run above verifies the actual camera and geographic contacts
and saves the screenshot using a decoded filesystem path. A nonessential AIS
report-timestamp comparison initially used the wrong field; its result is marked
unavailable in the saved report, and the observer now uses the production field.
The raw coordinate comparisons and CPU measurements were unaffected.

This task adds measurement tooling and documentation; it does not change the
application's rendering or data behavior. The result was measured locally; no production deployment is claimed.
The headed live harness completed successfully. Report assertions verified all
three camera/profile/health windows and actual coordinate updates from both
feeds. Script syntax, repository formatting and import/package boundary checks
passed; no application changes required a new build or unit-suite run.
