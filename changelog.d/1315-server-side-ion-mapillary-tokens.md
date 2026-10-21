- Keep the Cesium ion and Mapillary tokens on the server. CesiumJS asks this
  app for ion asset endpoints and MapillaryJS calls a Graph proxy that adds
  the token, so neither token is defined into the browser bundle any more;
  the Google browser key is unchanged. A key-exposure test and
  scripts/check-key-exposure.mjs guard it (Byrd-IT, #1315).
