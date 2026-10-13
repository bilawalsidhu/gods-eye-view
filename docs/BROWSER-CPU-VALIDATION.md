# Browser CPU optimization and live validation

Local validation on 2026-10-11, Apple M4 (10 logical CPUs), Node 24.19.0,
headed Chrome for Testing 152.0.7977.75. CPU figures use cumulative process time;
100% means one occupied logical CPU, not the whole M4 or battery power.

## Changes

- Flight extrapolation caches each received fix's east/north/up transformation
  in a WeakMap. Old fixes remain collectable. An in-place position change,
  including ground-floor correction, invalidates the cached axes. Arc motion,
  interpolation, coast limits, positions and course math remain unchanged.
- The fleet samples its delayed clock once per tick in a dedicated scratch
  JulianDate, passing that identical timestamp to every aircraft. On-demand
  tracked/cockpit motion retains its own clock. The 80 ms fleet gate remains.
- Flight billboards use one translucent render pass. Existing transparent
  silhouettes, fading and depth-free rendering retain the normal sprite order.
  The live scene's command list confirms one flight billboard command.
- Vessel detection candidates reuse per-record objects, update metadata in
  place, and walk the selected stride directly. Tests preserve sample membership
  and order, including negative seeds, and cover changed speed/type/position.

Battery saver still targets 20 fps, render scale 0.75, one MSAA sample and overlay
DPR at most 1. Flight polling remains 30 seconds and vessel polling 60 seconds.
The new optional flight filters are clear during the CPU runs: all loaded live
aircraft remain eligible. Nothing in this optimization reduces contact coverage
or update frequency.

## Final measurement with flight controls present

The final REAL run completed at 04:58:10 UTC, with Battery saver, both live
layers, clear flight filters and the same Italy camera/viewport described below.
No profiler, builds or tests ran during the CPU samples. Hardware rendering
remained ANGLE Metal / Apple M4. The scene command list contained one flight
billboard command in every sample.

| Sample             | Browser CPU |  Node CPU |       fps |
| ------------------ | ----------: | --------: | --------: |
| 1                  |      45.72% |     2.13% |     20.05 |
| 2                  |      51.61% |     1.56% |     20.01 |
| 3                  |      47.69% |     1.30% |     20.01 |
| Time-weighted mean |  **48.34%** | **1.66%** | **20.02** |

Combined mean: **50.00% of one logical CPU**, about 0.50 core-equivalents. Browser
range 45.72–51.61%; Node range 1.30–2.13%. This is the current measured workload,
not proof of a particular percentage CPU reduction.

Aircraft started at 5,467 loaded records with 317 in the geographic viewport.
Regional fallback refreshed contacts as the normal retention policy aged out
absent worldwide records; the run ended at 243 loaded / 209 in the viewport.
Vessels remained at 12,000 loaded and 472–499 in the geographic viewport.
Raw viewport positions changed for 196, 202 and 202 aircraft across the samples,
and for 32, 0 and 56 vessels respectively. The middle vessel sample contained no
new 60-second snapshot. Counts can overlap across samples and are not summed as
unique contacts. Normal flight and vessel polling intervals remained 30/60 s.

Artifacts: `output/playwright/live-cpu-browser-final.json`, its completion log
and `live-cpu-browser-final-benchmark.png`. The report asserts actual camera,
profile, healthy sources, visible contacts and raw source updates. All three
sample windows passed.

## Profiling and first measurement

The pre-change V8 profile identified repeated projection/extrapolation,
JulianDate sampling and detection-candidate preparation. Its first sample had
the profiler enabled and is excluded from unprofiled comparisons. The two
unprofiled samples averaged 43.80% browser CPU and 1.30% Node CPU, with about
5,437 aircraft and 12,000 vessels loaded.

The initial post-change REAL run used the same fixed Italy camera (42.4 N,
12.25 E, 1,050 km), viewport 1280×800 at device DPR 2 and Cesium buffer 960×600,
30-second warmup plus five-second settle, followed by three 30-second samples.
Builds and tests were stopped. Hardware renderer: ANGLE Metal / Apple M4.

| Sample             | Browser CPU |  Node CPU |       fps |
| ------------------ | ----------: | --------: | --------: |
| 1                  |      41.23% |     2.00% |     20.01 |
| 2                  |      35.10% |     1.50% |     20.01 |
| 3                  |      45.79% |     2.03% |     20.01 |
| Time-weighted mean |  **40.71%** | **1.84%** | **20.01** |

Both feeds supplied actual coordinate updates: the last sample changed raw
positions for 160 aircraft and 82 vessels within the geographic viewport.
These are source changes rather than proof based only on interpolated sprites.

The live workload changed: the first two post-change samples had 286–297
regional aircraft loaded and the last ended with 5,444 global records. Vessels
remained at 12,000, with about 495–528 in the geographic viewport. Consequently
43.80 → 40.71% is an observation, **not a matched causal reduction estimate**.
Likewise the older 84.91% run in `LIVE-CPU-VALIDATION.md` is historical evidence,
not a valid denominator for claiming a 52% saving. Provider fallback, traffic,
imagery/GPU work, warmup and other host activity affect live CPU figures.

## Reproduction

Run the dev server, then:

```sh
node scripts/qa-live-cpu.mjs --tag=browser-final
```

The harness uses real application routes and imagery, no injected positions,
accelerated polling or forced render holds. It checks profile, camera, source
health, nonempty geographic contacts and raw coordinate changes from both
feeds. Hardware GPU rendering is required. It measures the dedicated browser
and all its child processes, plus the current Node listening PID. The user's
normal tab can also request data from that server. No raw contacts, environment
values or credentials are exported.

`--profile` enables a V8 profile on the first sample only. `--tag` keeps artifacts
separate from previous measurements. Reports/screenshots are local and ignored
under `output/playwright/live-cpu-<tag>.*`. Initial evidence is in
`live-cpu-browser-before.json/.cpuprofile` and `live-cpu-browser-after.json`.

## Validation

The initial 237 focused browser/motion tests passed. Full ordinary tests passed
again with the flight controls present: 6,281 passed, zero failed, one existing
skip, plus 14 serialized allocation tests. The final follow-up focused suite
passed 97 tests. Production build, formatting, script syntax and import/package
boundaries passed. The real UI verified airline/flight filtering and the
existing follow-camera path; see `FLIGHT-FILTERS-VALIDATION.md`.

Validation was performed locally; no production deployment or upstream merge is claimed. CPU time is not a measurement of
watts, GPU energy, thermal behavior or hours of battery life.
