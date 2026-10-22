# SafeSpotSG × God's Eye View (GEV) — Living Engineering Handoff Document

> **Last Updated:** 2026-10-22T10:52:00+08:00  
> **Purpose:** Quota-safe, continuously updated engineering handoff for the SafeSpotSG 3D Routing Lab, Model Comparison Arena, Autonomous Full-Island Test Fleet (Cars & Buses), and High-DPI Map Upgrade inside God's Eye View (`gods-eye-view-main`).  
> **Critical Constraint:** `c:\Users\SIT EUC\Documents\Builds\SafeSpotSG` is **100% READ-ONLY**. Never modify, create, or delete files inside `SafeSpotSG`.

---

## 1. Current Status Snapshot (Updated Continuously)

| Phase / Feature | Status | Key Files | Notes |
| :--- | :--- | :--- | :--- |
| **Phase 1: SafeSpot R&D Lab Foundation** | **DONE & CERTIFIED** | `server/providers/safespot.js`, `src/data/safespot.js`, `src/layers/safespot/*` | 3 sub-labs: Corridor Diff (A*), Senior Pickup & Sheltered Linkways, Garmin Watch Live WebSocket Telemetry. |
| **Phase 2 (M1): Offline Routing Trainer & Calibrator** | **DONE & CERTIFIED** | `scripts/train-safespot-routing.mjs`, `server/providers/safespot-calibrated-params.json`, `docs/SAFESPOT_ROUTING_TRAINING_REPORT.md` | 169,316 nodes, 232,156 directed edges, 100 benchmark O-D routes, 3 models (`baseline`, `calibrated`, `speedband`), 0 data leakage. |
| **Phase 2 (M2): 3D Model Comparison Arena** | **DONE & VERIFIED** | `src/layers/safespot/rendering.js`, `src/layers/safespot/scorecardModal.js`, `src/layers/safespot/controls.js`, `src/layers/safespot/index.js` | Residual speed heatmap coloring (`<5`, `5-15`, `>15 km/h`), model selector chips (`BASELINE`, `CALIBRATED`, `SPEEDBAND`), and `📊 SCORECARD` HUD dialog with 95% bootstrap CIs & slice metrics. |
| **Phase 3: Autonomous Test Fleet (Cars & Buses) + 100% SG Road Coverage** | **DONE & VERIFIED** | `server/providers/safespot-fleet-engine.js`, `server/providers/safespot.js`, `src/layers/safespot/fleet.js`, `src/data/safespot.js`, `src/layers/safespot/controls.js`, `src/layers/safespot/index.js` | Real `singapore-road-graph.json` directed carriageway engine (`oneway` vs two-way + 2.2m left-hand lane offset + turn restrictions), 50 3D animated `CAR-xxxx` & `BUS-xxxx` vehicles + turbo full-island sweep to 100% network coverage + `getDetectableObjects()` integration. |
| **Phase 4: Crisp High-DPI Map & Street Label Upgrade** | **DONE & VERIFIED** | `src/layers/safespot/hdMap.js`, `src/layers/safespot/controls.js`, `src/layers/safespot/index.js` | High-DPI `@2x` (512px) CartoDB Voyager Retina / SLA OneMap Singapore HD / CartoDB Dark `@2x` tile layers + `viewer.resolutionScale = Math.min(devicePixelRatio, 2)` + `globe.maximumScreenSpaceError = 1.0`. |
| **Phase 5: End-to-End QA & Boundary Verification** | **DONE & VERIFIED** | `src/layers/safespot/index.test.mjs`, `scripts/package-boundaries.json`, `scripts/check-import-directions.mjs` | 9/9 unit tests passing, import direction & package boundary checks passing, `SafeSpotSG` verified 100% untouched. |

---

## 2. Architecture & Feature Inventory

### 2.1 Autonomous Test Fleet (`CAR-xxxx` & `BUS-xxxx`) + 100% Singapore Road Coverage
- **Backend Engine (`server/providers/safespot-fleet-engine.js`)**:
  - Ingests `c:\Users\SIT EUC\Documents\Builds\SafeSpotSG\data\graph\singapore-road-graph.json` (`169,316` nodes, `232,156` directed edges, `turnRestrictions`, `trafficSignalNodes`).
  - Identifies the strongly connected drivable road network (`edgeIsMain`, `229,433` directed edges) and classifies every directed edge `u -> v` into:
    - **One-Way Carriageway (`edgeIsOneWay[e] = 1`)**: No opposing edge `v -> u` exists (includes dual-carriageway expressways CTE/PIE/AYE/ECP/TPE/SLE/BKE/KJE, slip roads, and one-way arterial streets).
    - **Two-Way Undivided Road (`edgeIsOneWay[e] = 0`)**: Opposing edge `v -> u` exists; both directions are tracked independently in the coverage bitmap.
  - Enforces turn restrictions (`no_left_turn`, `no_right_turn`, `no_u_turn`, `no_straight_on`, `only_*`) at every intersection (`viaNode`).
  - Dispatches **50 Autonomous Test Vehicles** across 14 regional Singapore depots:
    - **36 Autonomous Test Cars (`CAR-0001` .. `CAR-0036`)**: Route across all drivable road classes using the active SafeSpot model (`baseline`, `calibrated`, or `speedband`).
    - **14 Autonomous Test Buses (`BUS-0001` .. `BUS-0014`)**: Route across bus-permitted corridors (`trunk`, `primary`, `secondary`, `tertiary`, `residential`) with Singapore's statutory `60 km/h` bus speed limit.
  - **Server-authoritative coverage**: The engine owns a simulated clock. Each `/fleet-sim` call advances every vehicle by the wall time since the previous call × the speed multiplier, and a directed edge is counted as covered only once a vehicle has driven it end to end. Vehicles greedily steer onto uncovered, unclaimed outgoing edges; when none is legally reachable from the current junction, an edge-state Dijkstra (turn restrictions, one-way carriageways, bus-class rules) routes them to the nearest uncovered edge, so there are no teleports. A relocation (teleport) happens only when no legal path exists at all and is counted in `coverage.relocations`. Clicking `⚡ SIM SPEED` cycles `1x` ➔ `10x` ➔ `50x` ➔ `200x`; there is no instant sweep, and `100.00%` is reached only by driving the whole network.
- **3D Frontend Renderer (`src/layers/safespot/fleet.js`)**:
  - Smooth 20 Hz interpolation of all 50 `CAR-xxxx` and `BUS-xxxx` vehicles along their directed road track waypoints.
  - **Left-Hand Traffic Lane Offset (`applyCarriagewayOffset`)**: On two-way roads (`oneway: false`), vehicles are offset `2.2m` to the left of their travel bearing (`bearing - 90°`) so opposing vehicles travel in separate lanes without colliding.
  - **Crisp SVG Vehicle Callout Badges**: Renders high-DPI SVG callout tags (`CAR-0001 · 54km/h · 1W`, `BUS-0002 · 42km/h · 2W`) with zero Cesium labels (`noCesiumLabels` compliant).
  - **GEV Detection Overlay Integration (`getDetectableObjects`)**: Exposes all active test Cars and Buses as `type: 'VEH'` contacts so God's Eye View's native screen-space detection brackets automatically track them.
  - **3D Draped Coverage Tracks**: Renders covered one-way carriageways (`#06b6d4` cyan), two-way carriageways (`#10b981` emerald), and bus corridors (`#f59e0b` amber) draped onto the 3D globe/tiles.

### 2.2 Crisp High-DPI Map & Street Text Enhancer (`src/layers/safespot/hdMap.js`)
- Solves blurry/pixelated street text on standard 256×256 OSM tiles via three simultaneous mechanisms:
  1. **Native Retina WebGL Resolution Scaling**: Boosts `viewer.resolutionScale = Math.min(Math.max(window.devicePixelRatio, 1.5), 2.0)` while SafeSpot Lab is active (restored cleanly on disable).
  2. **Quadtree LOD Tightening**: Sets `viewer.scene.globe.maximumScreenSpaceError = 1.0` (down from `2.0`), forcing Cesium to fetch `+1` higher zoom level of street tiles across the viewport.
  3. **High-DPI `@2x` (512px) Retina & SLA OneMap Tile Modes (`🗺️ HD MAP` chip)**:
     - `HD MAP: RETINA @2X`: CartoDB Voyager `@2x` (`512×512` physical pixels rendered into `256×256` logical tiles = 4× pixel density for razor-sharp street names).
     - `HD MAP: ONEMAP SG`: Singapore Land Authority (SLA) OneMap Default High-Resolution Singapore street & HDB building map.
     - `HD MAP: DARK @2X`: CartoDB Dark Matter `@2x` Retina tactical street map.
     - `HD MAP: BASE`: Underlying GEV map stack with Retina `resolutionScale` boost.

### 2.3 3D Model Comparison Arena & Scorecard Modal (`rendering.js`, `scorecardModal.js`, `controls.js`)
- Interactive model switcher chips in the SafeSpot Lab tray:
  - `BASELINE` (Model 1: Phase 2 Heuristic — `7.05%` hold-out MAE)
  - `CALIBRATED` (Model 2: Joint Parametric Optimizer with $M_{\text{night}} = 1.25$ — `6.46%` hold-out MAE, `-66.4%` error reduction at `03:23 SGT`)
  - `SPEEDBAND` (Model 3: LTA SpeedBand Empirical Bayes Hybrid $N_0 = 8$ — `5.60%` hold-out MAE, `-20.6%` overall error reduction)
- Per-edge residual speed heatmap (`getResidualSpeedColor`): `<5 km/h` emerald green, `5–15 km/h` amber, `>15 km/h` crimson.
- `📊 SCORECARD` modal (`scorecardModal.js`) displaying live route scorecard, Full-Singapore Autonomous Fleet coverage progress bar, 95% bootstrap confidence intervals, and time-of-day/corridor slice tables.

---

## 3. REST & WebSocket API Endpoints (`server/providers/safespot.js`)

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/safespot/shadow-pairs` | `GET` | 10 fixed Singapore O-D benchmark corridors |
| `/api/safespot/corridor-diff` | `GET` / `POST` | Dual-route comparison, cross-track diff, `>35m` divergence spans, and model scorecard (`?corridorId=...&model=baseline\|calibrated\|speedband`) |
| `/api/safespot/training-summary` | `GET` | Calibrated parameters, 95% bootstrap CIs, slice metrics, and shadow log audit |
| `/api/safespot/fleet-sim` | `GET` / `POST` | Autonomous test fleet (`36` Cars + `14` Buses) waypoints, carriageway directionality (`oneway`), and full-Singapore road network coverage (`?model=...&speed=1..250&reset=true\|false`; coverage advances with simulated time only) |
| `/api/safespot/pickup-sim` | `POST` | 1-to-many Dijkstra driving ETA + senior sheltered linkway walk ranking |
| `/api/safespot/wearable-status` | `GET` | Garmin fēnix 6 Pro Solar multi-sensor fusion & barometer 3D floor status |
| `/api/safespot/telemetry-ws` | `WS` | Live & simulated Garmin wearable telemetry stream |

---

## 4. Resumption & Verification Commands

```powershell
# 1. Start the local dev server (http://localhost:4173/)
npm run dev

# 2. Run SafeSpot unit & integration tests (includes 100% SG road network coverage test)
node --test src/layers/safespot/index.test.mjs

# 3. Run architectural import & package boundary checks
npm run check:boundaries

# 4. Verify SafeSpotSG repository remains 100% untouched
git -C "c:\Users\SIT EUC\Documents\Builds\SafeSpotSG" status --porcelain
```
