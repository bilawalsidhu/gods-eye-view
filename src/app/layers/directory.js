// The application's layers in catalog order, by id and display name: what
// the catalog builds on Cesium. Plain data, so the availability of a layer
// on an engine (renderers.js) can be told without constructing it.
// constructCatalog.test.mjs keeps it equal to the constructed catalog.

export const APPLICATION_LAYER_DIRECTORY = Object.freeze(
  [
    ['bhote-koshi-2026', 'Bhote Koshi Flood'],
    ['bhote-koshi-locator', 'Bhote Koshi Locator'],
    ['flights', 'Live Flights'],
    ['military', 'Military Flights'],
    ['local-adsb', 'Local ADS-B'],
    ['earthquakes', 'Earthquakes (24h)'],
    ['fire-perimeters', 'Fire Perimeters'],
    ['alpr-cameras', 'ALPR Cameras'],
    ['street-level', 'Street Level'],
    ['satellites', 'Satellites'],
    ['rocket-launches', 'Space Missions (30d)'],
    ['traffic', 'Street Traffic'],
    ['cctv', 'CCTV'],
    ['radio', 'Radio'],
    ['transit', 'Transit'],
    ['bikeshare', 'Bikeshare'],
    ['directions', 'Directions'],
    ['recent-imagery', 'Recent Imagery'],
    ['ais-live-vessels', 'Live AIS Vessels'],
    ['military-installations', 'Mapped Installations'],
    ['military-awareness', 'Global Context'],
    ['wind', 'Wind'],
    ['weather-radar', 'Rain radar'],
    ['weather-satellite', 'Satellite clouds'],
    ['weather-lightning', 'Lightning density'],
    ['weather-cyclones', 'Cyclone advisories'],
    ['local-datacenters', 'Datacenters'],
    ['local-dams', 'Dams'],
    ['telegeography-submarine-cables', 'Submarine Cables'],
    ['local-firms', 'FIRMS Active Fires'],
  ].map(([id, name]) => Object.freeze({ id, name })),
);
