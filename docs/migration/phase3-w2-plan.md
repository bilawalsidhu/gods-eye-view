# Phase 3 W2 and migration completion — execution plan (2026-10-27)

User authorization: finish W2, then the remaining roadmap (W3, W4, phase4, phase5, phase6), autonomously with review, fixes, checks and local commits. No subagents, push, publication or upstream requests. This overrides historical delegated workflows. Plan is executed sequentially in the existing migration worktrees; KISS, no unrelated old-code formatting.

## Baseline and ownership

- Phase3 worktree `/Users/h/dev/halfpixel/gev-phase3`, branch `migration/phase3-layers`, accepted W1 base `bbc4b5a553fb0710ef5896ff750df8a349eac8be`, initially clean.
- Phase4 worktree `/Users/h/dev/halfpixel/gev-phase4`, branch `migration/phase4-ui`; inspect actual HEAD and dirty state before changing it. Existing user edits are preserved.
- Never modify/run servers in `/Users/h/dev/halfpixel/gods-eye-view`. Never merge i18n-spanish. Reserved ports:4173,4185–4189; own4193 dev,4194 production preview,4195 instrumented QA preview. Verify cwd before stopping own servers.
- All browser jobs headless Puppeteer with Metal; GPU jobs sequential; CPU suites/builds after GPU completion; restart own Vite --force after full npm test. Never print provider keys, full minified bundles, environment contents or provider objects. Redact URLs/query credentials in logs. Explicit staging only, local Co-Authored-By commits.
- `.superpowers/sdd/2026-10-27-phase3-w2-and-completion/progress.md` is the resumable journal; durable wave reports/evidence live under docs/migration. Old failed verdicts are retained with invalidation reasons, current summaries derived separately.

## W2 inventory and ordering

| Order | Application id / files | Rendering / behavioral contract | Special verification |
|---|---|---|---|
| 1 | earthquakes; layers/earthquakes index/model (~404 JS lines) | Static ground discs, depth palette, magnitude labels, USGS analyst records, atomic refresh | Ground classification is actual drape, not lifted flat markers; no callbacks/continuous hold; last-good rows survive failed/cancelled fetch |
| 2 | local-firms; layers/firms (~2292 lines) | Heatmap/points, height anchors, detection, selected card, filters, viewport requests | UTC/source receipt clocks, occlusion, card/analyst identity, generation-safe refresh |
| 3 | military-installations; layers/installations (~2018 lines) | Named marker atlas, category/zoom visibility, selected footprint, search navigation | Lazy names, cluster expansion, grounded geometry, chosen site never disappears due async names |
| 4 | bikeshare; layers/bikeshare (~2039 lines) | Station markers, availability styling, card, viewport registry, select/focus | GBFS station identity and source errors, zoom/selection persistence, no stale manager listeners |
| 5 | radio; layers/radio (~4205 lines) | Clusters/stations, category filters, cards, tuning/transport/navigation | Audio stays browser-owned; mute in QA, no unsolicited playback; portal/voice target identity and camera authority |
| 6 | alpr-cameras; layers/alpr (~2415 lines) | Camera artwork, selected brackets, heights, hover/card/selection overlay | Exact marker raster/scale, pick ordering, off-screen/hidden instances, terrain failures |
| 7 | cctv; layers/cctv (~7103 lines) | Camera markers, selected frustum/ground geometry, card/video, calibration, cones, navigation | London ray-tl baseline five failures diagnosed against fresh reference; video/playback cleanup; no invented height/heading quality |
| 8 | transit; layers/transit (~4543 lines) | Moving vehicle banks, smoothing/heading, selected readout/trail, routes/controls | Reuse W1 time/movers/lines; recorded GTFS-RT, stale/stop/recovery, ground-quality changes, all existing transit QA |
| 9 | recent-imagery; layers/recentImagery (~2861 lines) | NASA GIBS catalog, map-host drape, alpha, split/swipe, thumbnails, source switching | This is raster drape, not just points: provider admission limit6, coalesced retry, both slots ownership and tile disposal, split parity on terrain and 3D tiles |

Order follows rendering dependencies, not raw catalog order. Actual catalog order/serialization tokens remain unchanged. Do not claim nine layers complete by enabling factories before each passes its contract. World-overlay host, engine.movers/lines and engine.camera are reused; introduce a shared helper only after a second consumer demonstrates the same need.

## Tasks and review checkpoints

### W2-0 — pin baseline, QA and existing SDK capabilities
1. Capture phase3/phase4 HEAD/status; pin lockfile, installed SDK dist hashes, renderer/browser/runtime versions. Installed @navaramap/three0.2.1 exposes DrapedMesh in its public built exports: inspect actual pass semantics before reusing it; no SDK/node_modules edits.
2. Record each W2 layer's source schemas, lifecycle, visibility/filter params, current actual selection/focus/follow/share/voice semantics, entity/primitive counts and owned listeners/resources. Existing feature gaps are explicit N/A, not newly invented controls.
3. Add deterministic W2 fixtures through existing source parsers (USGS, FIRMS, GBFS, station feeds, CCTV/ALPR catalogs, GTFS-RT, GIBS). Keep DEV/QA-only import boundary and scoped exact setup404 preview exception.
4. Add `qa-w2-layers.mjs` and focused per-layer adapters. Baseline runs on unmodified Cesium, then extraction is compared to that baseline. Pin scene/fixture epochs for geometry only, restore moving clocks for input/voice/lifecycle. Main and every share page get strict runtime observers.
5. Three poses plus focused close/terrain/selected scenes; real input and positive nonempty samples required. Store native screenshots and semantic JSON before implementation.

### W2-1a .. W2-9a — extract each Cesium renderer
For the corresponding row above:
- Define the smallest layer-owned render contract. Move SDK imports/draw/pick/height/view adapters into render/cesium*.js; shared logic uses geo/Rgba/plain records.
- Preserve native visuals, public facade/default standalone factory, stable ids, source ownership, abort/generation rules, params and serialization.
- Update package-boundaries and engine import checker for the actual moved graph. Keep source guards meaningful by checking the new renderer too; do not remove old assertions to pass tests.
- Run layer tests and recorded native semantic/raster comparison. Review diff independently, fix findings, run mandatory gates, commit the extraction separately when valid.

### W2-1b .. W2-9b — Navara renderer and application wiring
- Implement render/navara*.js through existing engine ports; dynamic imports in navaraMode only. Native capability objects stay injected at composition boundary when required. No viewer/Cesium objects in the Navara/shared graph.
- Use static batched points/sprites and bounded atlas banks; keep original layer distances/colors/scale/visibility/label policies. Ground shapes must cover the real visible surface; prove terrain/3D-tile behavior, foreground mesh exclusion and horizon correctness. Use public DrapedMesh only if its render-pass semantics satisfy this.
- Camera and pick routing uses existing engine contracts/selectionDispatcher, GPU click validation and CPU hover/drill semantics. Wire existing voice tools when the actual layer is available, retaining honest refusals elsewhere.
- QA compares counts and five nonempty fixed screen controls per pose (<=2px), color palette (<=3 per RGB channel for opaque glyphs), expected atlas/size/rotation and selected state. Native repeat should remain byte-identical where deterministic; classify tile/clock differences with diagnostics, never widen tolerances silently.
- Verify actual supported focus/follow/query/share, both engine share directions, visibility/params restoration, refresh, network error and cancellation, ten toggle cycles, destroy and late completions, no leftover sets/lines/listeners/timers; static layer settles to0frames/2s with no holds. Moving transit follows W1 policies.
- Headless dev and QA-preview acceptance, normal production shell, layer-specific legacy QA on both engines. Review -> fix -> full gate -> local commit. Archive failed attempts rather than overwrite them.

### W2-10 — wave closure
- Run all9 W2 and W1 regression suites, positive fixture/provider-shape tests, default-cinematic pixel/selection checks, all-layer combination checks, viewport/async-source stress and synthetic recorded baseline replay. Live smoke availability is reported separately without calling empty/unconfigured feeds a pass.
- Performance on all9 together and each heavy layer: same payload/populations/camera/canvas, warmup then3contexts/engine, uncapped workp95 and paced intervalp95, long frames, startup, layer/resource counts. Preserve existing1.1ratio and C+2/10s thresholds where they apply; name any informative series rather than inventing a gate after measurement.
- Full CPU/allocation, boundaries, scoped formatting, production/panel/QA builds, main composition, both engine contracts and shell, QA-preview module identity and strict page errors. No source changes while measuring; hash identities connect each result to its build.
- Durable `docs/migration/phase3-w2-report.md`, compact evidence and <=300KB reviewed paired images; all findings/known gaps/W3 carry are explicit. Final branch review and local commit; clean tracked tree before advancing.

## Remaining roadmap, same execution/review method

### R3 — W3 surface overlays
Detailed plan after W2 inventory/accepted APIs: traffic, submarine cables, fire perimeters, cyclones, directions, annotations, admin boundaries; also remaining catalog infrastructure/event shapes and launch pad classification. Reuse/extend actual drape capability; prove terrain/tiles/both modes, height windows, own-mesh exclusion, overlapping polygon/line order, pixels/dashes/alpha/picks and altitude/horizon views. Record all S1 cases, compare native, measure combined overlay cost, idle/disposal and large datasets. Solve product API locally; keep upstream proposals unpublished. Review/gates/commits and final wave report.

### R4 — W4 special renderers and Navara default
Detailed plan for weather/radar/satellite/lightning, GRIB wind/particles, street-level Mapillary/media camera, cockpit overlays/clouds/controls, director/scenes, cyber sonar and global-context dependency graphs. Preserve permission/network/media ownership and honest unavailable-source behavior. Add engine-specific shader/camera ports only from demonstrated consumers. Compare actual visual/input/voice/share journeys and cancellation/restore, all combinations. Review/gates/commits, then select Navara by default only after whole-product parity passes; retain a reviewable Cesium fallback until phase6 branch cleanup.

### R5 — finish phase4 Dioxus UI
Inspect current branch before edits. Finish wave2 open items: production-preview chunk retry; main baseline ratchet/wasm projection; tools.js attribution import rejection; loadUi watchForTraps teardown; production street-level fixture step13 baseline classification; remove reserved4173 defaults in4QA scripts; Known gaps/correct merge-parent docs. Full Rust fmt/clippy/test, JS/unit/allocation/builds, UI panels/a11y/disposal/keyboard/fallback/panic and both-engine preview tests, independent review and local commits. Then detailed wave3 plan for remaining left column/dock/scene chrome and all4e keyboard/a11y parity. Merge accepted phase3 into phase4 with explicit conflict review (contract, build/vite, main guard, QA/boundaries), run complete combined regression; no unrelated rail edits or i18n-spanish merge.

### R6 — phase5 Rust logic, golden-fixture ports
Work from the verified combined UI/renderer branch in its own migration branch/worktree; preserve prior branches. Plan each graph from CODE-BOUNDARIES: (1)sources/normalization/ingestion, (2)feedState/lifecycle, (3)search/geocoding, (4)query tools, (5)voice actions/session with WebRTC browser ownership, (6)director/data packs/share, (7)SGP4. Per module: record JS golden fixtures including malformed/error/cancellation cases; Rust reproduces the contract; wire bounded/batched wasm ABI; browser parity/performance/allocation, Rust+JS checks; remove old JS only after all callers switched. Keep Navara/Three renderers, overlay/media/browser APIs and Node server JS as the roadmap specifies. Local review/commit each graph, final performance/build/budget report.

### R7 — phase6 remove Cesium and final cleanup
On a separate local cleanup branch after full Navara/Rust parity, remove Cesium dependency/plugin/native renderer modules/build assets and native-only tests while preserving branch history/fallback reference. Update exports, boundaries, docs/APPLICATION/CODE-BOUNDARIES/PERFORMANCE/THIRD_PARTY_NOTICES and Pinokio launchers; no install-time developer Rust requirement when bundled wasm suffices. Verify no runtime Cesium fetch/import/assets, whole-app source graphs and production main budget, default navigation/search/all layers/voice/media/share/keyboard/accessibility, W1–W4 and UI/Rust regression/perf, production/panel startup and clean offline/unavailable-provider states. Final complete review, local commit, clean trees, migration report. No release/tag/push/publication is performed by this plan.

## Completion accounting

A task is complete only with actual checked behavior, review findings resolved, failed histories preserved, durable evidence and a local commit. Resource/provider failures and pre-existing limitations remain visible. No green verdict from missing fixtures, empty samples, unavailable layer skips, ignored late browser errors or relaxed gates. On compaction/resume read this plan + current progress, continue the active task; do not repeat already valid full expensive series without a source/build/driver change or new unresolved concern.
