# God's Eye View (GEV) — Comprehensive Agent & System Context

This document provides a complete, authoritative reference of the **God's Eye View** codebase, including its architecture, core algorithms, data structures, mathematical models, rendering pipelines, server proxies, and operational policies. It is designed to provide full context to any AI agent, LLM, or developer working with or extending the project.

---

## 1. Project Overview & Design Philosophy

### 1.1 What is God's Eye View?

God's Eye View (GEV) is an open-source, browser-based, real-time spatial intelligence (GEOINT/OSINT) console for planet Earth. It renders a photorealistic 3D globe with live tracking of commercial & military aircraft, maritime vessels, orbital satellites, seismic events, public traffic cameras, public transit, active wildfires, rocket launches, and static infrastructure. It includes hands-free voice control powered by real-time conversational AI models.

### 1.2 Core Architectural Principles

- **No Heavy Frontend Framework**: Built with Vanilla ES Modules, [CesiumJS](https://cesium.com/), and [Vite](https://vitejs.dev/). No React, Vue, Angular, or Tailwind.
- **Strict Separation of Concerns**: Clean boundaries between data acquisition, portable normalization, Cesium rendering, UI facades, and server middleware.
- **Local-First & Keyless Baseline**: The app runs locally without mandatory accounts or keys (using Esri Satellite imagery, keyless terrain, open-source ADS-B, USGS, CelesTrak, GBFS, etc.). Paid/metered keys (Cesium ion, Google Photorealistic 3D, OpenAI Realtime) are optional drop-in upgrades.
- **Server-Brokered Secrets**: Client-side code never possesses server API secrets (OpenAI, AISStream, OpenSky OAuth). Requests requiring private credentials pass through local Node/Vite proxy middleware with SSRF prevention and response validation.
- **Ethical Boundary**: GEV models events, vehicles, assets, infrastructure, and natural systems. It strictly forbids named-person tracking, facial recognition, or personal surveillance features.

---

## 2. Directory Structure & Subsystem Ownership

| Directory            | Subsystem Responsibility                                                                             | Platform / Environment       |
| :------------------- | :--------------------------------------------------------------------------------------------------- | :--------------------------- |
| `src/app/`           | Application lifecycle controller (`createApplication`), viewer factory, core service wiring.         | Browser (Framework-agnostic) |
| `src/standalone/`    | Standalone composition: default layer catalog, local sources, setup controls, DOM binding.           | Browser (Page-scoped)        |
| `src/ui/`            | Navigation authority, visual styles, HUD, display panels, modal dialogs, share link restoration.     | Browser (DOM / Canvas)       |
| `src/data/`          | Global context store, lifecycle transitions, feed states, motion models, detection arbiters.         | Portable / Browser           |
| `src/layers/`        | Dedicated domain layers (aircraft, vessels, satellites, cctv, transit, traffic, etc.).               | Browser (CesiumJS)           |
| `src/sources/`       | Portable protocol adapters, endpoint definitions, data normalization (zero DOM/Cesium dependencies). | Portable (Node / Browser)    |
| `src/services/`      | Shared domain services: terrain sampling, ground floor clamping, geocoding, routing.                 | Browser / Portable           |
| `src/voice/`         | OpenAI Realtime WebRTC session, tool schema registry, execution engine, cost tracker.                | Browser (WebRTC / Web Audio) |
| `src/styles/`        | GLSL fragment shaders for screen-space post-processing presets (CRT, NVG, FLIR, Anime, Noir).        | WebGL / GLSL                 |
| `server/providers/`  | Node.js proxy endpoints (AISStream WS bridge, OpenSky, TomTom, Overpass, JARVIS tools).              | Node.js / Vite middleware    |
| `server/standalone/` | Root `.env` configuration, credential hardening, Pinokio environment integration.                    | Node.js                      |

---

## 3. Application Lifecycle & Architecture

### 3.1 Four-Phase IoC Startup Lifecycle (`src/app/application.js`)

Application construction is inactive upon import. Construction is triggered via `app.start()` and executes across four strictly ordered phases:

```
[createScene] ──► [createControls] ──► [createData] ──► [createTools] ──► [READY]
```

1. **`createScene({ signal, defer })`**: Instantiates Cesium viewer, credit container, base imagery/terrain, and request/caching services.
2. **`createControls({ scene, signal, defer })`**: Builds camera controllers, visual style managers, and presentation managers.
3. **`createData({ scene, controls, signal, defer })`**: Registers layer catalogs, data sources, lifecycle managers, and context stores.
4. **`createTools({ scene, controls, data, signal, defer })`**: Registers scene director, whiteboard annotations, voice sessions, and DOM event listeners.

### 3.2 LIFO Teardown Contract

- `defer(cleanupFn)` is called immediately upon resource acquisition within each constructor.
- Teardown executes in reverse phase order: **Tools $\rightarrow$ Controls $\rightarrow$ Data $\rightarrow$ Scene**.
- Teardown callbacks within each phase execute in reverse registration order (LIFO).
- `app.destroy()` aborts the shared `AbortSignal`, waits for pending constructors to settle, and executes all registered cleanups.

### 3.3 Strict Import Direction Gates (`npm run check:boundaries`)

- Portable source graphs (`src/sources/*`, `src/layers/*/source*`, action schemas) **cannot** import Cesium, DOM globals (`window`, `document`), or Node modules.
- Browser modules cannot import server or Node runtime files.
- Provider modules cannot import application/rendering modules.

---

## 4. Mathematical & Geospatial Algorithms

### 4.1 Coordinate Reference Systems & Geodesics

- **Earth Ellipsoid**: WGS84 standard ($a = 6378137.0\text{ m}$, $f = 1 / 298.257223563$, mean radius $R = 6371008.8\text{ m}$).
- **Great-Circle Distance (Haversine Formula)**:
  $$\Delta\sigma = 2 \arcsin\left(\sqrt{\sin^2\left(\frac{\Delta\phi}{2}\right) + \cos\phi_1 \cos\phi_2 \sin^2\left(\frac{\Delta\lambda}{2}\right)}\right), \quad d = R \cdot \Delta\sigma$$
- **Great-Circle Waypoint Extrapolation (`extrapolateGreatCircle`)**:
  Calculates $(\phi_2, \lambda_2)$ given $(\phi_1, \lambda_1)$, initial bearing $\theta$, and surface distance $d$:
  $$\phi_2 = \arcsin\left(\sin\phi_1 \cos\delta + \cos\phi_1 \sin\delta \cos\theta\right)$$
  $$\lambda_2 = \lambda_1 + \operatorname{atan2}\left(\sin\theta \sin\delta \cos\phi_1, \; \cos\delta - \sin\phi_1 \sin\phi_2\right) \quad \text{where } \delta = \frac{d}{R}$$
- **Initial Great-Circle Bearing (`bearingBetweenCoordinates`)**:
  $$\theta = \operatorname{atan2}\left(\sin\Delta\lambda \cos\phi_2, \; \cos\phi_1 \sin\phi_2 - \sin\phi_1 \cos\phi_2 \cos\Delta\lambda\right) \pmod{360^\circ}$$
- **EGM96 Geoid to WGS84 Ellipsoid Altitude**:
  Aviation ADS-B reports barometric or geometric altitude relative to Mean Sea Level (MSL / EGM96 Geoid). GEV uses `egm96-universal` spherical harmonic expansion to evaluate geoid undulation $N(\phi, \lambda)$:
  $$h_{\text{ellipsoid}} = H_{\text{orthometric (MSL)}} + N(\phi, \lambda)$$

---

### 4.2 World-Stable Screen-Projected Heading (`src/data/iconOrientation.js`)

Billboards in CesiumJS are screen-aligned 2D quads. To make aircraft and ships point along their true physical heading across all pitch angles, nadir views, and orbiting tracked cameras:

1. A forward probe vector is constructed in local East-North-Up (ENU) space:
   $$\vec{v}_{\text{ENU}} = \begin{bmatrix} \sin(\theta_{\text{course}}) \cdot R_{\text{probe}} \\ \cos(\theta_{\text{course}}) \cdot R_{\text{probe}} \\ 0 \end{bmatrix}, \quad R_{\text{probe}} = 2000\text{ m}$$
2. The ENU vector is transformed into world Cartesian3 coordinates via the local tangent plane matrix:
   $$\mathbf{M}_{\text{ENU}\to\text{ECEF}} = \operatorname{eastNorthUpToFixedFrame}(\mathbf{P}_{\text{entity}})$$
   $$\vec{v}_{\text{world}} = \mathbf{M}_{\text{ENU}\to\text{ECEF}} \cdot \vec{v}_{\text{ENU}}$$
3. $\vec{v}_{\text{world}}$ is projected directly onto the camera's orthonormal basis vectors ($\vec{R}_{\text{WC}}$ right, $\vec{U}_{\text{WC}}$ up):
   $$dx = \vec{v}_{\text{world}} \cdot \vec{R}_{\text{WC}}, \quad dy = -\left(\vec{v}_{\text{world}} \cdot \vec{U}_{\text{WC}}\right)$$
4. The billboard rotation angle $r$ (radians counter-clockwise) is calculated:
   $$r = \operatorname{atan2}(-dx, -dy)$$
5. **Angular Deadbanding**: To eliminate sub-pixel oscillation, changes below $\Delta\theta_{\text{threshold}} = 0.5^\circ$ are rejected using shortest wrapped angular delta:
   $$\Delta\theta = \operatorname{atan2}\left(\sin(r_{\text{new}} - r_{\text{old}}), \; \cos(r_{\text{new}} - r_{\text{old}})\right)$$
6. **Ellipsoidal Horizon Culling**: Entities occluded by the planetary curvature are culled using `Cesium.EllipsoidalOccluder`.

---

### 4.3 Kinematics, Turn-Rate Estimation & Dead Reckoning (`src/data/motionModel.js`)

GEV operates on a **delayed playback model**: it renders positions one poll interval behind real time, interpolating between historical fixes and extrapolating ahead via constant-rate turn integration.

#### A. Low-Speed Course Blender

To prevent GPS jitter at low speeds (e.g. taxiing or hovering helicopters) from whipping vehicle headings:

- Above $v_{\text{high}} = 25.7\text{ m/s}$ (~50 kt): Heading is derived 100% from the movement chord.
- Below $v_{\text{low}} = 15.4\text{ m/s}$ (~30 kt): Heading uses the reported sensor track only.
- Below $v_{\text{hold}} = 1.5\text{ m/s}$ (~3 kt): Heading updates are frozen to suppress random walk noise.
- Course slew rate is clamped by a speed-dependent limiter:
  $$\text{SlewCap}(v) = \text{MinDPS} + (\text{MaxDPS} - \text{MinDPS}) \cdot \operatorname{Ramp}(v)$$

#### B. Analytical Constant-Rate Turn Arc Integrator (`arcOffsetEnu`)

When dead-reckoning during an active turn with angular velocity $\omega = \frac{d\theta}{dt}$ (rad/s) and speed $v$:

- For straight motion ($|\omega| < 10^{-4}\text{ rad/s}$):
  $$\Delta E = v \sin(\theta) \Delta t, \quad \Delta N = v \cos(\theta) \Delta t$$
- For curved motion ($|\omega| \ge 10^{-4}\text{ rad/s}$):
  $$\Delta E = \frac{v}{\omega} \left(\cos(\theta) - \cos(\theta + \omega \Delta t)\right)$$
  $$\Delta N = \frac{v}{\omega} \left(\sin(\theta + \omega \Delta t) - \sin(\theta)\right)$$
  $$\theta_{\text{end}} = \theta + \omega \Delta t$$

---

### 4.4 Terrain Clamping & Predictive Ground Corridor (`src/services/groundFloor.js`)

To prevent entities from clipping into 3D photorealistic buildings or mountainous terrain:

- **Spatial Grid Quantization**: Coordinates are snapped to a 3-decimal (~111 m) grid (`coarseFloorCoord`), collapsing moving entities and trail waypoints onto a small set of cached elevation keys.
- **Synchronous Cache Queries**: Rendering paths read elevation synchronously from cache; cache misses fire asynchronous background sampling.
- **Predictive Corridor Walk**: For ground contacts, GEV samples ahead along the projected turn arc (`projectGroundArcLatLon`) at 55 m intervals up to 1300 m, pre-warming elevation tiles before the entity reaches them.
- **Surface Elevation Prior Gate**: Measured 3D mesh surface heights are validated against a Digital Elevation Model (DEM) prior within an acceptable window $[-15\text{m}, +80\text{m}]$ to discard raycast misses.

---

### 4.5 Orbital Mechanics & Space Missions (`src/layers/satellites/`, `src/layers/trajectoryPredictor.js`)

- **SGP4 Propagation**: Parses standard Two-Line Element sets (TLE) and evaluates Simplified General Perturbations-4 models (`satellite.js`).
- **GMST Realignment**: Rotates satellite positions from Earth-Centered Inertial (ECI) coordinates to Earth-Centered, Earth-Fixed (ECEF) using Greenwich Mean Sidereal Time (GMST) to keep orbits locked to the rotating globe without drift.
- **Orbital Swath / Sensor Footprint Cone**:
  Calculates the ground visibility radius $r_{\text{footprint}}$ from orbital altitude $h$:
  $$\theta_{\text{cone}} = \arccos\left(\frac{R_{\text{Earth}}}{R_{\text{Earth}} + h}\right), \quad r_{\text{footprint}} = R_{\text{Earth}} \cdot \theta_{\text{cone}}$$
- **ISS Pass Prediction**: Computes observer azimuth, elevation, and range; detects AOS (Acquisition of Signal) when elevation crosses $0^\circ$ ascending, and LOS (Loss of Signal) descending.

---

### 4.6 Cockpit Camera & Follow Dynamics (`src/cockpitMath.js`, `src/cockpitTracking.js`)

- **Inertial Anchor Correction**: Smooths the transition between dead-reckoned forward motion and newly received server fixes:
  $$\Delta_{\text{correction}} = \min\left(d_{\text{error}}, \; d_{\text{error}} \cdot \left(1 - e^{-1.25 \Delta t}\right), \; \max(0.75, 0.22 \cdot v) \cdot \Delta t\right)$$
- **Circular Keyhole Altitude/Speed Tapes**: Altitude and speed tapes render in curved HUD margins. The horizontal inset $x_{\text{inset}}$ for tick slot $y$ is computed via circle geometry:
  $$y_{\text{norm}} = \min(0.92, |y| \cdot 0.16), \quad x_{\text{inset}} = 1 - \sqrt{1 - y_{\text{norm}}^2}$$
- **Terrain Avoidance**: Camera maintains a minimum safe height:
  $$h_{\text{camera}} = \max(h_{\text{proposed}}, \; h_{\text{ground}} + \text{clearance})$$

---

### 4.7 Camera Verbs & Cinematic Routing (`src/cameraVerbs.js`)

Cinematic camera paths along routes implement multi-layered smoothing:

1. **Trapezoid Velocity Profile**: Eased acceleration and deceleration ramps (`ROUTE_RAMP_S = 2.4\text{s}`).
2. **Path Curvature & Banked Turn Roll**: Measures angular turn rate over a 4-second triangular window centered on the camera:
   $$\text{Roll}_{\text{target}} = \text{clamp}\left(\dot{\theta}_{\text{path}} \cdot 0.44^\circ/(\text{deg/s}), \; -10^\circ, \; +10^\circ\right)$$
   Filtered through two cascaded first-order low-pass filters (`ROUTE_BANK_LEAD_RATE = 2.2`, `ROUTE_BANK_SETTLE_RATE = 1.6`) for $C^1$ continuous entry/exit.
3. **Altitude Breathing**: Adds a gentle sinusoidal oscillation on long straight path segments ($\lambda = 2200\text{ m}$, amplitude $= 20\text{ m}$).
4. **Turn Lift**: Elevates the camera by up to 26 m during steep turns to give a sweeping drone perspective.
5. **Lookahead Direction Filter**: Gaze target leads the camera position by 6.5 seconds of travel, smoothed with exponential decay ($\alpha = 1.6\text{ s}^{-1}$).

---

### 4.8 Tactical Detection Mesh & Label Arbiter (`src/data/detection.js`, `src/data/labelArbiter.js`)

Renders screen-space 2D bounding brackets and telemetry callouts over 3D entities:

- **Spatial Partitioning Grid**: Screen space is subdivided into $32 \times 32\text{ px}$ hash buckets. Candidate bounding boxes are pruned via Axis-Aligned Bounding Box (AABB) intersection tests.
- **Layer Quota Allocation**:
  - _Elastic Mode_: Equal distribution across all active layers with greedy water-filling redistribution for underutilized quotas.
  - _Weighted Mode_: Semantic priority weights (Military: 1.4, Traffic: 1.15, CCTV: 1.1, Flights: 1.0, Satellites: 1.0, Bikeshare: 0.9) allocated using the Largest Remainder Method (Hamilton's method).
- **Temporal Hysteresis**: Minimum label lifetime of 2500 ms and cooldown of 1200 ms prevents rapid label flickering or thrashing. Fade-in takes 150 ms; fade-out takes 300 ms.

---

### 4.9 Spatial Awareness & Proximity Engine (`src/data/militaryAwarenessEngine.js`, `src/layers/geofenceEngine.js`)

- **Doubling-Radius Nearest Neighbor Search**: Searches concentric spheres expanding from 250 km ($r_{\text{initial}}$) up to 16,000 km ($r_{\text{max}}$), doubling the radius on each miss:
  $$r_{k+1} = \min(2 \cdot r_k, \; 16000\text{ km})$$
- **Point-in-Polygon (Jordan Curve Ray-Casting)**:
  Tests whether coordinate $(\phi, \lambda)$ breaches an arbitrary polygonal perimeter zone by casting a horizontal ray to infinity and counting edge crossings:
  $$\text{intersect} \iff (y_i > \phi \neq y_j > \phi) \land \left(\lambda < \frac{(x_j - x_i)(\phi - y_i)}{y_j - y_i} + x_i\right)$$

---

### 4.10 CCTV Frustum & Footprint Geometry (`src/data/cctvViewshed.js`, `src/data/cctvFootprint.js`)

- **3D Frustum Mesh**: Constructed from 5 vertices (mount apex, top-left, top-right, bottom-right, bottom-left) forming 6 triangles (4 side rays + 2 far-plane triangles).
- **3x3 Monitor Plane Ground Support**:
  For a camera pose (heading $\theta$, pitch $\alpha$, horizontal FOV $\text{hFov}$, range $R$):
  $$\text{halfW} = R \tan\left(\frac{\text{hFov}}{2}\right), \quad \text{vFov} = 2 \arctan\left(\frac{\tan(\text{hFov}/2)}{16/9}\right), \quad \text{halfH} = R \tan\left(\frac{\text{vFov}}{2}\right)$$
  Calculates ground support points on a $3 \times 3$ grid to project and drape camera video onto 3D surfaces.
- **Golden-Angle Camera Hues**: Deterministic color assignment based on camera index in sorted catalog:
  $$\text{Hue}_i = (i \cdot 137.507764^\circ) \pmod{360^\circ}$$
  Maximizes perceptual distinction between adjacent cameras in dense urban clusters.

---

### 4.11 GLSL Post-Processing Pipeline (`src/styles/`, `src/ui/visualEffects.js`)

Screen-space post-processing shaders integrated with Cesium's `PostProcessStageComposite`:

- **CRT / Retro (`retro.js`)**: Radial barrel distortion, CRT phosphor triad mask, horizontal scanlines with vertical roll instability, chromatic aberration (RGB barrel offsets), phosphor decay bloom.
- **Night Vision / Surveillance (`surveillance.js`)**: Green monochrome phosphorescence LUT, high-frequency animated film grain / scintillation, vignetting, scanlines, bloom overload.
- **FLIR / Thermal (`thermal.js`)**: Luminance extraction remapped through Ironbow, White-Hot, or Black-Hot palettes, Sobel/Laplacian edge enhancement, heat gradient pseudo-shading.
- **Transitions**: 500 ms smooth cosine cross-fades between shader stages.

---

## 5. Data Feeds, Layer Catalogs & Schemas

| Layer Identifier   | Data Source / Provider                                 | Ingestion Protocol           | Update Cadence        | Keyless Path?               |
| :----------------- | :----------------------------------------------------- | :--------------------------- | :-------------------- | :-------------------------- |
| `flights`          | OpenSky Network & adsb.lol                             | REST (JSON)                  | 15–30s                | Yes (Anon) / Optional OAuth |
| `military`         | adsb.lol                                               | REST (JSON)                  | 10–15s                | Yes                         |
| `ais-live-vessels` | AISStream                                              | WebSocket                    | Real-time             | Free API Key Required       |
| `satellites`       | CelesTrak                                              | TLE text files               | Daily cache           | Yes                         |
| `earthquakes`      | USGS                                                   | GeoJSON                      | 60s                   | Yes                         |
| `cctv`             | Municipal & DOT feeds (Austin, London, Caltrans, etc.) | Static catalog + image proxy | On-demand             | Yes                         |
| `traffic`          | OpenStreetMap + TomTom Flow                            | Vector tiles / REST          | Simulated + live flow | Yes (Sim) / TomTom key      |
| `transit`          | GTFS-Realtime                                          | Protocol Buffers (`pbf`)     | 15–30s                | Yes                         |
| `firms`            | NASA FIRMS (VIIRS/MODIS)                               | CSV                          | 10–15 min             | Free API Key Required       |
| `radio`            | Radio Browser                                          | REST / HTTP Audio            | On-demand stream      | Yes                         |
| `launches`         | Launch Library 2                                       | REST (JSON)                  | 60s                   | Yes                         |
| `bikeshare`        | GBFS                                                   | REST (JSON)                  | 60s                   | Yes                         |
| `infrastructure`   | Bundled Datasets (Dams, Cables, Datacenters)           | GeoJSON                      | Static                | Yes                         |

---

## 6. Voice Agent & JARVIS Tool Execution Engine

### 6.1 Voice System Architecture (`src/voice/`)

- **Protocol**: OpenAI Realtime API over WebRTC data channels.
- **Audio Pipeline**: Web Audio API with microphone echo cancellation and noise suppression. Push-to-talk and voice-activity detection (VAD).
- **Cost Governor (`voiceCost.js`)**: Live session spending monitor based on token counters and audio duration, featuring a $2 alert and a $5 hard disconnect limit.

### 6.2 Voice Action Schemas & Dispatcher (`src/voice/actionSchemas.js`, `gevActions.js`)

Voice tools are declared with strict JSON schemas and dispatched by `gevActions.js`. Key categories:

1. **Camera Operators**: `move_camera`, `fly_to_location`, `orbit_target`, `set_view_scale`, `fly_route`.
2. **Layer Toggles**: `toggle_layer`, `set_layer_opacity`, `set_visual_style`.
3. **Analyst Interrogators**: `count_entities_in_area`, `find_nearest_entity`, `get_entity_telemetry`, `query_iss_pass`.
4. **World Annotations**: `draw_boundary_polygon`, `draw_route_line`, `place_pin`, `clear_annotations`.
5. **Tactical Operations**: `track_entity`, `enter_cockpit`, `cycle_contacts`, `tune_radio_station`.

### 6.3 JARVIS Server Execution Engine (`server/providers/jarvis-tools.js`)

Server-side agent capabilities for autonomous analysis and local system integration:

- **Sandboxed Code Execution**: Executes JavaScript, TypeScript, Python, PowerShell, or Bash in isolated child processes with a 30s timeout and 64KB output caps.
- **Hardware Telemetry**: Reads host CPU, RAM, disk, battery, and visible desktop windows.
- **Computer Vision**: Screenshot capture and multimodal inspection via Vision APIs.
- **Persistent Memory**: Key-value knowledge graph stored in `.jarvis-workspace/.memory.json`.

---

## 7. Security Architecture & Threat Mitigation

- **No Remote Credential Exposure**: API keys (OpenAI, AISStream, OpenSky) are saved to root `.env` or `pinokio/ENVIRONMENT` with owner-only file permissions (`0600`) and are never sent to the browser.
- **SSRF Defense**: Proxies for CCTV, transit, and external APIs strictly validate URLs against allowlists, enforce HTTPS, and block loopback (`127.0.0.1`), link-local (`169.254.0.0/16`), and private RFC 1918 subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`).
- **Quota & Budget Governors**: Built-in request coalescing, tile request limits, and API request caps prevent unexpected provider billing surges.
- **LAN Security**: Provider key management is strictly bound to `localhost` and locked when the server is run with `--host 0.0.0.0`.

---

## 8. Development, Testing & Verification Commands

- **Environment Doctor**: `npm run doctor` (validates Node.js version, provider routes, environment configurations).
- **Development Server**: `npm run dev` (starts Vite dev server on `http://localhost:4173`).
- **Unit & Math Tests**: `npm run test` (executes Node test runner across all `*.test.mjs` test suites).
- **Architectural Boundary Check**: `npm run check:boundaries` (verifies import directions and package boundaries).
- **Code Formatter**: `npm run format:check` / `npm run format` (checks or writes Prettier formatting across scoped files).
- **Full Production Build**: `npm run build` (builds the optimized client bundle into `dist/`).
