# Retained API bridge contract

The production BFF deliberately fails startup unless `COMPATIBILITY_MODULE_PATH`
points to a module exporting:

```js
export async function createCompatibilityBridge(config) {
  return {
    async handle({ contractId, method, url, query, params, body, correlationId, signal }) {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: {} };
    },
    async close() {}
  };
}
```

The coordinator must extract the retained Connect/Vite handlers from
`vite.config.js` into a runtime-safe module at
`server/compat/retained-api.mjs`, or implement the bridge using those same pure
helpers. The bridge contract covers CelesTrak, TomTom, FIRMS, terrain heights,
ADSBdb, Overpass/OSRM route, OpenSky, adsb.lol, CCTV, military installations,
regional brief, and weather effects. Do not import Vite itself in production.

Secrets used by retained third-party handlers must be environment variables
backed by ACA Key Vault references. The bridge must honor the supplied abort
signal and enforce the BFF response limit. Binary responses use a `Buffer` body.
