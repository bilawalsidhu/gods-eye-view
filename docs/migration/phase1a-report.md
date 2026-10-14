# Phase 1a report: `src/geo`

Phase 1a moved gev's vector maths off Cesium without changing behaviour. It
added `src/geo/`, an engine-neutral port of the CesiumJS 1.138 core maths gev
uses, and moved five batches of modules onto it. Branch
`migration/phase1a-geo`, base `132b9e96`.

## History

| Commit | Content |
|---|---|
| `feat(geo): add src/geo, Cesium's vector maths without Cesium` | all of `src/geo` with its tests, the import-direction rule that forbids `cesium` and `@cesium/*` there, `CODE-BOUNDARIES.md`, `THIRD_PARTY_NOTICES.md` |
| `refactor(camera,data): …` | Task 6: `src/data` and the root `src/*.js` modules |
| `refactor(ui,voice,annotations,scenes): …` | Task 7 |
| `refactor(vessels,satellites,awareness): …` | Task 8, part 1 |
| `refactor(flights,military,localAdsb): …` | Task 8, part 2 |
| `refactor(launches,cctv,alpr): …` | Task 9, `launches/camera.js` included |
| `refactor(streetLevel,traffic,transit,…): …` | Task 10 |
| `test(qa): click street-level coverage at a verified pixel` | QA fix for a pre-existing flaky step |

`src/geo` lands complete in the first commit: private constructors and
gated checks are both in it. Each batch commit adds the
`scripts/package-boundaries.json` entries its groups need. Every commit passes
`npm test` and `npm run check:boundaries`.

## Importers

Counted with
`grep -rlE "from ['\"]cesium['\"]" src | grep -E '\.(js|mjs)$' | grep -v '\.test\.'`:

- **Files that import `cesium`:** 217 at `132b9e96`, **182** now.
- **Files that import `src/geo`** (outside `src/geo`, tests excluded): 87.

35 files no longer import Cesium:

- **Root, data and services:** `app/embed.js`, `cockpitCloudEffects.js`, `data/detection.js`, `data/trackedCamera.js`, `hud.js`, `services/groundSnap.js`.
- **UI and voice:** `ui/cockpitCamera.js`, `ui/cockpitContext.js`, `ui/cockpitController.js`, `voice/pointerPick.js`.
- **Layers:**
  - `alpr/{model,visuals}.js`
  - `awareness/state.js`
  - `cctv/{cards,geometryQueue,state}.js`
  - `flights/controller.js`
  - `installations/viewport.js`
  - `launches/policy.js`
  - `localAdsb/motion.js`
  - `radio/state.js`
  - `satellites/{controls,orbits,records,state}.js`
  - `streetLevel/{groundClick,index}.js`
  - `submarineCables/overlay.js`
  - `traffic/ingestion.js`
  - `transit/{state,trails}.js`
  - `vessels/{cameraArea,queries,state,tracking}.js`

## Cesium symbols that remain in logic

The table counts references (`Cesium.<Symbol>`) and files among the 182
importers. These symbols are the input for phase 1a-2 and, through the engine
interface, phase 1b.

| Category | Refs | Files |
|---|---|---|
| `Color` | 190 | 57 |
| `JulianDate` | 69 | 23 |
| `BoundingSphere` | 29 | 20 |
| `SceneTransforms` | 29 | 20 |
| `Rectangle` | 20 | 10 |
| `HeadingPitchRange` | 19 | 14 |
| `EasingFunction` | 18 | 15 |
| `EllipsoidalOccluder` | 15 | 13 |
| `EllipsoidGeodesic` | 5 | 3 |
| Render classes (Entity, primitives and collections, Material, properties, Model, tilesets, origins and height references, event handlers) | 316 | 83 |

In-scope maths that is still on Cesium, against base:

| Symbol | Refs at base | Refs now |
|---|---|---|
| `Cartesian3` | 945 | 538 |
| `Math` | 411 | 81 |
| `Cartographic` | 129 | 45 |
| `Ellipsoid` | 101 | 53 |
| `Matrix4` | 77 | 41 |
| `Cartesian2` | 39 | 22 |
| `Matrix3` | 20 | 8 |
| `Transforms` | 17 | 7 |
| `Quaternion` | 6 | 2 |

Most of these remaining references fall into three groups:

- modules outside the five batches, mainly rendering;
- values handed to Cesium where Cesium needs its own instances (see rules 5, 9 and 10);
- the deferred items below.

## Deferred to phase 1a-2

- **Traffic:** `model.js`, `timing.js` and `animation.js` move together with the transit marker.
  - `timing.js` stays textually equal to `model.parseRoads`, and a test enforces that.
  - The lerp scratch in `traffic/state.js` stays on Cesium while `animation.js` writes it every frame; a geo scratch there cost 4–7 %.
- **Launches:** `paths.js` moves together with a geo `EllipsoidGeodesic`.
- **Rendering-side modules:**
  - launches: `overlays`, `rendering`, `launchPad`, `orbitRendering`;
  - cctv: `rendering`, `lifecycle`;
  - alpr: `overlay`, `presentation`.
- **Awareness:** `awareness/subject.js` keeps a Cesium clone of the resolved subject position. The installations anchor receives it, and `anchor.test` pins a Cesium instance.
- **JSDoc:** a sweep of about 40 stale Cesium type names (`@param {Cesium.Cartesian3}` on values that are now geo values).
- **Package boundaries:** a shared-owner feature for `scripts/package-boundaries.json`. Today every group that reaches `src/geo` lists all 14 geo files.
- **Pre-existing bug:** at `layers/streetLevel/index.js:303`, a `{x, y}` literal goes into `scene.pickPosition`. Cesium keys its pick cache on `toString()`, so the cache key is always `"[object Object]"` (see rule 9).

## Rules learned

### The batch recipe

1. Replace in-scope calls one for one. Signatures, argument order and `result` semantics stay the same.
2. Constructors become `geo.<type>.create()`.
3. Instance methods become module functions, for example `p.clone()` becomes `geo.cartesian3.clone(p)`.
4. Remove the `cesium` import when nothing else needs it. Otherwise keep it only for out-of-scope symbols.
5. Values that go into Cesium rendering stay plain data, except where Cesium checks `instanceof` (Spline, `flyTo` with a Cartographic, sampled properties, 3D Tiles styles).
6. Run the module's tests, then the whole suite.
7. Before converting a module that produces values, check its consumers for Cesium instance methods. The known case was `snapshotRenderer`'s `position.clone()`.
8. `transforms.headingPitchRollToFixedFrame` takes Cesium's five arguments.
9. Window positions for `scene.pickPosition` and `pickPositionWorldCoordinates` stay `Cesium.Cartesian2`, because Cesium caches those picks by `windowPosition.toString()`.
10. Values in entity graphics properties stay Cesium instances: orientation, dimensions, radii, plane, `ConstantProperty`. `ConstantProperty` copies and compares only through `clone()`/`equals()`, which geo values do not have. Positions are not affected.

Also: a Cesium `Ellipsoid` that is passed *into* Cesium APIs (`pickEllipsoid`, occluders, `Cartographic.fromCartesian(p, WGS84)`) stays Cesium's.

### Debug checks follow Cesium's build split

Cesium wraps its argument checks in `//>>includeStart('debug')` pragmas. The
checks are live in `Source` (Node tests, the Vite dev server). They are
stripped from `Build/Cesium`, which vite-plugin-cesium ships in production.

`src/geo` ports the checks with the same conditions, order and messages, and
gates every check and debug throw on `DEBUG` (`src/geo/debug.js`):

- `DEBUG` is `import.meta.env?.PROD !== true`. `vite build` folds it to `false`, and the minifier drops the blocks and `check.js` with them. The production bundle contains 0 occurrences of `normalized result is not a number`, `DeveloperError` and the `Check` messages.
- So for a degenerate input, production geo returns what release Cesium returns: NaN, not a throw. `src/geo/releaseParity.test.mjs` compares a `DEBUG = false` copy of geo with `cesium/Build/Cesium/index.cjs` on 52 degenerate cases.
- Before this gate, an always-on throw inside a `preRender` or clock listener would have stopped rendering in production, where the old code produced NaN.

### V8 hidden classes

Every `{x, y, z}` literal in the process shares one hidden class, and Cesium
and the rest of gev build many of them. When geo returned literals, its hot
functions went polymorphic, and per-frame paths ran up to 24 % slower.

Geo values are now instances of module-private constructors: own enumerable
fields only, no prototype methods. That gives geo its own hidden classes and
made the hot paths as fast as Cesium's or faster.

Because they are not `Object.prototype` objects:

- `src/app/stateChannel.js` `copyState` and `src/director/documentFields.js` `jsonTree` reject them;
- copy the fields into a literal before a value goes into product state or a scene document.

## Benchmarks against `132b9e96`

The harnesses drive each batch's per-frame and camera-event paths in Node.

- **Pairs and order:** 10 interleaved pairs per condition, with the order alternating each pair.
- **Statistic:** the mean of per-run medians.
- **Two conditions:**
  - development: geo `DEBUG` on, Cesium `Source` with its checks, on both sides;
  - production-like: geo `DEBUG = false`, Cesium `Build` with no checks, on both sides.

| Harness | Worst per-frame Δ, development | Worst per-frame Δ, production-like |
|---|---|---|
| flights, military, local ADS-B, satellites | `flights.collectCorridorCells` −1.9 %; every per-frame path is faster | `flights.collectCorridorCells` +0.2 % |
| launches, CCTV, ALPR | `cctv.focusScreenPosition` +3.3 % | `cctv.focusScreenPosition` +0.2 % |
| street level, traffic, transit, FIRMS, cables | `transit.placeSample` +1.2 % | `streetLevel.horizonCull` moving +3.5 % |

Large wins:

- `cctv.planeOrientationFor`: −64 %
- `streetLevel.horizonCull` still: −32 to −37 %
- `firms.lodPreRender` moving: −34 %
- `satellites.orbitFrameModelMatrix`: −10 %

Not per frame:

- **`satellites.computeOrbitPath200`** (orbit bake on selection): +5.3 % in development, −3.9 % production-like. Run in isolation from the flights scenarios, it is −3 % in development too.
- **`localAdsb.observe60kFixes`** (ingestion): +4.7 % in development, −2.6 % production-like.
- **`military.applySnapshotPoll`** (poll): +2.7 % in development, +3.6 % production-like.

## QA

- **Street level, fixtures:** `qa-street-level --fixtures --strict` passed 32/32 three times in a row on a production build. Step 13 used to fail on this branch: the draped coverage line can sit on a pixel boundary. It now clicks at an integer pixel that is verified by a pick.
- **Production smoke:** `vite build` plus `vite preview`, headless with `--use-angle=metal`, on this branch and on `132b9e96` built the same way. Both show the same results, and both have 0 page errors, 0 console errors and 0 Cesium render errors. The steps:
  - the globe renders;
  - flights, satellites and AIS are enabled;
  - an aircraft is tracked for 30 s, and the camera follows it;
  - a CCTV card opens with its snapshot;
  - a launch ascent replay starts and is cancelled;
  - a street-level ground click lands.
  - The only differences are upstream resource errors: 3 on this branch, 15 on base.
- **Earlier batches:** the per-batch reports cover the repo QA scripts for each batch (cctv-v2, alpr-journey, firms, radio, cables, transit and others).

## Before merge

The allocation-budget tests (`src/data/focusAllocations.test.mjs`,
`src/overlays/worldOverlayAllocation.test.mjs`) are calibrated on Node 24. They
skip on other runtimes, and this phase was verified on Node 26. CI's Node 24
allocation-budget lane must be green before this branch merges.
