# Argentina CCTV and upstream view thinning

Integration date: 2026-10-30. The merge preserves the previous #1163 head
`c0eb0a428fa69fb4e15a5d5e4c5d39683f591a08` and upstream #1485/main
`423ca3ca5f379c218f6cd4a96fa85dde848aa5c8` as parents. The catalog JSON
is byte-for-byte unchanged: 64 cameras (25 external players, 24 HLS, 15 stills).
The existing external-player, HLS recovery, session admission and snapshot-alias
work remains in the history; no regional pack or independent PR is replaced.

## Reconciliation

- The panel reads the stable, lightweight `cameraIndex`. The complete
  `cameras` property remains a lazy getter for callers explicitly needing it.
- Upstream screen/horizon culling, world-cell thinning, active-camera retention,
  working-set geometry loading, retry bounds and view-listener cleanup remain.
- ID selection uses the full record map rather than the visible picker subset.
  Selecting an off-screen camera refreshes visibility and queues its geometry;
  its picker entry remains first even when the view then becomes empty.
- External players retain their provider-owned panel, approximate-location
  labels, absent calibrated coverage, and absence of snapshot/media URLs.
  Routine notifications keep the same iframe; collapse, hidden document,
  deselection, disable, provider changes and destruction release it.
- Learned `none` cameras remain selectable with the no-public-feed badge and
  no image/media URL or protected-card fetch.
- Coverage-neighbour caching is retained while excluding external players.
  Catalog counts use `count`, not the number of visible picker entries.
- All ten shipped locales include the eight player/no-feed strings.

## Before/after verification

The same panel lifecycle regression was run against both trees. It supplies
`cameraIndex` and a throwing full-catalog getter: the old tree fails by reading
`state.cameras`; the integrated tree passes without reading it. The regression
also exercises unchanged-player refresh, panel/document visibility, disable,
deselect and destruction. The view-thinning tests verify lazy full state,
visible-only picking, thinning and active retention. Four Argentina integration
cases exercise off-screen ID selection for embed/HLS/image/learned-none cameras,
view refresh, geometry admission and idempotent reselection.

Final CCTV suite: 506 passed, zero failures. Production build, formatting,
package boundaries and i18n passed on Node 24.22.1. The first unrestricted full
suite had 9,130 passes, two skips and one failure: the unchanged upstream
Unicode string performance assertion exceeded its 200 ms wall-clock limit
under concurrent load. Both tests in that file passed immediately in isolation.
The bounded-concurrency final run and separate allocation probes are recorded below.

No browser FPS measurement or live-camera replay was performed. Mocked lifecycle
and selection tests do not establish operator availability, codec support, or
the browser frame-rate numbers reported by #1485.

Final full run:
`GEV_REQUIRE_ALLOCATION_GATE=1 taskset -c 0-3 npm test`:
9,137 tests, 9,134 passed, two skipped, one failure. The only failure was again
the unchanged upstream `tool string bounds hold at their edges and on huge
arguments` wall-clock assertion (405.99 ms total test duration); no CCTV test
failed. The passing isolated rerun completed that test in 101.08 ms.
The full runner exits before serialized probes when any ordinary test fails,
so both allocation files were executed separately with
`node --expose-gc --test --test-concurrency=1`.

Both allocation files passed: 1 focus-allocation probe and 14 world-overlay
probes, 15 passed, zero failures or skips. Budgets and thresholds are unchanged.
