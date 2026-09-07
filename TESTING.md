# Testing guide

## Automated gates

Use Node.js 24.14+ or Node.js 26 and run:

```sh
npm test
npm run server:check
npm run build
```

`npm test` runs browser-independent unit tests. `server:check` compiles the
Fastify BFF and verifies its Azure Maps, Foundry, AIS, status, security, and
17-route production compatibility contracts. `build` verifies the Vite/Cesium
browser bundle.

For the tracking regression harness, start the app first and run:

```sh
npm run dev
npm run test:track
```

Vite is `http://localhost:4173`; the BFF is `http://localhost:3000`.

## Local Azure setup

Run `az login` so `DefaultAzureCredential` can use the Azure CLI session.
Configure `AZURE_MAPS_CLIENT_ID`, plus `FOUNDRY_ENDPOINT`,
`FOUNDRY_REALTIME_DEPLOYMENT`, and `FOUNDRY_HUD_DEPLOYMENT` when exercising
those capabilities. Persistent Azure credentials and managed-identity tokens
must not appear in browser responses.

The map acceptance path is Azure Satellite, Hybrid, or Streets through the BFF.
When Azure Maps is unavailable, OpenStreetMap is the expected honest fallback;
Re:Earth terrain or Cesium's ellipsoid fallback keeps the globe usable.

## Focus and visual evidence

With the app already running:

```sh
node scripts/qa-focus-evidence.mjs --url http://localhost:4173 \
  --basemap azure-satellite \
  --screenshots-dir qa-shots/focus-evidence \
  --json qa-shots/focus-evidence/report.json
```

Accepted basemaps are `azure-satellite`, `azure-hybrid`, `azure-streets`, and
`osm`. Add `--headful` for real-GPU visual sign-off; headless runs use
SwiftShader for relative CI evidence.

## Voice and HUD

Foundry contract tests are deterministic and mock the BFF adapter. A live manual
voice test requires configured Foundry deployments:

1. Open `http://localhost:4173`.
2. Select **GEV MIC**, grant microphone access, and wait for **LISTENING**.
3. Try a navigation command, an annotation, and a layer toggle.
4. Confirm only successful actions are acknowledged.
5. Stop the session and confirm maps and Drone View remain usable.

Without Foundry, voice and AI HUD summaries must report unavailable while the
rest of the app continues normally.

## AISStream and retained providers

Use `AISSTREAM_API_KEY` only in the BFF environment. In Azure it comes from Key
Vault; locally it may come from an untracked `.env`. Missing AISStream, FIRMS,
TomTom, or OpenSky credentials must produce explicit degraded states rather
than application failure.
