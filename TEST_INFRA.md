# SafeSpotSG Lab: End-to-End Test Infrastructure Specification

**Document Version:** 1.0.0  
**Project:** God's Eye View (GEV) — SafeSpotSG 3D Visual Routing, Pickup Simulation & Garmin Watch Evaluation Lab  
**Authoritative Sources:**  
- `PROJECT.md` (Project Scope & Feature Inventory)  
- `.agents/teamwork/ORIGINAL_REQUEST.md` (Mandatory Acceptance Criteria & Architecture Invariants)  
- `.agents/teamwork/spec_miner_safespot_gen2/analysis.md` (Domain Specifications & Algorithms)  
- `.agents/teamwork/explorer_telemetry_qa_gen2/analysis.md` (Telemetry, WebSocket & QA Architecture)  

---

## 1. Executive Overview & Test Architecture

The SafeSpotSG Lab inside God's Eye View integrates high-performance Singapore road and pedestrian routing, real-time rain adaptation, multi-candidate senior pickup optimization, and Garmin fēnix 6 Pro Solar multi-sensor telemetry streaming into GEV's photorealistic 3D Cesium globe.

To ensure production-grade reliability, strict credential safety, and zero regression against GEV's core architecture, this test infrastructure establishes a **4-Tier End-to-End Testing Methodology** implemented in `scripts/qa-safespot-lab.mjs`:

```
┌────────────────────────────────────────────────────────────────────────┐
│                      Tier 1: Feature Coverage                          │
│  - 10 Fixed Corridor Benchmark Discovery (/api/safespot/shadow-pairs)  │
│  - Dual-Route Drape & >35m Divergence (/api/safespot/corridor-diff)    │
│  - Senior Pickup Simulation & Scoring (/api/safespot/pickup-sim)       │
│  - Rain Weather Sheltered Walking Adaptation                           │
│  - Garmin Telemetry & Sensor Fusion (/api/safespot/wearable-status)    │
│  - Garmin WebSocket Telemetry Bridge (ws://.../telemetry-ws)           │
├────────────────────────────────────────────────────────────────────────┤
│                   Tier 2: Boundary & Corner Cases                      │
│  - Missing / Malformed Inputs & Schema Violations                      │
│  - Out-of-Bounds & Offshore Coordinate Rejection                       │
│  - Expressway Snapping Exclusions (Non-Snappable Links)                │
│  - Senior Walking Limit Disqualification (>600s / 10 min)              │
│  - Sensor Staleness: Barometer Reference Expired (>45 min)             │
│  - Watch GNSS Stale (>180s) Demotion & Disagreeing Fixes               │
│  - WebSocket Disconnect, Malformed Frames & Rapid Reconnect            │
├────────────────────────────────────────────────────────────────────────┤
│                 Tier 3: Cross-Feature Integration                      │
│  - Telemetry Fused Location -> Pickup Simulation Input Pipeline        │
│  - Multi-Corridor Concurrent Diff Routing                              │
│  - Rain Weather Coupling: Pedestrian Linkways + Road Delays            │
│  - WebSocket Telemetry Streaming Under Concurrent REST API Load        │
├────────────────────────────────────────────────────────────────────────┤
│           Tier 4: Real-World Workload & Performance SLA                │
│  - Latency SLA: Median Response Latency < 300ms Across All Endpoints   │
│  - Statistical Profiling: Min, Max, Mean, Median (p50), p95, p99       │
│  - Boundary Enforcement: `npm run check:boundaries` (Exit 0)           │
│  - Workspace Isolation: SafeSpotSG git status 0 changes (Read-Only)    │
│  - Zero Secret Leakage: Scan for API keys, tokens, or credential leaks │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Tier 1: Feature Coverage (Core Functional Tests)

Tier 1 verifies that all primary functional paths operate correctly, return valid JSON conforming to specified schemas, and satisfy mathematical formulas.

### 1.1 10 Fixed Singapore Corridor Discovery
- **Endpoint**: `GET /api/safespot/shadow-pairs`
- **Methodology**: Ingests and verifies the 10 strategic Singapore benchmark corridors defined in `ROUTING_PLAN.md §9` and `spec_miner_safespot_gen2/analysis.md §5`.
- **Authoritative Expectations**:
  - Response status: HTTP 200 OK, `Content-Type: application/json`.
  - Body contains an array (`corridors` or `pairs`) of at least 10 items.
  - Every corridor contains:
    - `id` (string, unique)
    - `name` (string)
    - `origin`: `{ lat: number, lng: number }`
    - `dest` or `destination`: `{ lat: number, lng: number }`
    - `expectedDivergence`: boolean
  - Required corridor IDs must all be present:
    1. `toa-payoh-to-raffles-place` (expectedDivergence: `true`)
    2. `toa-payoh-to-changi-t3`
    3. `toa-payoh-to-jurong-east`
    4. `jurong-west-to-woodlands`
    5. `jurong-west-to-tampines`
    6. `jurong-west-to-sengkang`
    7. `pasir-ris-to-bedok`
    8. `ang-mo-kio-to-punggol` (expectedDivergence: `false`)
    9. `clementi-to-harbourfront`
    10. `novena-to-mbs` (expectedDivergence: `true`)

### 1.2 Dual Polyline Corridor Diff & >35m Divergence Flagging
- **Endpoint**: `GET` / `POST /api/safespot/corridor-diff`
- **Inputs**:
  - `corridorId` or `pairId`: `"novena-to-mbs"` and `"toa-payoh-to-raffles-place"`
  - `thresholdMeters`: `35.0`
- **Methodology**: Evaluates side-by-side SafeSpot time-dependent routing against reference routing (Google Routes TRAFFIC_AWARE or OSRM).
- **Authoritative Expectations**:
  - Response contains:
    - `safespotRoute` (or `safeSpot`): `distanceMeters`, `durationSeconds`, `coordinates` (array of `[lng, lat]` or `[lng, lat, alt]`), and per-edge heatmap (`edges` or `edgeHeatmap`).
    - `referenceRoute` (or `reference`): `source`, `distanceMeters`, `durationSeconds`, `coordinates`.
    - `divergence` (or `comparison`): `isDivergent` / `divergenceDetected`: `true`.
  - **Divergence Verification on `novena-to-mbs`**:
    - Maximum spatial separation exceeds 35 meters (`maxSeparationMeters > 35m`, authoritative observed separation: ~2,166m).
    - Divergence reason: SafeSpot routes via surface arterials (Ophir Rd / Raffles Ave) whereas Reference routes via CTE tunnel $\rightarrow$ Marina Blvd.
  - **Divergence Verification on `toa-payoh-to-raffles-place`**:
    - Maximum spatial separation exceeds 35 meters (`maxSeparationMeters > 35m`, authoritative observed separation: ~1,100m).
    - Divergence reason: SafeSpot routes via PIE $\rightarrow$ KPE $\rightarrow$ Nicoll Highway whereas Reference routes via Balestier $\rightarrow$ CTE $\rightarrow$ Havelock Rd.
  - **Per-Edge Heatmap Verification**:
    - Each edge contains `name`, `speedKmh` (or `speedRatio`), and `delaySeconds`.

### 1.3 Senior Pickup Optimization & Scoring
- **Endpoint**: `POST /api/safespot/pickup-sim`
- **Inputs**:
  ```json
  {
    "seniorLocation": { "lat": 1.3327, "lng": 103.8479 },
    "driverLocation": { "lat": 1.3400, "lng": 103.8500 },
    "isRaining": false
  }
  ```
- **Methodology**: Ranks pickup candidates (LTA taxi stands and kerbside stops) within 400m of the senior using 1-to-many Dijkstra driving ETA and senior-paced walking routes.
- **Authoritative Scoring Formula** (`SafeSpotSG/src/utils/pickupOptimizer.ts:87`):
  $$\text{meetSeconds} = \max(\text{seniorWalkSeconds}, \text{driverEtaSeconds})$$
  $$\text{score} = \text{meetSeconds} + (0.25 \times \text{seniorWalkSeconds}) + \text{penalties}$$
  Where penalties include:
  - Kerbside stop (non-designated): $+90\text{s}$
  - Not barrier-free: $+60\text{s}$
- **Authoritative Expectations**:
  - Response contains `candidates` array (up to 14 candidates).
  - Candidates are sorted ascending by `score` (best candidate first).
  - Each candidate contains: `id`, `name`, `driverEtaSeconds` (or `driveSeconds`), `seniorWalkSeconds`, `shelteredPercentage`, `score`, and `rankingReason` (or `reasons`).
  - Driver ETA and senior walk seconds are positive numbers $\le 600\text{s}$.

### 1.4 Tropical Rain Weather Walking Adaptation
- **Endpoint**: `POST /api/safespot/pickup-sim`
- **Inputs**:
  - Dry run: `isRaining: false`
  - Wet run: `isRaining: true`
- **Methodology**: In wet weather, walking impedance on unsheltered edges increases by $3.0\times$ and stairs increase by $4.0\times$, forcing the router to prefer covered linkways (`covered=yes`).
- **Authoritative Expectations**:
  - Wet run yields a demonstrably higher or equal sheltered percentage:
    $$\text{shelteredPercentage}_{\text{wet}} \ge \text{shelteredPercentage}_{\text{dry}}$$
  - For candidates connected to covered linkways (e.g. Toa Payoh Hub, MRT stations), `shelteredPercentage` reaches $\ge 85\%$.

### 1.5 Garmin fēnix 6 Pro Solar Telemetry Ingestion
- **Endpoint**: `GET /api/safespot/wearable-status`
- **Methodology**: Queries latest fused location and raw multi-sensor telemetry states.
- **Authoritative Expectations**:
  - Returns device state: `deviceId`, `online: boolean`, `battery: number` (0–100), `heartRate: number` (40–220).
  - Returns `fusedLocation`:
    - `lat`: number, `lng`: number
    - `accuracy` or `accuracyMeters`: number ($\ge 3\text{m}$)
    - `source`: string (`'watch_gps'`, `'phone_gps'`, `'phone_ble_assisted'`)
    - `floorsAbove`: number ($\ge 0$)
  - Returns `sensors` (or `rawSensors`): `watchGps` / `watchGnss`, `phoneGps`, `bleBeacon`, `barometer`.

### 1.6 Garmin WebSocket Telemetry Bridge
- **Endpoint**: `ws://<host>:<port>/api/safespot/telemetry-ws`
- **Methodology**: Bidirectional streaming bridge between watch relays / simulators and God's Eye View 3D globe.
- **Authoritative Protocol**:
  1. Client connects via WebSocket.
  2. Client sends subscription: `{ "type": "subscribe", "deviceId": "fenix6pro-solar-asia" }`.
  3. Server emits periodic frames: `telemetry:tick`.
  4. Client injects simulated event:
     ```json
     {
       "type": "event:inject",
       "event": {
         "deviceId": "fenix6pro-solar-asia",
         "eventType": "FALL_DETECTED",
         "lat": 1.3327,
         "lng": 103.8479,
         "floorsAbove": 3
       }
     }
     ```
  5. Server emits immediate `alert:broadcast`.
- **Authoritative 3D Floor Elevation Formula** (`FloorEstimator.mc`):
  $$\Delta P_{\text{floor}} = 32.0\text{ Pa}$$
  $$\text{elevationAboveGroundMeters} = \text{floorsAbove} \times 2.8\text{ m}$$
  $$Z_{\text{senior}} = H_{\text{ground}} + (\text{floorsAbove} \times 2.8) + 1.2\text{ m}$$
- **Authoritative Expectations**:
  - WebSocket connection establishes successfully.
  - Streaming frames arrive with valid timestamp, coordinates, and uncertainty parameters.
  - Barometer altitude / floor elevation structure is present and matches the physical model.
  - Socket closes cleanly on shutdown.

---

## 3. Tier 2: Boundary & Corner Conditions

Tier 2 exercises edge cases, boundary values, error recovery, and abnormal payloads to ensure robustness.

### 2.1 Missing or Invalid Request Payloads
- **Test 2.1.1: Missing `corridorId`**:
  `GET /api/safespot/corridor-diff` with no query parameters must return HTTP 400 Bad Request with a clear JSON error message `{ "error": ... }`.
- **Test 2.1.2: Unknown `corridorId`**:
  `GET /api/safespot/corridor-diff?corridorId=unknown-expressway-route` must return HTTP 404 Not Found or 400 Bad Request without crashing the process.
- **Test 2.1.3: Malformed JSON body on `POST /api/safespot/pickup-sim`**:
  Sending invalid or incomplete JSON (e.g. `{ "seniorLocation": null }`) must return HTTP 400 Bad Request with validation details.

### 2.2 Geographic Coordinate Boundaries
- **Singapore Bounding Box**:
  - Latitude: $1.15^\circ\text{N}$ to $1.48^\circ\text{N}$
  - Longitude: $103.60^\circ\text{E}$ to $104.05^\circ\text{E}$
- **Test 2.2.1: Out-of-Country Coordinates**:
  Coordinates outside Singapore (e.g., Lat: 37.7749, Lng: -122.4194 — San Francisco) must be rejected with HTTP 400 or return zero candidates / unroutable error.
- **Test 2.2.2: Offshore / Marine Coordinates**:
  Coordinates placed in open water (Singapore Strait, Lat: 1.2200, Lng: 103.8000) must not snap to roads or crash the router.

### 2.3 Expressway Snapping Exclusions
- **Authoritative Rule** (`spec_miner_safespot_gen2/analysis.md §3`):
  Walking origins and pickup locations must NEVER snap to limited-access expressways (`motorway`, `motorway_link`, `NOT_SNAPPABLE`), preventing dangerous roadside drop-offs.
- **Test**: Pickup simulation near PIE/CTE overpass snaps only to accessible surface/service roads or taxi stands.

### 2.4 Senior Walking Time Hard Cap (>600s / 10 min)
- **Authoritative Rule** (`SafeSpotSG/src/utils/pickupOptimizer.ts:252`):
  `MAX_SENIOR_WALK_SECONDS = 600`. Any candidate requiring more than 10 minutes of walking pace ($0.9\text{ m/s}$) is strictly disqualified.
- **Test**: Verify that no candidate in the output list has `seniorWalkSeconds > 600`.

### 2.5 Sensor Staleness & Uncertainty Expansion
- **Test 2.5.1: Expired Barometer Reference (>45 min / 2,700s)**:
  Atmospheric weather pressure drift (~10 Pa/45 min) invalidates relative baseline. If reference age $> 2,700\text{s}$, `floorsAbove` must be reported as `null` or 0 with staleness flag.
- **Test 2.5.2: Watch GNSS Age > 180s**:
  When watch GNSS fix is older than 180 seconds, Phone GPS is promoted to primary source (`source: 'phone_gps'`).
- **Test 2.5.3: Disagreeing Fixes**:
  When distance between watch and phone fixes exceeds the sum of their uncertainties ($d > \sigma_w + \sigma_p$), inverse-variance fusion is aborted rather than interpolating across obstacles.

### 2.6 WebSocket Fault Resilience
- **Test 2.6.1: Malformed Inbound Text Frames**:
  Sending non-JSON text (`"invalid-packet"`) over WebSocket must not terminate the WebSocket server or close unrelated client connections.
- **Test 2.6.2: Rapid Connect/Disconnect Cycles**:
  Connecting 5 sequential sockets with immediate termination must leave zero hanging handles or unhandled promise rejections.

---

## 4. Tier 3: Cross-Feature Integration

Tier 3 validates interactions across multiple subsystems operating simultaneously.

### 3.1 Telemetry-to-Pickup Pipeline
- **Scenario**: Senior's real-time fused coordinate from Garmin watch/phone/BLE telemetry stream is passed dynamically as the origin coordinate to `POST /api/safespot/pickup-sim`.
- **Verification**:
  1. Retrieve latest fused coordinate from `/api/safespot/wearable-status`.
  2. Post this coordinate as `seniorLocation` to `/api/safespot/pickup-sim`.
  3. Verify that candidate walking paths start from the senior's fused position and all candidates are within 400m.

### 3.2 Multi-Corridor Concurrent Diff Routing
- **Scenario**: Concurrently dispatching diff calculations for `novena-to-mbs`, `toa-payoh-to-raffles-place`, and `ang-mo-kio-to-punggol`.
- **Verification**:
  - `Promise.all` executes all 3 requests in parallel.
  - Responses do not leak state or overwrite cache keys.
  - Both divergent corridors report divergence; the non-divergent corridor reports convergence.

### 3.3 Coupled Rain Weather Effects
- **Scenario**: When rain is active, test both the pedestrian network (linkway priority) and road graph traversal (traffic delay factors).
- **Verification**:
  - `isRaining: true` simultaneously triggers sheltered linkway selection and reflects peak/rain travel delay adjustments.

### 3.4 WebSocket Telemetry Streaming Under REST Load
- **Scenario**: An active WebSocket client receives 10 Hz streaming ticks while the test suite executes 20 concurrent REST requests.
- **Verification**:
  - WebSocket stream does not experience frame drops or socket disconnection.
  - REST requests finish within the 300ms SLA.

---

## 5. Tier 4: Real-World Workload & Performance SLA

Tier 4 verifies latency budgets, workspace immobility, and credential cleanliness under production conditions.

### 4.1 Latency SLA Verification (<300ms Median)
- **Requirement** (`ORIGINAL_REQUEST.md §Acceptance Criteria`):
  Each of the 4 core endpoints must achieve **median response latency under 300ms**:
  1. `GET /api/safespot/shadow-pairs`
  2. `GET /api/safespot/corridor-diff?corridorId=novena-to-mbs`
  3. `POST /api/safespot/pickup-sim`
  4. `GET /api/safespot/wearable-status`
- **Methodology**:
  - Executes $N = 10$ consecutive iterations for each endpoint.
  - Measures wall-clock execution time with high-resolution timer (`performance.now()`).
  - Computes:
    - Minimum (ms)
    - Maximum (ms)
    - Mean (ms)
    - **Median / p50 (ms)** $\rightarrow$ **MUST be $< 300\text{ms}$**
    - 95th Percentile (p95)
- **SLA Enforcement**: If any endpoint's median latency reaches $\ge 300\text{ms}$, the test suite reports a failure.

### 4.2 Workspace Boundary Enforcement
- **Requirement**: `npm run check:boundaries` must exit with code 0.
- **Methodology**:
  - Verifies that imports respect GEV's architectural direction (e.g. layers do not import internal server code, server does not import Cesium, layer token reservations remain intact).
  - Verifies layer registration uses `disposition: 'local-only'` to prevent URL token collision.

### 4.3 SafeSpotSG Workspace Immobility (Strict Read-Only)
- **Requirement**: `c:\Users\SIT EUC\Documents\Builds\SafeSpotSG` must remain 100% read-only with 0 modifications, deletions, or newly created files.
- **Methodology**:
  - Executes `git status --porcelain` on `c:\Users\SIT EUC\Documents\Builds\SafeSpotSG`.
  - Verifies that no staged, modified, or untracked files are added by this project.
  - Pre-existing untracked files (`.claude/`, `GARMIN_HANDOFF.md`, `ROUTING_PLAN.md`) documented in SafeSpotSG are preserved and unmolested.

### 4.4 Secret Leakage & Credential Safety
- **Requirement**: Zero secrets or credentials logged or committed.
- **Methodology**:
  - Verifies external keys are loaded only from `C:\Users\SIT EUC\*.txt` or environment variables.
  - Scans test outputs and git diff for known secret patterns:
    - Google API key regex: `AIza[0-9A-Za-z_\-]{35}`
    - Private token / Bearer token regex: `[0-9a-f]{64}`
    - OpenAI / standard secret regex: `sk-[A-Za-z0-9]{20,}`
    - Raw text from key files (`maps_server_key.txt`, `wearable_token.txt`, `lta_datamall_key.txt`).
  - Fails immediately if any credential signature is detected in stdout, stderr, or response payloads.

---

## 6. Test Runner CLI & Execution Options

The test harness is implemented in `scripts/qa-safespot-lab.mjs`.

### 6.1 Invocation Commands
```powershell
# Standard run against running GEV dev server (http://localhost:5173)
node scripts/qa-safespot-lab.mjs

# Custom URL
node scripts/qa-safespot-lab.mjs --url http://localhost:4173

# Standalone / Embedded Fixture Server Mode (for isolated offline verification)
node scripts/qa-safespot-lab.mjs --standalone

# Profile with 20 iterations for deep latency measurement
node scripts/qa-safespot-lab.mjs --runs 20

# Strict mode: fail on any warning or skipped check
node scripts/qa-safespot-lab.mjs --strict

# Run specific tier only
node scripts/qa-safespot-lab.mjs --tier 1
```

### 6.2 Environment Variables
- `QA_BASE_URL`: Base URL of the target server (default: `http://localhost:5173`).
- `QA_RUNS`: Number of latency benchmark iterations (default: `10`).
- `QA_STRICT`: `1` or `true` to enable strict mode.
- `QA_TIER`: `1`, `2`, `3`, `4`, or `all`.

### 6.3 Exit Codes
- `0`: All test assertions passed, median latencies $< 300\text{ms}$, boundaries clean, 0 secret leaks.
- `1`: One or more test failures, SLA violations, boundary errors, or secret leaks detected.

---

## 7. Authoritative Expected Output Derivation Matrix

| # | Test Case | Authoritative Source | Input Parameters | Expected Value / Criterion |
|---|-----------|----------------------|------------------|----------------------------|
| T1.1 | 10 Benchmark Corridors | `ROUTING_PLAN.md §9` | `GET /api/safespot/shadow-pairs` | Count $\ge 10$, all 10 IDs present, latency $< 300\text{ms}$ |
| T1.2 | Novena -> MBS Divergence | `ROUTING_PLAN.md §9`, `spec_miner §5` | `pairId: "novena-to-mbs"` | `isDivergent: true`, separation $> 35\text{m}$ (observed ~2,166m) |
| T1.3 | Toa Payoh -> Raffles Pl Divergence | `ROUTING_PLAN.md §9`, `spec_miner §5` | `pairId: "toa-payoh-to-raffles-place"` | `isDivergent: true`, separation $> 35\text{m}$ (observed ~1,100m) |
| T1.4 | Edge Speed Heatmaps | `PROJECT.md §R1` | `GET /api/safespot/corridor-diff` | Array of edges with `name`, `speedKmh`, `delaySeconds` |
| T1.5 | Pickup Candidate Ranking | `pickupOptimizer.ts:87` | `POST /api/safespot/pickup-sim` | Sorted by `score = meet + (0.25*walk) + penalty` |
| T1.6 | Rain Weather Adaptation | `pedestrianRouter.ts:179` | `isRaining: true` vs `false` | $\text{shelteredPercentage}_{\text{wet}} \ge \text{shelteredPercentage}_{\text{dry}}$ |
| T1.7 | Wearable Status & Fusion | `locationFusion.ts:91` | `GET /api/safespot/wearable-status` | `fusedLocation.accuracy >= 3`, valid sensor streams |
| T1.8 | Garmin WS Telemetry Frame | `FloorEstimator.mc:38` | `ws://.../telemetry-ws` | `telemetry:tick`, $Z = H + \text{floors} \times 2.8 + 1.2\text{m}$ |
| T2.1 | Missing Corridor Param | API Contract | `GET /api/safespot/corridor-diff` (no ID) | HTTP 400 Bad Request |
| T2.2 | Out-of-Bounds Coordinates | Singapore Bounding Box | Lat: 37.77, Lng: -122.41 | Rejected / 0 candidates / 400 error |
| T2.3 | Senior Walking Cap | `pickupOptimizer.ts:252` | `POST /api/safespot/pickup-sim` | All candidates have $\text{seniorWalkSeconds} \le 600\text{s}$ |
| T2.4 | Barometer Expiration | `FloorEstimator.mc:38` | Reference age $> 2700\text{s}$ | $\text{floorsAbove} = \text{null}$ or staleness badge |
| T3.1 | Telemetry $\rightarrow$ Pickup | Multi-layer pipeline | Fused lat/lng $\rightarrow$ Pickup origin | Candidates within 400m of fused coordinate |
| T3.2 | Concurrent Diff Routing | Routing Engine | Parallel queries for 3 pairs | Zero cache collision, correct per-pair flags |
| T4.1 | Performance Latency SLA | `ORIGINAL_REQUEST.md §Acceptance` | 10 iterations per endpoint | Median latency $< 300\text{ms}$ for all 4 endpoints |
| T4.2 | Boundary Check | Architecture Guardrails | `npm run check:boundaries` | Exit code 0, 0 violations |
| T4.3 | SafeSpotSG Read-Only | `ORIGINAL_REQUEST.md §R4` | `git status --porcelain` SafeSpotSG | 0 modified, created, or deleted files |
| T4.4 | Secret Cleanliness | Security Policy | Scan stdout/diff for key regexes | 0 leaks detected |
