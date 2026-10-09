/**
 * The Alpine automatic weather networks this layer can draw, one entry per
 * operator.
 *
 * Every network here is keyless and openly licensed, which is what makes them
 * eligible: the layer must work on a fresh clone with no credentials, like USGS
 * earthquakes and CelesTrak rather than like TomTom. A network that needs a
 * token belongs behind the key registry, not here.
 *
 * `parameters` is the honest list of what an operator publishes, not what its
 * stations happen to be reporting today. A parameter absent here is one the
 * network does not carry at all, so the layer can say "this network does not
 * measure that" instead of showing a silent gap.
 *
 * Adding a network means: an entry here, a pure adapter in `./networks/`, and
 * a fetch step in `server/providers/alpine-stations/`. Nothing else in the
 * layer is network-aware.
 */

/** Canonical ids, used as record prefixes and in the proxy's route segment. */
export const SLF_NETWORK_ID = 'slf-imis';
export const SMN_NETWORK_ID = 'meteoswiss-smn';
export const TAWES_NETWORK_ID = 'geosphere-tawes';

export const ALPINE_NETWORKS = Object.freeze([
  Object.freeze({
    id: SLF_NETWORK_ID,
    label: 'SLF IMIS',
    name: 'WSL Institute for Snow and Avalanche Research SLF',
    country: 'CH',
    regionLabel: 'Canton',
    homepage: 'https://www.slf.ch/',
    licence: 'CC BY 4.0',
    licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'WSL Institute for Snow and Avalanche Research SLF',
    // IMIS boxes sit above the tree line to watch the snowpack, so they carry
    // snow, wind and temperature and nothing else.
    parameters: Object.freeze(['snow', 'wind', 'temperature']),
    cadenceMinutes: 30,
  }),
  Object.freeze({
    id: SMN_NETWORK_ID,
    label: 'SwissMetNet',
    name: 'MeteoSwiss (Federal Office of Meteorology and Climatology)',
    country: 'CH',
    regionLabel: 'Canton',
    homepage: 'https://www.meteoswiss.admin.ch/',
    licence: 'CC BY 4.0',
    licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'MeteoSwiss',
    // No snow: the whole-network current-values file VQHA80 has no snow
    // column, and the per-station alternative costs ~160 requests a refresh.
    // See the header of ./networks/smn.js. Swiss snow depth comes from SLF.
    parameters: Object.freeze([
      'wind',
      'temperature',
      'precipitation',
      'pressure',
    ]),
    cadenceMinutes: 10,
  }),
  Object.freeze({
    id: TAWES_NETWORK_ID,
    label: 'TAWES',
    name: 'GeoSphere Austria',
    country: 'AT',
    regionLabel: 'State',
    homepage: 'https://data.hub.geosphere.at/',
    licence: 'CC BY 4.0',
    licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'GeoSphere Austria',
    // No pressure. `PRED` ("reduzierter Luftdruck") is only reduced to sea
    // level for low stations: Wien/Hohe Warte at 198 m reads P 991.7 against
    // PRED 1016.4, but Sonnblick at 3109 m reads P 696.7 against PRED 707.7,
    // an 11 hPa correction over three kilometres. Nothing in the payload says
    // which regime a station is in, so including it would draw a map of
    // Austrian altitude. See the pressure rule in ../records.js.
    parameters: Object.freeze(['snow', 'wind', 'temperature', 'precipitation']),
    cadenceMinutes: 10,
  }),
]);

export const ALPINE_NETWORK_IDS = Object.freeze(
  ALPINE_NETWORKS.map((network) => network.id),
);

const BY_ID = new Map(ALPINE_NETWORKS.map((network) => [network.id, network]));

/** The network with this id, or null. Never throws: ids arrive from payloads. */
export function alpineNetwork(id) {
  return BY_ID.get(id) ?? null;
}

/** Networks that publish a given parameter, in registry order. */
export function networksMeasuring(parameterId) {
  return ALPINE_NETWORKS.filter((network) =>
    network.parameters.includes(parameterId),
  );
}

/**
 * One attribution line covering the networks actually present in a payload.
 *
 * CC BY is a condition rather than a courtesy, so this credits the operators
 * whose data is on screen and stays silent about the rest.
 */
export function alpineAttribution(networkIds = ALPINE_NETWORK_IDS) {
  const names = ALPINE_NETWORKS.filter((network) =>
    networkIds.includes(network.id),
  ).map((network) => network.attribution);
  return names.length ? `${names.join(' · ')} (CC BY 4.0)` : '';
}
