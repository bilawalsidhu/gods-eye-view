# CLAUDE.md — God's Eye View (GEV)

This file provides comprehensive context, architectural rules, workflow commands, and design principles for **Claude Code** when working in the God's Eye View repository.

---

## 1. Project Overview & Philosophy

**God's Eye View (GEV)** is an open-source, browser-based, real-time spatial intelligence (GEOINT/OSINT) console for planet Earth. It renders a photorealistic 3D globe with live tracking of civil and military aircraft, maritime vessels, orbital satellites, seismic events, CCTV cameras, public transit, wildfires, rocket launches, and critical infrastructure.

### Core Tenets

1. **No Heavy Frontend Frameworks**: Built with Vanilla ES Modules, [CesiumJS](https://cesium.com/), and [Vite](https://vitejs.dev/). **Never** introduce React, Vue, Angular, or Tailwind CSS unless explicitly instructed by the user.
2. **Strict Separation of Concerns**: Data acquisition, portable normalization, Cesium rendering, DOM UI facades, and server middleware must remain decoupled.
3. **Local-First & Keyless Baseline**: The application must run without mandatory API keys or paid accounts (defaults to Esri satellite imagery, keyless terrain, open-source ADS-B, USGS, CelesTrak, GBFS). Paid keys (Cesium ion, Google Photorealistic 3D, OpenAI Realtime) are strictly optional enhancements.
4. **Server-Brokered Secrets**: Client-side code never possesses private API keys (OpenAI, AISStream, OpenSky OAuth). Private credentials pass through local Node/Vite proxy middleware with SSRF prevention and URL allowlists.
5. **Strict Ethical Boundary**: GEV models vehicles, natural events, assets, and infrastructure. It strictly forbids tracking named individuals, facial recognition, or personal surveillance features.

---

## 2. Common Commands

### Development & Execution

```bash
npm run dev              # Start Vite dev server on http://localhost:4173
npm run doctor           # Validate Node.js version, providers, and environment setup
npm run build            # Full production build into dist/
npm run preview          # Preview the production bundle locally
```

### Testing & Verification

```bash
npm test                 # Run all unit tests via Node built-in test runner (~4,000+ tests)
npm run check:boundaries # Verify architectural import direction gates and module boundaries
npm run format:check     # Check code formatting with Prettier
npm run format           # Auto-format all source files with Prettier
```

### Running Targeted Single Tests

All tests use Node's native test runner (`node:test` + `node:assert/strict`):

```bash
node test/jarvisMemory.test.mjs          # Persistent memory & reasoning tests
node test/nvidiaAssistant.test.mjs       # AI model routing & assistant tests
node src/jarvisSystemTools.test.mjs      # System command & hardware telemetry tests
node src/ui/aiCommandCenter.test.mjs     # AI Command Center UI & reasoning traces
node src/setupDoctor.test.mjs            # Setup doctor diagnosis tests
```

---

## 3. Directory Structure & Subsystem Ownership

| Directory            | Subsystem / Responsibility                                                      | Environment                  |
| :------------------- | :------------------------------------------------------------------------------ | :--------------------------- |
| `src/app/`           | Lifecycle controller (`createApplication`), viewer factory, core service wiring | Browser (Framework-agnostic) |
| `src/standalone/`    | Standalone composition, default layer catalog, setup controls, DOM binding      | Browser (Page-scoped)        |
| `src/ui/`            | Navigation, HUD, command center, display panels, modal dialogs, styles          | Browser (DOM / Canvas)       |
| `src/data/`          | Context store, feed lifecycle, motion models, detection/label arbiters          | Portable / Browser           |
| `src/layers/`        | Dedicated Cesium domain layers (flights, vessels, satellites, cctv, transit)    | Browser (CesiumJS)           |
| `src/sources/`       | Portable protocol adapters, feed normalizers (**zero DOM/Cesium imports**)      | Portable (Node / Browser)    |
| `src/services/`      | Shared domain services (terrain sampling, ground floor clamping, geocoding)     | Browser / Portable           |
| `src/voice/`         | OpenAI Realtime WebRTC session, NVIDIA voice adapter, tool dispatching          | Browser (WebRTC / Web Audio) |
| `src/styles/`        | GLSL post-processing fragment shaders (CRT, NVG, FLIR, Thermal, Noir)           | WebGL / GLSL                 |
| `server/providers/`  | Node.js proxy endpoints (AISStream WS bridge, OpenSky, JARVIS tools, AI)        | Node.js / Vite middleware    |
| `server/standalone/` | Root `.env` configuration, credential hardening, Pinokio integration            | Node.js                      |
| `tools/`             | Standalone CLI utilities (e.g. `sat-ortho.mjs` for satellite tile stitching)    | Node.js CLI                  |

---

## 4. Architectural Rules & Import Direction Gates

Run `npm run check:boundaries` to verify boundary compliance. The following rules are strictly enforced:

1. **Portable Graph Rule**: Modules in `src/sources/*`, `src/layers/*/source*`, and action schemas **cannot** import Cesium, DOM globals (`window`, `document`), or Node modules.
2. **Client-Server Separation**: Browser code (`src/*`) cannot import Node/server modules. Server code (`server/*`) cannot import browser or Cesium modules.
3. **Four-Phase IoC Startup Lifecycle (`src/app/application.js`)**:
   ```
   [createScene] ──► [createControls] ──► [createData] ──► [createTools] ──► [READY]
   ```
   - Construction is triggered via `app.start()`.
   - Every acquired resource registers a cleanup callback via `defer(cleanupFn)`.
   - Teardown executes in reverse phase order (**Tools $\rightarrow$ Controls $\rightarrow$ Data $\rightarrow$ Scene**) using LIFO (Last In, First Out).

---

## 5. Key Subsystems & Implementations

### JARVIS AI Command Center & Tools (`server/providers/jarvis-tools.js`, `src/ui/aiCommandCenter.js`)

- **Tool Schemas**: Declared in `JARVIS_TOOL_SCHEMAS`. AI models invoke tools for code execution, system commands, screenshot capture, clipboard management, and persistent memory.
- **Persistent Memory**: Stored in `.jarvis-workspace/.memory.json`. Supports `category` classification (`tactical`, `preferences`, `mission`, `system`), `tags`, hierarchical relevance scoring (`searchMemory`), and diagnostics (`getMemoryStats`).
- **Multimodel Reasoning Traces**: `extractThinking` and `formatMarkdown` in `aiCommandCenter.js` extract `<think>`, `<thought>`, and `<reasoning>` traces, displaying clean output with collapsible thought accordions.
- **Audio & Voice**: `playAudioCue` uses a pooled `AudioContext` singleton to prevent browser context exhaustion. Speech synthesis in `src/voice/nvidiaSession.js` cleans XML tags, code blocks, and emojis before synthesis.

### Satellite Orthophoto Tool (`tools/sat-ortho.mjs`)

- Fetches satellite imagery tiles from the Google Map Tiles API and stitches them into a single high-resolution ortho image centered on a given latitude/longitude.
- Usage: `node tools/sat-ortho.mjs --lat <lat> --lon <lon> --zoom 21 --size 2048 --outdir output/`

---

## 6. Coding Conventions for Claude Code

- **File Extensions**: Use `.js` for browser ES modules; use `.mjs` for Node.js scripts, tools, and unit tests.
- **Imports**: Use standard ES module syntax (`import ... from '...'`) with explicit file extensions.
- **Testing**: Use `node:test` and `node:assert/strict`. Keep tests fast, deterministic, and isolated.
- **Formatting**: Ensure files pass `npm run format:check`. Run `npm run format` to auto-format.
- **Do Not Break Gates**: Before completing changes, always verify:
  1. `npm run check:boundaries`
  2. `npm run format:check`
  3. Relevant targeted tests or `npm test`
