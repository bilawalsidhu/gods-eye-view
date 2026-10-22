# Project: SafeSpotSG 3D Visual Routing, Pickup Simulation, and Garmin Watch Evaluation Lab

## Architecture
- **Non-Regression Contract**: The base model, Cesium core, shaders, and existing layers of God's Eye View (GEV) remain 100% intact with zero modifications. SafeSpotSG is integrated exclusively as a clean, modular, opt-in layer.
- **Layer Registration Pattern**: Uses GEV's native `disposition: 'local-only'` in `src/app/constructCatalog.js`. This prevents URL serialization, preserves `layerStateTokenReservations.json`, and guarantees `npm run check:boundaries` and `npm run layer-token:check` pass cleanly.
- **Backend Provider Plugin**: A dedicated Vite plugin `safeSpotProxy()` located in `server/providers/safespot.js` mounted before `apiNotFoundPlugin()` in `server/standalone/vite.config.js` and registered in `server/providers/local.js`. This serves all REST endpoints and attaches the Garmin WebSocket server to `server.httpServer`.
- **Client Data Adapter**: `src/data/safespot.js` handles API calls, fixture caching, and bidirectional WebSocket streaming with automatic reconnection.
- **Cesium 3D Layer**: `src/layers/safespot/` implements standard layer lifecycle (`init`, `enable`, `disable`, `update`, `getRowControls`, `destroy`). Uses `Cesium.ClassificationType.BOTH` with `clampToGround: true` for route drapes on 3D tiles, `GroundPolylinePrimitive` for speed heatmaps, draped ellipses for sensor uncertainty, and vertical stalks for barometer 3D floor elevations. Strictly follows `noCesiumLabels` invariant.
- **Workspace Isolation**: All code written exclusively in `gods-eye-view-main`. The `SafeSpotSG/` directory remains strictly read-only. External keys are loaded on-demand from `C:\Users\SIT EUC\*.txt` without logging secrets.

## Code Layout
- `server/providers/safespot.js`: REST endpoints (`/api/safespot/shadow-pairs`, `/api/safespot/corridor-diff`, `/api/safespot/pickup-sim`, `/api/safespot/wearable-status`) and WebSocket server (`/api/safespot/telemetry-ws`).
- `server/providers/local.js`: Export and instantiate `safeSpotProxy()`.
- `server/standalone/vite.config.js`: Mount `safeSpotProxy()` before `apiNotFoundPlugin()`.
- `src/data/safespot.js`: Client-side data fetching, caching, and WebSocket client.
- `src/app/constructCatalog.js`: Register `safespot-lab` layer with `disposition: 'local-only'`.
- `src/layers/safespot/index.js`: Layer module lifecycle and integration.
- `src/layers/safespot/rendering.js`: Cesium 3D dual-route polyline draping, speed heatmaps, >35m divergence markers.
- `src/layers/safespot/pickup.js`: Pickup candidates, 1-to-many Dijkstra driving paths, senior walking routes with covered linkways.
- `src/layers/safespot/telemetry.js`: Multi-source fusion uncertainty envelopes (GNSS/GPS draped ellipses, BLE cylinders) and barometer 3D floor elevation markers.
- `src/layers/safespot/controls.js`: UI row controls (rain toggle, corridor dropdown, scenario triggers).
- `scripts/qa-safespot-lab.mjs`: Automated QA verification test script.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | SafeSpot Road Graph & Corridor Benchmark | Serve the 10 Singapore benchmark corridor pairs and route geometry | M1 | ORIGINAL_REQUEST §R1 |
| 2 | Corridor Diff Engine & >35m Divergence Flagging | Calculate spatial separation between SafeSpot and Google/OSRM reference routes; flag >35m divergence spans | M1 | ORIGINAL_REQUEST §R1 |
| 3 | Senior Pickup Optimization & 1-to-Many Dijkstra | Rank pickup candidates (taxi stands, kerbside) using 1-to-many Dijkstra driving ETA and senior walking time | M1 | ORIGINAL_REQUEST §R2 |
| 4 | Tropical Rain Weather Walking Adaptation | Dynamically penalize unsheltered paths (3.0x) and stairs (4.0x) when `isRaining: true`, maximizing shelteredPercentage | M1 | ORIGINAL_REQUEST §R2 |
| 5 | Garmin fēnix 6 Pro Solar WS Bridge & Simulator | WebSocket server for streaming Garmin watch telemetry (live or simulated ticks, fall detection, HR) | M1 | ORIGINAL_REQUEST §R3 |
| 6 | Multi-Sensor Fusion & Barometer 3D Floor Elevation | Fuse BLE (<5m), Watch GNSS, and Phone GPS with uncertainty envelopes; render 3D floor elevation ($Z = H_{ground} + floors \times 2.8 + 1.2m$) | M3 | ORIGINAL_REQUEST §R3 |
| 7 | Decoupled GEV Layer Registration | Register `safespot-lab` with `disposition: 'local-only'` and zero URL token conflicts | M2 | ORIGINAL_REQUEST §R4 |
| 8 | Cesium 3D Dual-Route Drape & Speed Heatmaps | Draped side-by-side polylines with `Cesium.ClassificationType.BOTH`, per-edge speed/delay heatmaps, and >35m divergence alert markers | M2 | ORIGINAL_REQUEST §R1 |
| 9 | Interactive UI Row Controls & Evaluation Lab UI | Layer panel controls for toggling rain, selecting corridor pairs, triggering pickup sim, and streaming watch telemetry | M3 | ORIGINAL_REQUEST §R2, §R3 |
| 10 | Automated QA Test Suite & Boundaries Check | Automated script `scripts/qa-safespot-lab.mjs` verifying latency < 300ms, divergence, rain adaptation, WS stream, and boundary compliance | M-TEST, M4 | ORIGINAL_REQUEST §Acceptance |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M-TEST | E2E Testing Suite Track | Design test infrastructure (`TEST_INFRA.md`) and author `scripts/qa-safespot-lab.mjs` covering Tiers 1-4 | none | DONE |
| M1 | Backend SafeSpot Provider & APIs | Implement `server/providers/safespot.js`, mount in `vite.config.js` and `local.js`; provide REST endpoints and WS server | none | DONE |
| M2 | Decoupled Layer Registration & Cesium 3D Route Rendering | Register `safespot-lab` in catalog; implement `src/data/safespot.js`, `src/layers/safespot/index.js`, and `src/layers/safespot/rendering.js` | M1 | DONE |
| M3 | Senior Pickup Simulation, Rain Adaptation & Telemetry Visualizer | Implement `src/layers/safespot/pickup.js`, `telemetry.js`, and `controls.js` | M2 | DONE |
| M4 | Final Integration, 100% E2E Pass & Adversarial Hardening | Verify all 4 tiers pass with <300ms latency; run Tier 5 adversarial stress tests; verify zero modifications to SafeSpotSG | M-TEST, M3 | DONE |

## Interface Contracts

### 1. `GET /api/safespot/shadow-pairs`
- **Response**:
  ```json
  {
    "corridors": [
      {
        "id": "toa-payoh-to-raffles-place",
        "name": "Toa Payoh to Raffles Place (CBD)",
        "origin": { "lat": 1.3327, "lng": 103.8479, "name": "Blk 480 Toa Payoh" },
        "destination": { "lat": 1.2840, "lng": 103.8514, "name": "Raffles Place" },
        "expectedDivergence": true
      },
      {
        "id": "novena-to-mbs",
        "name": "Novena to Marina Bay Sands",
        "origin": { "lat": 1.3204, "lng": 103.8438, "name": "Novena" },
        "destination": { "lat": 1.2834, "lng": 103.8607, "name": "Marina Bay Sands" },
        "expectedDivergence": true
      }
    ]
  }
  ```

### 2. `GET/POST /api/safespot/corridor-diff?corridorId={id}`
- **Response**:
  ```json
  {
    "corridorId": "novena-to-mbs",
    "safespotRoute": {
      "distanceMeters": 6580,
      "durationSeconds": 870,
      "coordinates": [[103.8438, 1.3204], ...],
      "edges": [
        { "name": "Ophir Road", "speedKmh": 45, "delaySeconds": 12, "coordinates": [...] }
      ]
    },
    "referenceRoute": {
      "source": "google_or_osrm",
      "distanceMeters": 8746,
      "durationSeconds": 1050,
      "coordinates": [[103.8438, 1.3204], ...]
    },
    "divergence": {
      "isDivergent": true,
      "maxSeparationMeters": 2166,
      "divergentSpans": [
        {
          "startMeters": 1420,
          "endMeters": 5890,
          "maxSeparationMeters": 2166,
          "startCoord": [103.8550, 1.3050],
          "endCoord": [103.8600, 1.2850]
        }
      ]
    }
  }
  ```

### 3. `POST /api/safespot/pickup-sim`
- **Request**:
  ```json
  {
    "seniorLocation": { "lat": 1.3327, "lng": 103.8479 },
    "driverLocation": { "lat": 1.3400, "lng": 103.8500 },
    "isRaining": true
  }
  ```
- **Response**:
  ```json
  {
    "isRaining": true,
    "candidates": [
      {
        "id": "stand-1",
        "name": "Toa Payoh Central Taxi Stand",
        "type": "taxi_stand",
        "location": { "lat": 1.3330, "lng": 103.8485 },
        "score": 340,
        "rankingReason": "Covered linkway connection, barrier-free access",
        "driverEtaSeconds": 240,
        "seniorWalkSeconds": 180,
        "shelteredPercentage": 92,
        "walkingPath": [[103.8479, 1.3327], ...]
      }
    ]
  }
  ```

### 4. `GET /api/safespot/wearable-status` & WebSocket `/api/safespot/telemetry-ws`
- **Schema**:
  ```json
  {
    "deviceId": "fenix6pro-solar-asia",
    "timestamp": 1729497600000,
    "eventType": "HEARTBEAT",
    "fusedLocation": {
      "lat": 1.3327,
      "lng": 103.8479,
      "altitudeMeters": 38.4,
      "accuracyMeters": 4.5,
      "source": "watch_gps",
      "floorsAbove": 3
    },
    "sensors": {
      "watchGps": { "lat": 1.33272, "lng": 103.84791, "accuracy": 10 },
      "phoneGps": { "lat": 1.33268, "lng": 103.84785, "accuracy": 25 },
      "bleBeacon": null,
      "barometerPressurePa": 100840,
      "heartRate": 74,
      "battery": 88
    }
  }
  ```
