- Keep the Cesium ion and Mapillary tokens on the server. CesiumJS asks this
  app for ion asset endpoints and MapillaryJS calls a Graph proxy that adds
  the token, so neither token is defined into the browser bundle any more;
  the Google browser key is unchanged. The ion routes still work behind a
  reverse proxy with the key in `.env`. They return ion's endpoint documents,
  never the account token, and anyone who can reach the route can read them:
  the Bing documents carry a Bing Maps key issued by ion, and the Google 3D
  Tiles document points at Google's tile service and may carry a provider key
  in its URL. Those credentials' lifetime is ion's to set. Mapillary Graph
  lookups (nearest image, viewer metadata) now go through this server's
  `/api/mapillary/graph` route, which sits behind the same cross-site gate as
  the other `/api/mapillary` routes and is therefore refused behind a reverse
  proxy, where at the previous release the browser called Mapillary directly.
  The app now asks the server whether it holds an ion token and a Mapillary
  token before it starts (Street Level still opens on the first keyless source
  when there is no Mapillary token), so `application`, exported by
  `src/main.js`, is a Promise of the application: await it. The MCP Apps panel
  reaches the same routes through its MCP server and runs keyless when they do
  not answer. A key-exposure test and scripts/check-key-exposure.mjs guard it.
  Breaking for embedders: `createMapillarySource({ token })` no longer takes a
  token (the option is ignored and `source.token` is gone) and
  `createBrowserViteConfig` ignores `cesiumToken` and `mapillaryToken`. Run
  the server routes (`server/providers/keyIsolation`, mounted by the servers
  this repository starts) with `MAPILLARY_CLIENT_TOKEN` and `CESIUM_ION_TOKEN`
  set on the server, or pass `graphEndpoint` to `createMapillarySource` to
  use a Graph proxy of your own that adds the token (Byrd-IT, #1315).
