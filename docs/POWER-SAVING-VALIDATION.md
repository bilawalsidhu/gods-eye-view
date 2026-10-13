# Power saving — local validation

Validated on macOS, 2026-10-11, with Node 24.19.0.

## Behavior

Display → Performance offers Battery saver (default), Balanced and High quality.
The preference persists locally. Profiles affect rendering, not the selected
layers, source data, tracking, or Area insights scoring.

| Profile | Frame-rate ceiling | Render resolution scale | MSAA samples | Overlay DPR ceiling |
| --- | ---: | ---: | ---: | ---: |
| Battery saver | 20 | 0.75 | 1 | 1 |
| Balanced | 30 | 0.9 | 2 | 1.5 |
| High quality | 60 | 1 | 4 | Device DPR |

The existing render governor still stops drawing idle scenes. A hidden standalone
tab stops the Cesium render loop and automatic layer polling. Returning to it
restores rendering and requests a normal guarded refresh of enabled polling
layers. Explicit refreshes remain available. HUD timer callbacks skip work while
hidden or disabled. Push streams and server-side AIS ingestion retain their
existing ownership and recovery behavior.

## Reproducible measurements

Run with the local Vite server on port 4173:

```sh
node scripts/qa-power-budget.mjs
node scripts/qa-power-budget.mjs --cpu
```

The automated harness owns a separate Chrome for Testing process, uses an
800 × 600 viewport with device DPR 2, a fixed overhead camera and bundled Cesium
imagery. Data layers are disabled, and a render-governor hold keeps drawing active
to compare the same continuous-render workload. Metal is enabled on macOS.
This isolates rendering changes from differences in remote data, tiles or user
activity. It does not represent every layer combination or a dense city scene.

The ordinary comparison counts rendered frames and canvas pixel samples. It also
checks that releasing the hold returns the governor to idle, then verifies actual
background/foreground transitions in the browser. Pixel samples exclude MSAA and
other shader work; they are a workload proxy, not GPU occupancy or energy.

CPU mode alternates profiles across three 15-second samples per profile, after
2.5 seconds of warm-up. It reads cumulative macOS CPU time using `ps`, including
the dedicated browser and all its descendant processes, and measures the local
Vite server separately. CPU percentage is elapsed process CPU seconds divided by
wall seconds × 100: **100% means one fully occupied core**, and a process tree
can exceed 100%. GPU helper process CPU is included; GPU hardware occupancy is
not measured. Unrelated Chrome tabs and apps are excluded from the reported tree.

Raw measurements are saved locally in ignored `output/playwright/power-*.json`
and test logs alongside them. No passwords, environment values or process command
arguments are captured in the reports.

## Measured results

These measurements precede the Node AIS cache optimization. See
[Node CPU validation](NODE-CPU-VALIDATION.md) for its subsequent controlled and
live measurements, including observed browser variation.

Three samples per profile, with other repository test/build processes stopped
for the CPU comparison. The host has 10 logical processors. Percentages below
remain on the one-core scale, not normalized to the whole machine.

| Measurement | High quality | Battery saver |
| --- | ---: | ---: |
| Browser process tree CPU, mean | 68.35% | 30.26% |
| Browser CPU, sample range | 56.59–89.60% | 23.60–38.59% |
| Local Vite server CPU, mean | 26.93% | 26.06% |
| Sum of browser and server means | 95.28% | 56.33% |
| Measured frame rate, mean | 60.57 fps | 20.15 fps |
| Canvas backing size | 800 × 600 | 600 × 450 |

Browser CPU fell approximately **55.7%**; browser plus server approximately
**40.9%**. The server difference is small relative to sample variation and is
not evidence of a server optimization. Existing backend ingestion continues.
Rendered pixel samples per unit time fell approximately **81.3%**. No assertion
requires a fixed CPU reduction, because host scheduling and other applications
affect measurements; the browser regression requires reduced frame/pixel work.

The ordinary browser comparison passed the frame/pixel reduction gate,
idle-governor check and actual hidden-tab suspension/foreground restoration.
The live UI was also switched between High quality and Battery saver, then left
on Battery saver. Screenshot: `output/playwright/power-saving-live.png`.

## Checks

- Focused power-profile, polling and render-governor tests: 11 passed.
- Tracking/3D/ground-motion browser regression: 109 passed, none failed/skipped.
- Production build, formatting check, import and package boundaries: passed.
- Complete ordinary unit suite, unchanged tests with concurrency limited to 4:
  6,259 passed, zero failures, one existing skip (6,260 total).
- Both serialized allocation suites under Node 24: 14 passed, zero failures.
- One parallel suite run exceeded the existing 250k-row ranking time limit by
  3 ms while the graphical regression was also running. The unchanged focused
  ranking suite passed all 43 tests when repeated. In the complete final run,
  the ranking test passed in 104 ms. A restricted-sandbox attempt could not open
  localhost test servers and was stopped; the final run used the required local
  server permissions. No tests were changed or disabled to obtain the result.

## Limits

No battery discharge, watts, hardware GPU occupancy or thermal benchmark was
performed. Rendering-work and CPU reductions must not be described as equal
battery-life improvements. Network traffic, active video, weather, 3D tiles,
live-data ingestion and other applications can dominate actual power use.
This is a local change, not a production deployment.
