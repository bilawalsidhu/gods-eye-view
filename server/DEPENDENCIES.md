# Coordinator package manifest additions

Merge these entries into the root `package.json`; do not replace existing entries.
Move the existing `ws` entry from `devDependencies` to `dependencies`; do not
leave it duplicated.

## scripts

```json
{
  "server:dev": "tsx watch server/src/main.ts",
  "server:build": "tsc -p server/tsconfig.json",
  "server:start": "node server/dist/main.js",
  "server:test": "npm run server:build && node --test server/test/*.test.mjs",
  "server:check": "npm run server:test",
  "build:container": "npm run build && npm run server:build"
}
```

## dependencies

```json
{
  "@azure/identity": "^4.13.0",
  "@azure/monitor-opentelemetry": "^1.14.0",
  "@fastify/helmet": "^13.0.2",
  "@fastify/static": "^8.3.0",
  "fastify": "^5.6.2",
  "ws": "^8.18.3"
}
```

## devDependencies

```json
{
  "@types/node": "^24.10.1",
  "@types/ws": "^8.18.1",
  "tsx": "^4.20.6",
  "typescript": "^5.9.3"
}
```

After merging, run `npm install` to update `package-lock.json`, then
`npm run server:check`. Tests use Node's built-in test runner against the
compiled server output.

## Runtime configuration

Azure service authentication uses `DefaultAzureCredential`; never add service
keys. ACA sets `AZURE_CLIENT_ID` for its user-assigned managed identity.

Required in the deployed environment:

- `APPLICATIONINSIGHTS_CONNECTION_STRING` (resource routing metadata; Entra ID
  remains the telemetry authentication mechanism)
- `AZURE_MAPS_CLIENT_ID`
- `FOUNDRY_ENDPOINT`, `FOUNDRY_REALTIME_DEPLOYMENT`, and
  `FOUNDRY_HUD_DEPLOYMENT`
- `COMPATIBILITY_MODULE_PATH` (required in production; see
  `server/compat/INTEGRATION.md`)

Optional AIS provider configuration:

- `AISSTREAM_URL` (defaults to `wss://stream.aisstream.io/v0/stream`)
- `AISSTREAM_API_KEY` via an ACA Key Vault secret reference only

## Required retained-app integration

Before producing a production image:

1. Extract the retained Vite `/api` handlers into
   `server/compat/retained-api.mjs` as described by
   `server/compat/INTEGRATION.md`. The BFF intentionally fails production
   startup without this module.
2. Update `src/azure/mapsImagery.js` to use
   `/api/azure/maps/tile` and `/api/azure/maps/attribution`; direct Maps token
   routes now return `410` so managed-identity bearer tokens never reach the
   browser.
3. Route the retained voice client through
   `/api/azure/foundry/realtime/client-secret` and its returned Azure endpoint.
   The legacy `/api/realtime/token` alias exists only during coordinator
   migration.
