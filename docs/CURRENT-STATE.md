# SatView current runtime

## Browser and BFF boundary

The browser is a CesiumJS application. Azure access is exclusively same-origin:

- `/api/azure/maps/tile` and `/api/azure/maps/attribution` broker Azure raster
  bytes and view-dependent attribution.
- `/api/azure/maps/search`, `/reverse-geocode`, and `/route` return normalized
  map data used by navigation, annotations, routes, and scene context.
- `/api/azure/foundry/realtime/client-secret` returns a short-lived client
  secret and Azure endpoint for WebRTC negotiation.
- `/api/azure/foundry/hud-summary` brokers HUD summaries.
- `/api/ais-live` is served by the BFF.

Persistent Azure credentials, managed-identity tokens, and shared keys never
enter browser responses. The BFF uses `DefaultAzureCredential`; local
development normally uses Azure CLI authentication and deployed environments
use managed identity. Production ingress uses Entra authentication for the
whole application, not provider-specific browser login.

`npm run dev` starts the BFF at `http://localhost:3000` and Vite at
`http://localhost:4173`. Vite forwards `/api/azure`, `/api/ais-live`,
`/api/foundry`, and `/api/status` to the BFF. Retained Vite-only data proxies
continue to run directly.

## Globe and map stacks

The viewer always uses the Cesium globe and Re:Earth quantized-mesh terrain.
The map tray contains:

1. Azure Satellite (startup default)
2. Azure Hybrid (satellite base plus raster road-label overlay)
3. Azure Streets
4. OpenStreetMap fallback

All Azure imagery requests are built by `src/azure/mapsImagery.js` and target
the BFF. Startup probes the attribution endpoint; a missing or unhealthy Maps
capability falls back to OSM rather than showing a blank or incorrectly
labelled source. Runtime tile failures also trigger the same fallback.

## Microsoft Foundry

`src/azure/foundryClient.js` obtains an ephemeral realtime secret and constructs
the Azure WebRTC calls URL. The voice controller negotiates SDP with the
returned endpoint and sends its supported tool schema over the data channel.
Model deployment selection remains server-owned.

The browser retains provider-neutral response token counts for diagnostics.
It does not show model tiers or client-side pricing. Voice tools cover supported
navigation, map stacks, data layers, context, tracking, HUD, and annotations.
Drone View remains fully available in its existing UI; voice mission control is
deferred until `DroneMissionController` exposes a small atomic command contract.

## Degradation

- Azure Maps unavailable: Re:Earth terrain remains and imagery switches to OSM.
- Foundry unavailable: voice and AI HUD summary degrade without affecting maps
  or retained data layers.
- Re:Earth unavailable: Cesium's ellipsoid terrain fallback keeps the globe
  usable.
- AIS unavailable: the BFF returns an explicit unavailable feed state.

In Azure, the AISStream shared credential is stored in Key Vault and projected
into the BFF through a managed-identity-authorized secret reference. Local
development may use `AISSTREAM_API_KEY` from an untracked `.env`.

The first-run launcher intentionally follows exclusive UI surfaces: a surface class that never clears means no launcher for that page, not a delayed timer.

## Validation

Use:

```bash
npm test
npm run server:check
npm run build
```
