/**
 * MAP SOURCE tray: chip presentation, status fallbacks and availability copy.
 * Provider brand names (Google 3D, Bing, Esri, OSM, Cesium ion) stay verbatim.
 */
export default {
  status: {
    switching: '...',
    fallback: 'MAP',
  },
  chip: {
    aria: '{label} unavailable: {hint}',
  },
  stack: {
    unavailable: '{label} is unavailable',
    unavailableFallback: 'This map stack',
  },
  esri: {
    fallback: 'Esri Satellite is unavailable; using OSM',
    tileFallback: 'Esri Satellite tile requests failed; using OSM',
  },
  photoreal: {
    keyed:
      "Google 3D tiles unavailable — check the key's API restrictions, quota, or network",
    keyless: '{requirement} — or a Cesium ion token for the ion-hosted route',
  },
};
