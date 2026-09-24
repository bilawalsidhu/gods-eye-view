---
name: gev-doctor
description: Diagnose God's Eye View setup — check Node version, provider keys, env vars, and running services. Use when the app is misbehaving or a data layer is failing.
disable-model-invocation: false
---

# GEV Doctor

Diagnose the God's Eye View environment and report what is misconfigured.

## Steps

1. **Node version**

   ```bash
   node --version
   ```

   Must be Node 24 (allocation budgets are calibrated to it).

2. **Required env vars**
   Check these and report which are set vs missing:
   - `NVIDIA_API_KEY` — AI chat
   - `OPENAI_API_KEY` — realtime voice
   - `AISSTREAM_API_KEY` — live vessel tracking
   - `FIRMS_MAP_KEY` — NASA fire data
   - `TOMTOM_API_KEY` — live traffic
   - `CESIUM_ION_TOKEN` — 3D globe
   - `GOOGLE_MAPS_API_KEY` — places/geocoding

3. **Provider status**

   ```bash
   curl -s http://localhost:4173/api/nvidia/status
   curl -s http://localhost:4173/api/setup/status
   ```

   Report which AI providers are configured.

4. **Data layer probe**
   Check each layer's API:

   ```bash
   curl -s -o /dev/null -w "%{http_code}" http://localhost:4173/api/ais-live
   curl -s -o /dev/null -w "%{http_code}" http://localhost:4173/api/firms
   curl -s -o /dev/null -w "%{http_code}" http://localhost:4173/api/transit/vehicles/mbta
   curl -s -o /dev/null -w "%{http_code}" http://localhost:4173/api/launches
   ```

5. **Dev server**
   Check if `npm run dev` is running on port 4173.

## Output

Report a table:

| Check         | Status          | Detail  |
| ------------- | --------------- | ------- |
| Node          | OK/WRONG        | version |
| NVIDIA key    | SET/MISSING     | —       |
| OpenAI key    | SET/MISSING     | —       |
| AISStream key | SET/MISSING     | —       |
| FIRMS key     | SET/MISSING     | —       |
| TomTom key    | SET/MISSING     | —       |
| Cesium token  | SET/MISSING     | —       |
| Google key    | SET/MISSING     | —       |
| AI providers  | N configured    | list    |
| AIS live      | 200/503         | —       |
| FIRMS         | 200/503         | —       |
| Transit       | 200/503         | —       |
| Launches      | 200/503         | —       |
| Dev server    | RUNNING/STOPPED | —       |

Then list recommended actions: which keys to add, which services to start.
