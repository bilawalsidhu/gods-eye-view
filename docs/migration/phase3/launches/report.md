# T15 — launches

## 15a1 — geometry

Ported CesiumJS1.138 EllipsoidGeodesic to `src/geo`, with native operation order, Vincenty inverse/interpolation, debug guards, result reuse and endpoint reset. Added the small native `cartesian3.angleBetween` primitive used by its guard. Launch `paths.js` uses geo vectors, cartographics, WGS84 and geodesics; no existing path-test expectations changed.

Review/oracles: 120 deterministic geodesics, dateline/polar/custom-sphere/reset/debug cases match native distance, headings and interpolation exactly. A separate 15-mission comparison (LEO/MEO/GTO at five launch sites) compared9150 ascent/orbit points: maximum delta0m. All existing rocket-launch tests plus the new oracle pass65/65. Full Node24 gate7116 total,7115pass,1skip,0fail; all15 allocation probes pass. Boundaries, format, app/panel builds pass. Initial main2902052raw/901898gzip, with no three/Navara code. Logs `/tmp/gev-t15a1-*.log`.

This is the separate mathematical commit required by the plan. Renderer extraction, LL2 fixture QA, own replay clock and Navara launches remain next. The shared cross-shell Google503/Austin-height failures recorded in the satellite report remain open for the final W1 check.

## 15a2 — Cesium renderer and replay clock

Native entities, material properties, picking, projections, orbit collections and the unchanged classified GroundPrimitive pad live in `render/cesium.js`. Shared mission logic uses geo/Rgba and a renderer interface. The LL2 fixture has three LEO/MEO/GTO missions, stage recovery and an ISS match from the shared satellite catalog. Physical propagation, GMST and replay use appClock; UI/pad throttles keep wall time. Review fixed the old countdown split (5 seconds of preparation followed by the full 10-second countdown) and a selected-pad path still referring to the removed Cesium import; regression tests cover both.

Headless Metal acceptance: Cesium baseline and extracted renderer16/16 each: real pad click, mission payload panel, focus, pad zone, replay at4x, preparation/countdown, four ascent and six orbital camera checkpoints, pause/resume/cancel, deselection and satellite dependency restoration. All21 marker samples, all static path anchors, the frozen orbit ring and every replay camera pose match the baseline exactly (0m/0degrees). The final orbit snapshot differs by157.13m because the preserved 1Hz wall throttle samples distinct virtual epochs; this is not a synchronized geometry comparison. Raw local evidence: `qa-artifacts/t15/cesium-{base,extracted}.json`, comparison JSON and screenshots. No existing path-test expectations changed.

Full Node24:7122 tests,7121pass,1skip,0fail; all15 allocation probes pass. Boundaries, format1536, application/panel builds and initial chunk composition pass:2905195raw/903263gzip, no three/Navara in initial code. Logs `/tmp/gev-t15a2-*.log`. Review performed directly, without subagents. Navara implementation and final shared contracts/shell recheck remain next; the earlier shared cross-shell provider/height gate stays open.
