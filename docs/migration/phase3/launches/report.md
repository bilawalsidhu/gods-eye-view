# T15 — launches

## 15a1 — geometry

Ported CesiumJS1.138 EllipsoidGeodesic to `src/geo`, with native operation order, Vincenty inverse/interpolation, debug guards, result reuse and endpoint reset. Added the small native `cartesian3.angleBetween` primitive used by its guard. Launch `paths.js` uses geo vectors, cartographics, WGS84 and geodesics; no existing path-test expectations changed.

Review/oracles: 120 deterministic geodesics, dateline/polar/custom-sphere/reset/debug cases match native distance, headings and interpolation exactly. A separate 15-mission comparison (LEO/MEO/GTO at five launch sites) compared9150 ascent/orbit points: maximum delta0m. All existing rocket-launch tests plus the new oracle pass65/65. Full Node24 gate7116 total,7115pass,1skip,0fail; all15 allocation probes pass. Boundaries, format, app/panel builds pass. Initial main2902052raw/901898gzip, with no three/Navara code. Logs `/tmp/gev-t15a1-*.log`.

This is the separate mathematical commit required by the plan. Renderer extraction, LL2 fixture QA, own replay clock and Navara launches remain next. The shared cross-shell Google503/Austin-height failures recorded in the satellite report remain open for the final W1 check.
