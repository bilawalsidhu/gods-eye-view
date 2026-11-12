- Keep the Cesium ion and Mapillary tokens on the server. CesiumJS asks this
  app for ion asset endpoints and MapillaryJS calls a Graph proxy that adds
  the token, so neither token is defined into the browser bundle any more;
  the Google browser key is unchanged. The app now asks the server whether it
  holds an ion token and a Mapillary token before it starts (Street Level
  still opens on the first keyless source when there is no Mapillary token),
  so `application`, exported by `src/main.js`, is a Promise of the
  application: await it. The MCP Apps panel
  reaches the same routes through its MCP server and runs keyless when they do
  not answer. A key-exposure test and scripts/check-key-exposure.mjs guard it
  (Byrd-IT, #1315).
