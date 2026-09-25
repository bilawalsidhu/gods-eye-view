# Integration avenues with Geometric-to-Binary-Computational-Bridge

> A VIEW. The authority is `integrations/gods-eye-view/*/links.json` in
> https://github.com/JinnZ2/Geometric-to-Binary-Computational-Bridge, rendered by `crosslinks.py gev-view`. Edit there.

One folder per domain. Each names the GEV entry points, the bridge entry
points, the ecosystem repos that plug in, and the avenues with what would
make each one FAIL.

```
  GEV  = SINK + RENDER    public feeds → proxies (cache, serve-stale) → layer records → globe / voice
  Bridge = MEASURE + JUDGE  transducer → Gray bits → claim table → router → residual → query
  Seam = the layer record (plain {lat, lon, ...} + feed state)  ⇄  reading() / Primitive
```

## 01-geo-seismic

Point-process transducer (USGS) -> band claim -> residual router. The globe shows every event; nothing tests a rate.

Bridge folder: `integrations/gods-eye-view/01-geo-seismic/`

GEV entry points

| file | role |
|---|---|
| `src/data/earthquakes.js` | USGS all_day.geojson poll, M2.5+, depth bands <70/<300 km, static ellipse axes (measured 32.4 -> 1.4 ms/frame) |
| `src/data/analystEngine.js` | earthquakes: numeric [magnitude, depthKm], text [place]; spoken queries over the loaded records |
| `src/data/manager.js` | layerFeedState(): the six-value feed state every layer reports through |

Avenues

| id | title | direction | cost | status |
|---|---|---|---|---|
| `av-geo-1` | USGS feed as a transducer for the field claim loop | gev->bridge | low |  |
| `av-geo-2` | Aftershock structure as the NOISE_AS_SIGNAL positive control | gev->bridge | low |  |
| `av-geo-3` | Depth bands are a 2-bit non-Gray code | bridge->gev | trivial |  |

Ecosystem: `earth-systems`, `physics-guard`, `noise-sensor`

## 02-atmosphere-storm

Two live thermal/fluid feeds on the globe (weather, fires) and one live thermal/fluid feed in the bridge (buoys) that has never been drawn.

Bridge folder: `integrations/gods-eye-view/02-atmosphere-storm/`

GEV entry points

| file | role |
|---|---|
| `src/weatherEffectsMath.js` | deriveWeatherEffectProfile(): WMO code selects the family, observations bound strength; missing weather fails clear |
| `src/data/firmsAdapt.js` | adaptFirmsRecords(): FIRMS VIIRS l/n/h and MODIS 0..100 confidence -> 0..1; frp, brightness, day/night |
| `src/data/firmsHeatmap.js` | the fire layer's render path; 'local-firms' in analystEngine |
| `src/styles/thermal.js` | the FLIR look: a GLSL post-process over RGB imagery. Not thermal data. See interference |
| `DATA_SOURCES.md` | licence carve-outs per feed; the shape the bridge's .fieldlink.json consent field mirrors |

Avenues

| id | title | direction | cost | status |
|---|---|---|---|---|
| `av-atm-1` | NDBC buoys as a GEV data layer | bridge->gev | medium |  |
| `av-atm-2` | NHC active storms as annotation polygons | bridge->gev | low |  |
| `av-atm-3` | FIRMS confidence <-> epistemology grade | both | trivial |  |
| `av-atm-4` | Buoy pressure/wind residuals through the claim loop during a named storm | bridge->bridge | low |  |

Ecosystem: `earth-systems`, `physics-guard`, `urban-resilience`, `noise-sensor`

## 03-orbital

TLE -> SGP4 -> position is a forecast whose error grows with epoch age. GEV draws it; the bridge has the potential-energy encoder and a drift detector but no orbit.

Bridge folder: `integrations/gods-eye-view/03-orbital/`

GEV entry points

| file | role |
|---|---|
| `src/data/satellites.js` | twoline2satrec/propagate from satellite.js; ISS overlay; dense catalog modes; tracked refresh |
| `src/data/issPass.js` | findNextIssPass(): look angles, next pass above min elevation |
| `src/data/rocketLaunches.js` | Launch Library 2 rolling 30-day; failed launches get no fallback orbit |
| `src/data/geoid.js` | EGM96 undulation N: h = H + N, the datum every altitude in the app passes through |
| `src/celestialRing.js` | celestial directions projected into the camera plane |

Avenues

| id | title | direction | cost | status |
|---|---|---|---|---|
| `av-orb-1` | SGP4 state -> gravity encoder payload | gev->bridge | low |  |
| `av-orb-2` | TLE epoch age as a drift claim | gev->bridge | low |  |
| `av-orb-3` | precession.py vs celestialRing.js cross-check | both | trivial |  |
| `av-orb-4` | ISS pass windows as orbital-phycom link opportunities | gev->ecosystem | low |  |

Ecosystem: `orbital-phycom`, `fractal-compass`, `keystone-codex`

## 04-mobility-transport

A dead-reckoning coast between polls is a point forecast. The bridge's Kimchi engine widens an interval instead and flags when the fitted regime expired.

Bridge folder: `integrations/gods-eye-view/04-mobility-transport/`

GEV entry points

| file | role |
|---|---|
| `src/data/motionModel.js` | displayedKinematics, staleCoastLimitSeconds, synthesizeForwardKinematicsFix, corridorPathLatLon: coast between fixes |
| `src/data/routePlausible.js` | crossTrackKm against origin/destination great circle |
| `src/data/flights.js` | OpenSky primary; adsb.lol regional fallback with provenance in stats |
| `src/data/aisWatchdog.js` | AIS stream liveness |
| `src/data/traffic.js` | simulated dots on OSM roads; TomTom flow tiles when keyed; mode: 'sim' reads as 'fallback' |
| `scripts/track-regression.mjs` | four tracking invariants locked with synthetic feeds |

Avenues

| id | title | direction | cost | status |
|---|---|---|---|---|
| `av-mob-1` | Coast error vs coast time, measured from GEV's own fix history | gev->bridge | low | harness shipped (coast_divergence.py: ports of arcOffsetEnu, estimateTurnRateDps, staleCoastLimitSeconds; fetch/measure/selftest), self-tested on great-circle synthetics with a ~120 m tangent-plane floor at 69 km. UNMEASURED on real fixes: OpenSky and adsb.lol were unreachable from the session. Run `fetch` where they are, then `measure`. |
| `av-mob-2` | Cross-track distance as a band claim | gev->bridge | low |  |
| `av-mob-3` | Traffic simulation must enter the bridge as 'asserted' | gev->bridge | trivial |  |
| `av-mob-4` | Validity scope on the kinematic constants | bridge->gev | low |  |

Ecosystem: `trdap`, `urban-resilience`, `be2-communication`, `cyclic`

## 05-infrastructure

Dams are G->EM nodes, datacenters are EM->T sinks, cables are EM information channels. The coupling matrix has the efficiencies; the globe has the positions; neither has the flows.

Bridge folder: `integrations/gods-eye-view/05-infrastructure/`

GEV entry points

| file | role |
|---|---|
| `src/data/local_data/datacenters/README.md` | ~4.3K OSM polygons (ODbL): name, operator, telecom=data_center. No power rating field |
| `src/data/local_data/dams/README.md` | 704 OSM/OpenInfraMap polygons (ODbL) |
| `src/data/local_data/telegeography_submarine_cables/README.md` | 712 cables + 1,917 landing points, CC BY-NC-SA 3.0: bundled with a carve-out, removed for commercial use |
| `src/data/militaryInstallations.js` | Overpass allow-listed military=* within a 10 deg viewport; cached, may serve stale |
| `src/data/localGeojson.js` | bundled GeoJSON loader shared by the local-* layers |
| `docs/CURRENT-STATE.md` | the INFRASTRUCTURE tile was cut: 5,700 entities on a full-earth view took the frame rate with them |

Avenues

| id | title | direction | cost | status |
|---|---|---|---|---|
| `av-inf-1` | Coupling-matrix nodes at geographic positions | gev->bridge | medium |  |
| `av-inf-2` | Consent gate on any GEV dataset mounted into the atlas | gev->bridge | trivial |  |
| `av-inf-3` | Installation feed as a stale-aware claim | gev->bridge | low |  |

Ecosystem: `thermodynamic-accountability`, `component-failure`, `urban-resilience`, `resilience`, `coop`

## 06-feed-integrity

Both repos already refuse to render a dead channel as healthy. They do it in two vocabularies. One table joins them.

Bridge folder: `integrations/gods-eye-view/06-feed-integrity/`

GEV entry points

| file | role |
|---|---|
| `src/data/manager.js` | layerFeedState(): nominal \| loading \| degraded \| stale \| fallback \| unavailable; guidance states never read DEGRADED |
| `src/data/retryableLoad.js` | createRetryableLoader(): memoize success, rate-limit failure, 5 s doubling to 300 s |
| `src/data/adsbLolFallback.js` | regional fallback with provenance surfaced in stats |
| `CHANGELOG.md` | Overpass: a 406 refusal was cached to memory and disk and served as data for a month; fixed by rotating mirrors and never caching a refusal |
| `scripts/track-regression.mjs` | deterministic harness: synthetic feeds, invariants that must hold |
| `src/data/aisWatchdog.js` | liveness of a websocket stream |

Avenues

| id | title | direction | cost | status |
|---|---|---|---|---|
| `av-fdi-1` | One feed-state to epistemology table | both | trivial |  |
| `av-fdi-2` | Refusal-cached-as-data as a registered principle instance | gev->bridge | trivial |  |
| `av-fdi-3` | A null run for the tracking harness | bridge->gev | low |  |
| `av-fdi-4` | Age distributions instead of a stale boolean | bridge->gev | low |  |

Ecosystem: `noise-sensor`, `physics-guard`, `logic-ferret`, `component-failure`, `symbolic-sensors`

## 07-sensing-edge

GEV consumes other people's sensors over HTTP. The bridge builds its own and moves their readings over radio. The seam is the .obs line.

Bridge folder: `integrations/gods-eye-view/07-sensing-edge/`

GEV entry points

| file | role |
|---|---|
| `src/data/cctv.js` | server-registered camera URLs only; v2 calibration with provenance; viewshed; city packs |
| `src/data/radio.js` | Radio Browser directory: internet streams played directly by the browser; station tags, not RF |
| `config/cctv_sources.shinjuku.json` | the camera pack schema: lat, lon, headingDeg, pitchDeg, fovDeg, rangeM, mountHeightM, license |
| `SECURITY.md` | the proxy fetches registered URLs only, never client-supplied ones |

Avenues

| id | title | direction | cost | status |
|---|---|---|---|---|
| `av-sen-1` | A field-nodes layer: .obs lines on the globe | bridge->gev | medium |  |
| `av-sen-2` | Camera pack schema as a sensor-pack schema | gev->bridge | low |  |
| `av-sen-3` | A spoken relay through the voice agent | both | high |  |

Ecosystem: `be2-communication`, `symbolic-sensors`, `noise-sensor`, `biogrid`, `living-intelligence`

## 08-analyst-agent

GEV answers questions over records and confirms only what happened. The bridge proposes routes with evidence and refuses to conclude. Same posture, opposite directions.

Bridge folder: `integrations/gods-eye-view/08-analyst-agent/`

GEV entry points

| file | role |
|---|---|
| `src/data/analystEngine.js` | pure query over record arrays: applyFilter, applyScope, follow-up memory; returns {items, coverage}; never fetches |
| `src/voice/gevActions.js` | client-side tool execution: confirm only what actually happened |
| `vite.config.js` | GEV_REALTIME_TOOLS (28 tools, ~line 5664) declared server-side; /api/openai/hud-summary; /api/realtime/token |
| `src/hudSummaryResponse.js` | LLM summary over the HUD state |

Avenues

| id | title | direction | cost | status |
|---|---|---|---|---|
| `av-agt-1` | Coverage and feed state on every narrated answer | bridge->gev | trivial |  |
| `av-agt-2` | A spoken claim through T1-T4 | gev->bridge | medium |  |
| `av-agt-3` | A null harness for the HUD summary | bridge->gev | low |  |
| `av-agt-4` | The analyst result set as a Reading | gev->bridge | low |  |

Ecosystem: `haas`, `defense`, `logic-ferret`, `ai-arena`, `ai-human-audit`, `adaptive-intelligence`

## 09-detection-attention

Both repos ration attention: which of 12k objects gets a label, which frame gets a heavy computation. GEV's governor is the better design. The bridge has the null test the quota weights have never had.

Bridge folder: `integrations/gods-eye-view/09-detection-attention/`

GEV entry points

| file | role |
|---|---|
| `src/data/detectionCohort.js` | BoundedCohort: streaming deterministic reservoir, 256 cap, FNV-1a identity hash, priority then band then hash |
| `src/data/labelArbiter.js` | allocateLayerQuotas(demand, capacity, strategy, layerWeights): elastic or weighted; 32 px cells |
| `src/data/focusDeemphasis.js` | focus target emphasis with tunable params; evidence clock seam for QA |
| `src/renderGovernor.js` | identity-keyed holds; continuous while any hold, idle otherwise; O(1) passive |
| `src/overlays/worldOverlayAllocation.worker.mjs` | allocation off the main thread |
| `scripts/track-regression.mjs` | the tracked entity survived four regressions because the harness couples to per-frame position |
| `src/data/labelArbiterNull.test.mjs` | av-det-1: the null harness, measured numbers in the header, both halves pinned |

Avenues

| id | title | direction | cost | status |
|---|---|---|---|---|
| `av-det-1` | Null harness on allocateLayerQuotas layerWeights | bridge->gev | trivial | MEASURED 2026-09-16, src/data/labelArbiterNull.test.mjs in the fork: random weights in [0.5, 2] reproduce the shipped allocation 18-31% of the time at capacities 16-128 (not the 77% AISS shape), and the shipped weights move ~3% of labels against flat weights (0.45 of 16, 1.84 of 64). Reading: load-bearing and small, a tiebreak on top of sqrt(count). Both halves pinned. |
| `av-det-2` | Render governor holds replace the strobe modulo | gev->bridge | low |  |
| `av-det-3` | Priority is a projection and says so | bridge->gev | trivial |  |
| `av-det-4` | The tracking harness as a worked pin | gev->bridge | trivial |  |

Ecosystem: `shadow-hunting`, `fractal-compass`, `geometric-manifold`

## 10-encoding-wire

GEV serialises a view into a URL hash. The bridge serialises a measurement into Gray bands and a claim into 41 bytes. Both have a version field; only one has a checksum.

Bridge folder: `integrations/gods-eye-view/10-encoding-wire/`

GEV entry points

| file | role |
|---|---|
| `src/sharelink.js` | hash format: lat, lon, alt, heading, pitch, style token, bloom, hud, detection, map; STYLE_TO_URL maps thermal -> 'flir' |
| `src/data/layerState.js` | LAYER_STATE_REGISTRY: 16 single-letter tokens; LAYER_STATE_VERSION = 2; encode/decodeLayerStateParams |
| `src/scopeMask.js` | clampScopeTerminusPct: a bounded scalar on the wire |

Avenues

| id | title | direction | cost | status |
|---|---|---|---|---|
| `av-enc-1` | A view as a Primitive over a voice-only channel | both | low |  |
| `av-enc-2` | Layer tokens and the modality nibble in one table | both | trivial |  |
| `av-enc-3` | GEV feed claims in .claims line format | gev->bridge | low |  |
| `av-enc-4` | Share-link round-trip as a lossless-ness test | bridge->gev | trivial |  |

Ecosystem: `rosetta`, `soms`, `mandala`, `keystone-codex`

## 11-visualization

The bridge has a field solver with a JavaScript mirror that has never been drawn on a globe. GEV has a globe that has never drawn a field.

Bridge folder: `integrations/gods-eye-view/11-visualization/`

GEV entry points

| file | role |
|---|---|
| `src/overlays/worldOverlay.js` | setOverlayEntries(): source-owned entries with priority, collision group, paint lane, edge fade, horizon cull |
| `src/overlays/worldOverlayTokens.js` | overlay token vocabulary |
| `src/data/trailRenderer.js` | one entity polyline per track; whole history at one alpha, dimmed behind geometry |
| `src/styles/surveillance.js` | post-process shader pattern (NVG); thermal.js, noir.js, retro.js, snow.js share it |
| `src/data/firmsHeatmap.js` | the one scalar-field render in GEV today |

Avenues

| id | title | direction | cost | status |
|---|---|---|---|---|
| `av-vis-1` | solver.js as a GEV layer | bridge->gev | medium |  |
| `av-vis-2` | Trails as 4D splat chains | gev->bridge | low |  |
| `av-vis-3` | Octahedral glyphs as overlay tokens | bridge->gev | low |  |

Ecosystem: `mandala`, `polyhedral`, `rosetta`
