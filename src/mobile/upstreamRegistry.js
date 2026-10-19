/**
 * On-device upstream allowlist registry, mirroring the server's
 * registered-host policy client-side.
 *
 * Each family maps to `{ hosts, paths }`: `hosts` lists exact lowercase
 * hostnames, except entries starting with `*.` which match any subdomain of
 * the suffix (used for the GBFS `publicbikesystem.net` fleet and the
 * `radio-browser.info` mirror pool, mirroring `isAllowedGbfsHost` and the
 * server's radio-mirror hostname check). `paths` lists RegExp matchers for
 * the URL pathname; an empty list allows any path on a matched host, while
 * a non-empty list requires at least one match (for example GBFS only
 * serves `station_information.json` / `station_status.json`).
 *
 * Families with an empty `hosts` list allow nothing by default (fail
 * closed): `overpass` endpoints are operator-configured server-side via
 * `OVERPASS_UPSTREAMS`, and `localReceivers` is LAN (RFC1918 / `*.local`)
 * validated by its own adapter in Task 3 — device adapters supply a
 * registry override for these through `createNativeFetch({ registry })`.
 * The vault attaches provider keys later (Tasks 3-5); this registry only
 * gates where traffic may go, never what credentials it carries.
 *
 * @module mobile/upstreamRegistry
 */

/**
 * Per-family upstream allowlists: family name to allowed hosts + paths.
 * @type {Record<string, { hosts: string[], paths: RegExp[] }>}
 */
export const FAMILY_HOSTS = Object.freeze({
  earthquakes: {
    hosts: ['earthquake.usgs.gov'],
    paths: [/^\/earthquakes\//],
  },
  satellites: {
    hosts: ['celestrak.org'],
    paths: [/^\/NORAD\/elements\//],
  },
  launches: {
    hosts: ['ll.thespacedevs.com'],
    paths: [/^\/2\.3\.0\//],
  },
  terrain: {
    hosts: ['terrain.reearth.land'],
    paths: [],
  },
  geocode: {
    hosts: ['nominatim.openstreetmap.org', 'photon.komoot.io'],
    paths: [],
  },
  imagery: {
    hosts: [
      'wvs.earthdata.nasa.gov',
      'gibs.earthdata.nasa.gov',
      'cmr.earthdata.nasa.gov',
      'services.arcgisonline.com',
    ],
    paths: [],
  },
  weather: {
    hosts: ['api.open-meteo.com'],
    paths: [/^\/v1\//],
  },
  adsbdb: {
    hosts: ['api.adsbdb.com'],
    paths: [/^\/v0\//],
  },
  route: {
    hosts: ['routing.openstreetmap.de'],
    paths: [/^\/routed-/],
  },
  firePerimeters: {
    hosts: [
      'data-nifc.opendata.arcgis.com',
      'services3.arcgis.com',
      'inciweb.wildfire.gov',
    ],
    paths: [],
  },
  cyclones: {
    hosts: [
      'www.nhc.noaa.gov',
      'mapservices.weather.noaa.gov',
      'nowcoast.noaa.gov',
    ],
    paths: [],
  },
  gbfs: {
    hosts: [
      'gbfs.lyft.com',
      'gbfs.bluebikes.com',
      'gbfs.bcycle.com',
      'gbfs.biketownpdx.com',
      'gbfs.cogobikeshare.com',
      'austin.publicbikesystem.net',
      'hon.publicbikesystem.net',
      'chat.publicbikesystem.net',
      '*.publicbikesystem.net',
    ],
    paths: [/\/station_(information|status)\.json$/i],
  },
  radio: {
    hosts: ['*.api.radio-browser.info'],
    paths: [],
  },
  mapillary: {
    hosts: ['tiles.mapillary.com', 'graph.mapillary.com', 'www.mapillary.com'],
    paths: [],
  },
  firms: {
    hosts: ['firms.modaps.eosdis.nasa.gov'],
    paths: [/^\/api\//, /^\/mapserver\//],
  },
  tomtom: {
    hosts: ['api.tomtom.com'],
    paths: [/^\/traffic\//, /^\/map\//, /^\/search\//, /^\/routing\//],
  },
  flights: {
    hosts: [
      'opensky-network.org',
      'auth.opensky-network.org',
      'api.adsb.lol',
      'adsb.lol',
    ],
    paths: [],
  },
  vessels: {
    hosts: ['stream.aisstream.io'],
    paths: [],
  },
  google: {
    hosts: ['places.googleapis.com', 'maps.googleapis.com'],
    paths: [],
  },
  openai: {
    hosts: ['api.openai.com'],
    paths: [/^\/v1\//],
  },
  transit: {
    hosts: [
      'api.entur.io',
      'cdn.mbta.com',
      'data.texas.gov',
      'gtfs.ovapi.nl',
      'gtfsrt.api.translink.com.au',
      'realtime.hsl.fi',
      'svc.metrotransit.org',
    ],
    paths: [],
  },
  wind: {
    hosts: ['data.ecmwf.int', 'noaa-gfs-bdp-pds.s3.amazonaws.com'],
    paths: [],
  },
  cctv: {
    hosts: [
      'cctv.austinmobility.io',
      'cwwp2.dot.ca.gov',
      'its.txdot.gov',
      'tarktee.transpordiamet.ee',
      'video.deldot.gov',
      '511on.ca',
      'data.livetraffic.com',
      'tmc.deldot.gov',
      'data.calgary.ca',
      'trafficcam.calgary.ca',
      'tie.digitraffic.fi',
      'weathercam.digitraffic.fi',
      'webcams.transport.nsw.gov.au',
      'kamera.atlas.vegvesen.no',
      'kamera.vegvesen.no',
      'ogckart-sn1.atlas.vegvesen.no',
      'ristmikud.tallinn.ee',
      's3-eu-west-1.amazonaws.com',
      'api.tfl.gov.uk',
      'data.austintexas.gov',
    ],
    paths: [],
  },
  overpass: {
    hosts: [],
    paths: [],
  },
  noaaTiles: {
    hosts: ['nowcoast.noaa.gov', 'mapservices.weather.noaa.gov'],
    paths: [],
  },
  localReceivers: {
    hosts: [],
    paths: [],
  },
});

/**
 * Check whether a hostname matches one registry host entry (exact,
 * case-insensitive, or `*.` subdomain wildcard).
 * @param {string} hostname Lowercased request hostname.
 * @param {string} entry Registry host entry.
 * @returns {boolean} True when the hostname is covered by the entry.
 */
export function hostMatchesEntry(hostname, entry) {
  const host = String(hostname || '').toLowerCase();
  const rule = String(entry || '').toLowerCase();
  if (!host || !rule) return false;
  if (rule.startsWith('*.')) {
    const suffix = rule.slice(1);
    return host.length > suffix.length && host.endsWith(suffix);
  }
  return host === rule;
}

/**
 * Check whether a URL is allowed by a registry: some family must cover
 * both its host and (when the family constrains them) its path.
 * @param {string|URL} url Request URL.
 * @param {Record<string, { hosts: string[], paths: RegExp[] }>} registry Family registry.
 * @returns {boolean} True when any family entry covers the URL.
 */
export function isUrlAllowedByRegistry(url, registry) {
  let parsed;
  try {
    parsed = url instanceof URL ? url : new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  for (const family of Object.values(registry ?? {})) {
    const hosts = family?.hosts ?? [];
    const paths = family?.paths ?? [];
    if (!hosts.some((entry) => hostMatchesEntry(hostname, entry))) continue;
    if (paths.length > 0 && !paths.some((rule) => rule.test(parsed.pathname))) {
      continue;
    }
    return true;
  }
  return false;
}
