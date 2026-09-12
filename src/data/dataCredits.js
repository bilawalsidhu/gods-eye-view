import * as Cesium from 'cesium';

/**
 * Per-layer data attribution registered into Cesium's credit display.
 *
 * Legal requirement (see DATA_SOURCES.md, findings H10/H11 in
 * docs/pre-ship-audit-2026-07-01.md): every third-party data layer this app can
 * display carries its own license and required attribution — ODbL (OSM
 * datacenters/dams, adsb.lol, Overpass roads), CC BY-NC-SA (TeleGeography
 * cables), NASA FIRMS, CelesTrak, USGS, City of Austin, GBFS operators, OpenSky,
 * and the amateur-radio feeds relayed by HamRig (DX cluster nodes, AD1C country
 * files, POTA, SOTA, WWFF/WWBOTA, NG3K, Club Log, NOAA SWPC, VOACAP,
 * prop.kc2g.com, PSKReporter, wspr.live, NCDXF/IARU).
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
    key: 'military-installations-osm',
    html:
      'Mapped installation context: ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      '(ODbL 1.0; incomplete mapped context)',
  },
  {
    key: 'cockpit-place-osm',
    html:
      'Cockpit place context: ' +
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
    key: 'gbfs',
    html: 'Bikeshare availability: GBFS operator feeds (e.g. Austin BCycle)',
  },
  {
    key: 'radio-browser',
    html:
      'Internet-radio station directory: ' +
      '<a href="https://www.radio-browser.info/" target="_blank" rel="noopener">Radio Browser</a> ' +
      '(public domain; audio delivered directly by each broadcaster)',
  },
  {
    key: 'web-receivers',
    html:
      'Web receiver directory: ' +
      '<a href="https://www.receiverbook.de/" target="_blank" rel="noopener">Receiverbook</a> and the ' +
      '<a href="http://rx.linkfanel.net/" target="_blank" rel="noopener">KiwiSDR community map feed</a> ' +
      '(directory metadata only; each receiver page is loaded directly from its operator)',
  },
  // ── Ham radio (HamRig + the feeds it relays; see DATA_SOURCES.md) ─
  {
    key: 'hamrig',
    html:
      'Amateur-radio layers (DX spots, activations, DXpeditions, propagation, beacons, repeaters, stations): ' +
      '<a href="https://hamrig.com" target="_blank" rel="noopener">HamRig</a> ' +
      '(upstream feeds credited individually below)',
  },
  {
    key: 'dx-cluster',
    html:
      'DX cluster spots via HamRig from dxfun.com, ve7cc.net and cluster.veron.nl ' +
      '(fallback: dxwatch.com / HamQTH)',
  },
  {
    key: 'ad1c-cty',
    html:
      'Country files © Jim Reisert AD1C — ' +
      '<a href="https://www.country-files.com/" target="_blank" rel="noopener">country-files.com</a>',
  },
  {
    key: 'pota',
    html:
      'Park activations: ' +
      '<a href="https://pota.app" target="_blank" rel="noopener">Parks on the Air</a>',
  },
  {
    key: 'sota',
    html:
      'Summit activations: ' +
      '<a href="https://www.sota.org.uk" target="_blank" rel="noopener">Summits on the Air</a> ' +
      '(SOTA API terms — non-commercial)',
  },
  {
    key: 'wwff-wwbota',
    html:
      'Flora &amp; Fauna and bunker activations: ' +
      '<a href="https://spots.wwff.co" target="_blank" rel="noopener">WWFF Spotline</a> and ' +
      '<a href="https://wwbota.net" target="_blank" rel="noopener">WWBOTA</a> via HamRig',
  },
  {
    key: 'ng3k-adxo',
    html:
      'DXpeditions: Announced DX Operations © W.B. Feidt NG3K — ' +
      '<a href="https://www.ng3k.com/Misc/adxo.html" target="_blank" rel="noopener">ng3k.com</a>',
  },
  {
    key: 'clublog',
    html:
      'Most-wanted ranking: ' +
      '<a href="https://clublog.org/mostwanted.php" target="_blank" rel="noopener">Club Log</a> ' +
      '(Michael Wells G7VJR)',
  },
  {
    key: 'noaa-swpc',
    html:
      'Space weather &amp; aurora forecast: ' +
      '<a href="https://www.swpc.noaa.gov" target="_blank" rel="noopener">NOAA Space Weather Prediction Center</a> ' +
      '(public domain)',
  },
  {
    key: 'voacap',
    html:
      'HF reliability maps: VOACAP via ' +
      '<a href="https://github.com/jawatson/voacapl" target="_blank" rel="noopener">voacapl</a> ' +
      '(public domain / CC0), computed by HamRig — a model prediction, not an observation',
  },
  {
    key: 'kc2g-ionosondes',
    html:
      'Ionosonde data: ' +
      '<a href="https://prop.kc2g.com" target="_blank" rel="noopener">prop.kc2g.com</a> (KC2G) ' +
      'from GIRO / INGV ionosonde operators, supported by WWROF',
  },
  {
    key: 'pskreporter',
    html:
      'Reception reports: ' +
      '<a href="https://pskreporter.info" target="_blank" rel="noopener">PSKReporter</a> via HamRig',
  },
  {
    key: 'wspr-live',
    html:
      'WSPR reports: ' +
      '<a href="https://wspr.live" target="_blank" rel="noopener">wspr.live</a> ' +
      '(data from WSPRnet; non-commercial)',
  },
  {
    key: 'ncdxf-ibp',
    html:
      'HF beacons: ' +
      '<a href="https://www.ncdxf.org/beacon/" target="_blank" rel="noopener">NCDXF/IARU International Beacon Project</a>',
  },
  {
    key: 'hamrig-repeaters',
    html:
      'Repeaters: HamRig repeater database ' +
      '(relaislisten.darc.de DL3EL, hearham.com, dstarinfo.com, ircddb.net)',
  },
  {
    key: 'hamrig-callsign-db',
    html:
      'Station data: HamRig callsign database (QRZ.com XML / HamDB.org; personal fields removed)',
  },
  {
    key: 'reearth-terrain',
    html:
      'Terrain (keyless globe stacks): ' +
      '<a href="https://terrain.reearth.land" target="_blank" rel="noopener">Re:Earth Terrain</a> / ' +
      'Mapterhorn (CC BY 4.0) / EGM2008 (NGA)',
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

/** Registered the first time login-gated HamRig data renders (VHF beacon
 * list, worked DXCC / worked grids, rotator state) — it only exists when the
 * operator configured `HAMRIG_USERNAME`/`HAMRIG_PASSWORD`, so keyless installs
 * never show it. Callers: `registerDynamicCredit(viewer, HAMRIG_MY_STATION_CREDIT)`
 * from the ham-stations and ham-beacons layers. */
export const HAMRIG_MY_STATION_CREDIT = {
  key: 'hamrig-my-station',
  html:
    'Logbook-derived worked DXCC / grids, rotator state and VHF beacon list: the operator’s own ' +
    '<a href="https://hamrig.com" target="_blank" rel="noopener">HamRig</a> account',
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
export function registerDataCredits(viewer) {
  const creditDisplay = viewer?.creditDisplay;
  if (!creditDisplay || typeof creditDisplay.addStaticCredit !== 'function') {
    return;
  }
  for (const { html } of DATA_CREDITS) {
    // showOnScreen=false → lives in the expandable "Data attribution" popover,
    // not the on-globe credit line.
    creditDisplay.addStaticCredit(new Cesium.Credit(html, false));
  }
}
