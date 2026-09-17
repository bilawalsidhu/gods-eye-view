import * as Cesium from 'cesium';

/**
 * Per-layer data attribution registered into Cesium's credit display.
 *
 * Legal requirement (see DATA_SOURCES.md, findings H10/H11 in
 * docs/pre-ship-audit-2026-07-01.md): every third-party data layer this app can
 * display carries its own license and required attribution — ODbL (OSM
 * datacenters/dams, adsb.lol, Overpass roads), CC BY-NC-SA (TeleGeography
 * cables), NASA FIRMS, CelesTrak, USGS, City of Austin, Fintraffic (CC BY 4.0),
 * The MIT code license does NOT cover this data.
 *
 * These credits are registered ONCE at init as STATIC credits with
 * showOnScreen=false, so they live in the expandable bottom-left "Data
 * attribution" lightbox (Cesium's credit popover) rather than cluttering the
 * on-globe line. Always-present is intentional and reversible: the lightbox is
 * the app's canonical attribution surface and DATA_SOURCES.md is the
 * machine-readable index. Strings are copied verbatim from DATA_SOURCES.md — if
 * you add a data source, add it there AND here.
 */

/**
 * Attribution entries. `html` is the credit markup; keep it minimal and
 * link out where DATA_SOURCES.md provides a canonical URL. Order roughly
 * follows DATA_SOURCES.md (live sources, then bundled snapshots).
 * @type {{ key: string, html: string }[]}
 */
export const DATA_CREDITS = [
  // ── Live sources ────────────────────────────────────────────────
  {
    key: 'opensky',
    html:
      'Flights: OpenSky Network — Schäfer et al., ' +
      '“Bringing Up OpenSky”, IPSN 2014 · ' +
      '<a href="https://opensky-network.org" target="_blank" rel="noopener">opensky-network.org</a> ' +
      '(non-commercial)',
  },
  {
    key: 'adsblol',
    html:
      'Military flights, aircraft traces &amp; bounded regional flight fallback: ' +
      '<a href="https://adsb.lol" target="_blank" rel="noopener">adsb.lol</a> ' +
      '(ODbL 1.0)',
  },
  {
    key: 'aisstream',
    html:
      'Live vessels (AIS): ' +
      '<a href="https://aisstream.io" target="_blank" rel="noopener">AISStream.io</a>',
  },
  {
    key: 'celestrak',
    html:
      'Satellites (TLEs): CelesTrak ' +
      '(<a href="https://celestrak.org" target="_blank" rel="noopener">celestrak.org</a>), ' +
      'Dr. T.S. Kelso',
  },
  {
    key: 'launch-library-2',
    html:
      'Space mission launch, payload &amp; recovery metadata: ' +
      '<a href="https://ll.thespacedevs.com/docs/" target="_blank" rel="noopener">Launch Library 2 — The Space Devs</a> ' +
      '(API documentation and rate limits)',
  },
  {
    key: 'usgs',
    html: 'Earthquakes: Data courtesy of the U.S. Geological Survey',
  },
  {
    key: 'overpass',
    html:
      'Road geometry (traffic): ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      '(ODbL 1.0)',
  },
  {
    key: 'photon-geocoder',
    html:
      'Keyless place search: ' +
      '<a href="https://photon.komoot.io" target="_blank" rel="noopener">Photon</a> (komoot) over ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      '(ODbL 1.0)',
  },
  {
    key: 'alpr-osm',
    html:
      'ALPR camera locations (automatic license plate readers): ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      '(<a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener">ODbL 1.0</a>); ' +
      'community mapping includes <a href="https://deflock.org" target="_blank" rel="noopener">DeFlock</a>',
  },
  {
    key: 'military-installations-osm',
    html:
      'Mapped installation context: ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      '(ODbL 1.0; incomplete mapped context)',
  },
  {
    key: 'cockpit-place-osm',
    html:
      'Cockpit place context and last-resort place search: ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      'via Nominatim (ODbL 1.0)',
  },
  {
    key: 'open-meteo',
    html:
      'Cockpit current conditions: ' +
      '<a href="https://open-meteo.com/en/licence" target="_blank" rel="noopener">Weather data by Open-Meteo.com</a> ' +
      '(CC BY 4.0)',
  },
  {
    key: 'google-news-rss',
    html:
      'Cockpit regional headlines: ' +
      '<a href="https://policies.google.com/terms" target="_blank" rel="noopener">Google News RSS</a> ' +
      '(location-matched article links; publisher terms apply)',
  },
  {
    key: 'gdelt',
    html:
      'Cockpit regional headlines: ' +
      '<a href="https://www.gdeltproject.org/about.html" target="_blank" rel="noopener">GDELT Project</a> ' +
      '(location-matched article links; publisher terms apply)',
  },
  {
    key: 'austin-cctv',
    html:
      'CCTV cameras &amp; frames: City of Austin, TX — ' +
      '<a href="https://data.austintexas.gov" target="_blank" rel="noopener">data.austintexas.gov</a>',
  },
  {
    key: 'txdot-cctv',
    html:
      'CCTV cameras &amp; frames (Texas): ' +
      '<a href="https://its.txdot.gov/" target="_blank" rel="noopener">Texas Department of Transportation</a> (courtesy)',
  },
  {
    key: 'deldot-cctv',
    html: 'CCTV live video (Delaware): <a href="https://deldot.gov/map/" target="_blank" rel="noopener">DelDOT — Delaware Department of Transportation</a>',
  },
  {
    key: 'caltrans-cctv',
    html:
      'CCTV cameras &amp; frames (California): Caltrans — ' +
      '<a href="https://cwwp2.dot.ca.gov/" target="_blank" rel="noopener">cwwp2.dot.ca.gov</a>',
  },
  {
    key: 'tfl-cctv',
    html:
      'CCTV cameras &amp; frames (London): ' +
      '<a href="https://tfl.gov.uk/info-for/open-data-users/" target="_blank" rel="noopener">Powered by TfL Open Data</a>. ' +
      'Contains OS data © Crown copyright and database rights.',
  },
  {
    key: 'ontario-511-cctv',
    html:
      'CCTV cameras &amp; frames (Ontario): ' +
      '<a href="https://511on.ca/" target="_blank" rel="noopener">Ontario 511</a> ' +
      '(<a href="https://www.ontario.ca/page/open-government-licence-ontario" target="_blank" rel="noopener">Open Government Licence - Ontario</a>)',
  },
  {
    key: 'fintraffic-cctv',
    html:
      'CCTV cameras &amp; frames (Finland): Fintraffic / ' +
      '<a href="https://www.digitraffic.fi/en/" target="_blank" rel="noopener">digitraffic.fi</a>, ' +
      'license CC BY 4.0',
  },
  {
    key: 'calgary-cctv',
    html:
      'Traffic cameras (Calgary): contains information licensed under the ' +
      '<a href="https://data.calgary.ca/stories/s/Open-Calgary-Terms-of-Use/u45n-7awa" target="_blank" rel="noopener">Open Government Licence – City of Calgary</a>',
  },
  {
    key: 'gbfs',
    html: 'Bikeshare availability: GBFS operator feeds (e.g. Austin BCycle)',
  },
  {
    key: 'osrm-routing',
    // The service asks for its attribution to carry a "fix the map" link, so
    // a reader who spots a wrong turn can go and correct the data it came from.
    html:
      'Routing (voice routes and Directions): OSRM on the FOSSGIS servers — ' +
      '<a href="https://routing.openstreetmap.de/about.html" target="_blank" rel="noopener">routing.openstreetmap.de</a> · ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> (ODbL) · ' +
      '<a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener">fix the map</a>',
  },
  {
    key: 'gtfs-rt',
    html: 'Transit vehicles: operator GTFS-Realtime feeds (each operator is credited below when its vehicles are shown)',
  },
  {
    key: 'radio-browser',
    html:
      'Internet-radio station directory: ' +
      '<a href="https://www.radio-browser.info/" target="_blank" rel="noopener">Radio Browser</a> ' +
      '(public domain; audio delivered directly by each broadcaster)',
  },
  {
    key: 'reearth-terrain',
    html:
      'Terrain (keyless globe stacks): ' +
      '<a href="https://terrain.reearth.land" target="_blank" rel="noopener">Re:Earth Terrain</a> / ' +
      'Mapterhorn (CC BY 4.0) / EGM2008 (NGA)',
  },
  {
    key: 'weather-noaa',
    html: 'Observed weather: <a href="https://nowcoast.noaa.gov/" target="_blank" rel="noopener">NOAA nowCOAST</a> · NWS/OAR MRMS radar; NESDIS GOES and global satellite partners. <a href="https://oceanservice.noaa.gov/disclaimer.html" target="_blank" rel="noopener">Source disclaimer</a>.',
  },
  {
    key: 'weather-cyclones',
    html: 'Cyclone advisories: <a href="https://www.nhc.noaa.gov/" target="_blank" rel="noopener">NOAA/NWS NHC / CPHC</a> · Atlantic and eastern/central North Pacific. Forecast center uncertainty, not storm size.',
  },
  {
    key: 'weather-lightning',
    html: 'Lightning density: NOAA/NWS nowCOAST · derived from Vaisala NLDN/GLD360. <a href="https://ocean.weather.gov/lightning/lightning_pdd.php" target="_blank" rel="noopener">Public derived density product</a>, not raw detections.',
  },
  {
    key: 'wind-gfs',
    html:
      'Wind: resampled NOAA Global Forecast System (GFS) 10 m wind via ' +
      '<a href="https://registry.opendata.aws/noaa-gfs-bdp-pds/" target="_blank" rel="noopener">NOAA Open Data on AWS</a> ' +
      '(U.S. public domain; forecast, not observations)',
  },
  {
    key: 'ecmwf-ifs',
    html:
      'This service is based on data and products of the European Centre for Medium-Range Weather Forecasts (ECMWF). ' +
      '<a href="https://www.ecmwf.int/en/forecasts/datasets/open-data" target="_blank" rel="noopener">ECMWF Open Data</a> · ' +
      '<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>. ' +
      'Modified: resampled 10 m IFS forecast vectors and animated display. ' +
      'ECMWF does not accept any liability whatsoever for any error or omission in the data, their availability, or for any loss or damage arising from their use.',
  },
  // ── Bundled snapshots ───────────────────────────────────────────
  {
    key: 'datacenters',
    html:
      'Datacenters: ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      '(ODbL 1.0)',
  },
  {
    key: 'dams',
    html:
      'Dams: ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      '(ODbL 1.0) + Open Infrastructure Map',
  },
  {
    key: 'firms',
    html:
      'Active fires: NASA FIRMS — we acknowledge the use of data and/or imagery ' +
      'from NASA’s Fire Information for Resource Management System ' +
      '(<a href="https://earthdata.nasa.gov/firms" target="_blank" rel="noopener">earthdata.nasa.gov/firms</a>), ' +
      'part of NASA’s Earth Observing System Data and Information System (EOSDIS)',
  },
  {
    key: 'drivebc-cctv',
    html:
      'CCTV cameras &amp; frames (British Columbia): ' +
      '<a href="https://www.drivebc.ca/" target="_blank" rel="noopener">DriveBC</a>. ' +
      'Contains information licensed under the ' +
      '<a href="https://www2.gov.bc.ca/gov/content/data/open-data/open-government-licence-bc" target="_blank" rel="noopener">Open Government Licence – British Columbia</a>. ' +
      'Some cameras are supplied by partners (TransLink, the City of Vancouver, the City of Surrey, Parks Canada and others); each names its provider in the CCTV panel.',
  },
  {
    key: 'tallinn-cctv',
    html:
      'CCTV cameras &amp; frames (Tallinn): City of Tallinn — ' +
      '<a href="https://ristmikud.tallinn.ee/" target="_blank" rel="noopener">ristmikud.tallinn.ee</a> (courtesy)',
  },
  {
    key: 'tarktee-cctv',
    html:
      'CCTV cameras &amp; frames (Estonia road weather): Transpordiamet / Tarktee — ' +
      '<a href="https://tarktee.transpordiamet.ee/" target="_blank" rel="noopener">tarktee.transpordiamet.ee</a> (courtesy)',
  },
  {
    key: 'warendorf-cctv',
    html:
      'Webcam (Warendorf): <a href="https://www.warendorf.de/" target="_blank" rel="noopener">Stadt Warendorf</a> (courtesy); ' +
      'camera poses derived from OpenStreetMap geometry, © OpenStreetMap contributors (ODbL)',
  },
  {
    key: 'nsw-cctv',
    html:
      'CCTV cameras &amp; frames (New South Wales): ' +
      '<a href="https://www.livetraffic.com/" target="_blank" rel="noopener">Live Traffic NSW</a> — Transport for NSW ' +
      '(<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>)',
  },
  {
    key: 'telegeography',
    html:
      'Submarine cables: © TeleGeography — ' +
      '<a href="https://www.submarinecablemap.com" target="_blank" rel="noopener">submarinecablemap.com</a> ' +
      '(CC BY-NC-SA 3.0 — NonCommercial)',
  },
];

/**
 * Conditional credits — registered via `registerDynamicCredit` only when the
 * corresponding capability actually activates (deliberately NOT part of
 * DATA_CREDITS, which is always-on). TomTom terms require attribution when
 * their flow data is displayed; keyless installs never show it, so the
 * credit only appears once live traffic-flow mode activates.
 * @type {{ key: string, html: string }}
 */
export const TOMTOM_CREDIT = {
  key: 'tomtom',
  html:
    'Traffic flow data © ' +
    '<a href="https://www.tomtom.com" target="_blank" rel="noopener">TomTom</a>',
};

/** Registered when the first Natural Earth region outline resolves (public
 * domain — no attribution required; credited as a courtesy). */
export const NATURAL_EARTH_CREDIT = {
  key: 'natural-earth',
  html:
    'Physical region boundaries from ' +
    '<a href="https://www.naturalearthdata.com" target="_blank" rel="noopener">Natural Earth</a> (public domain)',
};

/**
 * Per-feed transit credit, registered the first time that feed's vehicles
 * render (see `src/data/transitFeeds.js` for the license of each).
 * @param {{ id: string, attribution: string, license: string, licenseUrl: string }} feed
 * @returns {{ key: string, html: string }}
 */
export function transitFeedCredit(feed) {
  const escape = (text) =>
    String(text)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  return {
    key: `transit-${feed.id}`,
    html:
      `Transit (${escape(feed.attribution)}): ` +
      `<a href="${escape(feed.licenseUrl)}" target="_blank" rel="noopener">${escape(feed.license)}</a>`,
  };
}

/** Registered when the Bhote Koshi event reconstruction activates. */
export const BHOTE_KOSHI_CREDIT = {
  key: 'bhote-koshi-2026',
  html:
    'Bhote Koshi 2026 event imagery and derived reconstruction: ' +
    '<a href="https://vantor.com/company/open-data-program" target="_blank" rel="noopener">Vantor Open Data</a> ' +
    'and <a href="https://github.com/geo-pera/bhotekoshi-2026-reconstruction" target="_blank" rel="noopener">GeoPera</a> ' +
    '(CC BY-NC 4.0); terrain © Re:Earth / Mapterhorn (CC BY 4.0)',
};

/** Registered when the scene-friendly Nepal incident locator activates. */
export const BHOTE_KOSHI_LOCATOR_CREDIT = {
  key: 'bhote-koshi-locator',
  html:
    'Nepal administrative boundary and nearby-city locations: ' +
    '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
    '(ODbL 1.0); incident-place anchors use an owner-curated, source-verified geolocation union; ' +
    'flood corridor derived from the ' +
    '<a href="https://github.com/geo-pera/bhotekoshi-2026-reconstruction/blob/main/vectors/river_centerline.geojson" target="_blank" rel="noopener">GeoPera river centerline</a> ' +
    '(CC BY-NC 4.0)',
};

/** @type {Set<string>} Keys of dynamic credits already registered this session. */
const _dynamicCreditKeys = new Set();

/**
 * Register a conditional credit at the moment its data source activates.
 * Idempotent per `credit.key`; lands in the same "Data attribution" popover
 * as the static credits (showOnScreen=false).
 * @param {Cesium.Viewer} viewer — the initialized Cesium viewer
 * @param {{ key: string, html: string }} credit — e.g. `TOMTOM_CREDIT`
 * @returns {boolean} True when the credit is (now) registered.
 */
export function registerDynamicCredit(viewer, credit) {
  const creditDisplay = viewer?.creditDisplay;
  if (!creditDisplay || typeof creditDisplay.addStaticCredit !== 'function') {
    return false;
  }
  if (!credit?.key || !credit?.html) return false;
  if (_dynamicCreditKeys.has(credit.key)) return true;
  creditDisplay.addStaticCredit(new Cesium.Credit(credit.html, false));
  _dynamicCreditKeys.add(credit.key);
  return true;
}

/**
 * Register every per-layer data credit into the viewer's credit display.
 * Idempotent: safe to call once at init. Credits are static and always
 * present in the "Data attribution" popover.
 * @param {Cesium.Viewer} viewer — the initialized Cesium viewer
 */
export function registerDataCredits(viewer, credits = DATA_CREDITS) {
  const creditDisplay = viewer?.creditDisplay;
  if (!creditDisplay || typeof creditDisplay.addStaticCredit !== 'function') {
    return;
  }
  for (const { html } of credits) {
    // showOnScreen=false → lives in the expandable "Data attribution" popover,
    // not the on-globe credit line.
    creditDisplay.addStaticCredit(new Cesium.Credit(html, false));
  }
}
