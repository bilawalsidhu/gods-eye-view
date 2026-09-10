/**
 * @module atcAirports
 * @description Global airport registry and spatial proximity resolver for
 * real-time air traffic control (ATC) communications.
 *
 * Contains major international airports with ICAO/IATA identifiers, coordinates,
 * elevations, and published VHF AM frequencies (Tower, Approach, ATIS, Ground).
 */

/**
 * Earth radius in meters (mean radius for Haversine calculations).
 */
export const EARTH_RADIUS_M = 6371000;

/**
 * 1 International Nautical Mile in meters.
 */
export const METERS_PER_NM = 1852;

/**
 * Convert meters to nautical miles.
 * @param {number} meters
 * @returns {number}
 */
export function metersToNauticalMiles(meters) {
  if (!Number.isFinite(meters) || meters < 0) return 0;
  return meters / METERS_PER_NM;
}

/**
 * Calculate Great-Circle distance between two coordinates using the Haversine formula.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} Distance in meters
 */
export function greatCircleDistanceM(lat1, lon1, lat2, lon2) {
  if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) {
    return Number.POSITIVE_INFINITY;
  }
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const aRaw =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const a = Math.min(1, Math.max(0, aRaw));
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_M * c;
}

/**
 * Curated registry of major global airports with published VHF frequencies.
 * All coordinates use WGS84 decimal degrees.
 */
export const GLOBAL_AIRPORTS = Object.freeze([
  // --- North America (US & Canada) ---
  {
    icao: 'KAUS',
    iata: 'AUS',
    name: 'Austin-Bergstrom Intl',
    city: 'Austin',
    country: 'US',
    lat: 30.1945,
    lon: -97.6699,
    elevationM: 165,
    frequencies: { tower: '121.000', approach: '119.000', atis: '124.400', ground: '121.900' },
    streamUrl: 'https://d.liveatc.net/kaus3_twr',
  },
  {
    icao: 'KLAX',
    iata: 'LAX',
    name: 'Los Angeles Intl',
    city: 'Los Angeles',
    country: 'US',
    lat: 33.9425,
    lon: -118.4081,
    elevationM: 38,
    frequencies: { tower: '120.950', approach: '124.900', atis: '133.800', ground: '121.650' },
    streamUrl: 'https://d.liveatc.net/klax_twr',
  },
  {
    icao: 'KSFO',
    iata: 'SFO',
    name: 'San Francisco Intl',
    city: 'San Francisco',
    country: 'US',
    lat: 37.6188,
    lon: -122.3750,
    elevationM: 4,
    frequencies: { tower: '120.500', approach: '135.650', atis: '118.850', ground: '121.800' },
    streamUrl: 'https://d.liveatc.net/ksfo_twr',
  },
  {
    icao: 'KJFK',
    iata: 'JFK',
    name: 'John F. Kennedy Intl',
    city: 'New York',
    country: 'US',
    lat: 40.6398,
    lon: -73.7789,
    elevationM: 4,
    frequencies: { tower: '119.100', approach: '125.250', atis: '128.725', ground: '121.900' },
    streamUrl: 'https://d.liveatc.net/kjfk_twr',
  },
  {
    icao: 'KLGA',
    iata: 'LGA',
    name: 'LaGuardia',
    city: 'New York',
    country: 'US',
    lat: 40.7769,
    lon: -73.8740,
    elevationM: 6,
    frequencies: { tower: '118.700', approach: '120.400', atis: '125.950', ground: '121.700' },
    streamUrl: 'https://d.liveatc.net/klga_twr',
  },
  {
    icao: 'KEWR',
    iata: 'EWR',
    name: 'Newark Liberty Intl',
    city: 'Newark',
    country: 'US',
    lat: 40.6925,
    lon: -74.1687,
    elevationM: 5,
    frequencies: { tower: '118.300', approach: '128.550', atis: '114.700', ground: '121.800' },
    streamUrl: 'https://d.liveatc.net/kewr_twr',
  },
  {
    icao: 'KORD',
    iata: 'ORD',
    name: "O'Hare Intl",
    city: 'Chicago',
    country: 'US',
    lat: 41.9742,
    lon: -87.9073,
    elevationM: 205,
    frequencies: { tower: '120.750', approach: '119.000', atis: '135.400', ground: '121.750' },
    streamUrl: 'https://d.liveatc.net/kord_twr_all',
  },
  {
    icao: 'KATL',
    iata: 'ATL',
    name: 'Hartsfield-Jackson Atlanta Intl',
    city: 'Atlanta',
    country: 'US',
    lat: 33.6407,
    lon: -84.4277,
    elevationM: 313,
    frequencies: { tower: '119.100', approach: '127.900', atis: '119.650', ground: '121.900' },
    streamUrl: 'https://d.liveatc.net/katl_twr',
  },
  {
    icao: 'KDFW',
    iata: 'DFW',
    name: 'Dallas/Fort Worth Intl',
    city: 'Dallas',
    country: 'US',
    lat: 32.8998,
    lon: -97.0403,
    elevationM: 185,
    frequencies: { tower: '126.550', approach: '125.800', atis: '123.925', ground: '121.650' },
    streamUrl: 'https://d.liveatc.net/kdfw_twr',
  },
  {
    icao: 'KMIA',
    iata: 'MIA',
    name: 'Miami Intl',
    city: 'Miami',
    country: 'US',
    lat: 25.7959,
    lon: -80.2870,
    elevationM: 3,
    frequencies: { tower: '118.300', approach: '124.850', atis: '119.150', ground: '121.800' },
    streamUrl: 'https://d.liveatc.net/kmia_twr',
  },
  {
    icao: 'KSEA',
    iata: 'SEA',
    name: 'Seattle-Tacoma Intl',
    city: 'Seattle',
    country: 'US',
    lat: 47.4502,
    lon: -122.3088,
    elevationM: 132,
    frequencies: { tower: '119.900', approach: '125.900', atis: '118.000', ground: '121.700' },
    streamUrl: 'https://d.liveatc.net/ksea_twr',
  },
  {
    icao: 'KBOS',
    iata: 'BOS',
    name: 'Boston Logan Intl',
    city: 'Boston',
    country: 'US',
    lat: 42.3656,
    lon: -71.0096,
    elevationM: 6,
    frequencies: { tower: '128.800', approach: '120.600', atis: '135.000', ground: '121.900' },
    streamUrl: 'https://d.liveatc.net/kbos1_twr',
  },
  {
    icao: 'KDEN',
    iata: 'DEN',
    name: 'Denver Intl',
    city: 'Denver',
    country: 'US',
    lat: 39.8561,
    lon: -104.6737,
    elevationM: 1656,
    frequencies: { tower: '135.300', approach: '128.250', atis: '125.600', ground: '121.850' },
    streamUrl: 'https://d.liveatc.net/kden_twr',
  },
  {
    icao: 'KLAS',
    iata: 'LAS',
    name: 'Harry Reid Intl',
    city: 'Las Vegas',
    country: 'US',
    lat: 36.0840,
    lon: -115.1537,
    elevationM: 665,
    frequencies: { tower: '118.700', approach: '125.900', atis: '132.400', ground: '121.900' },
    streamUrl: 'https://d.liveatc.net/klas_twr',
  },
  {
    icao: 'KPHX',
    iata: 'PHX',
    name: 'Phoenix Sky Harbor Intl',
    city: 'Phoenix',
    country: 'US',
    lat: 33.4373,
    lon: -112.0078,
    elevationM: 346,
    frequencies: { tower: '120.900', approach: '128.650', atis: '127.575', ground: '121.900' },
    streamUrl: 'https://d.liveatc.net/kphx_twr',
  },
  {
    icao: 'KIAH',
    iata: 'IAH',
    name: 'George Bush Intercontinental',
    city: 'Houston',
    country: 'US',
    lat: 29.9902,
    lon: -95.3368,
    elevationM: 30,
    frequencies: { tower: '127.300', approach: '119.700', atis: '124.050', ground: '121.700' },
    streamUrl: 'https://d.liveatc.net/kiah_twr',
  },
  {
    icao: 'KIAD',
    iata: 'IAD',
    name: 'Washington Dulles Intl',
    city: 'Washington DC',
    country: 'US',
    lat: 38.9531,
    lon: -77.4565,
    elevationM: 95,
    frequencies: { tower: '120.100', approach: '126.150', atis: '134.850', ground: '121.900' },
    streamUrl: 'https://d.liveatc.net/kiad_twr',
  },
  {
    icao: 'KDCA',
    iata: 'DCA',
    name: 'Ronald Reagan Washington National',
    city: 'Washington DC',
    country: 'US',
    lat: 38.8512,
    lon: -77.0402,
    elevationM: 5,
    frequencies: { tower: '119.100', approach: '119.850', atis: '132.650', ground: '121.700' },
    streamUrl: 'https://d.liveatc.net/kdca_twr',
  },
  {
    icao: 'CYYZ',
    iata: 'YYZ',
    name: 'Toronto Pearson Intl',
    city: 'Toronto',
    country: 'CA',
    lat: 43.6777,
    lon: -79.6248,
    elevationM: 173,
    frequencies: { tower: '118.700', approach: '128.800', atis: '120.825', ground: '121.900' },
    streamUrl: 'https://d.liveatc.net/cyyz_twr',
  },
  {
    icao: 'CYVR',
    iata: 'YVR',
    name: 'Vancouver Intl',
    city: 'Vancouver',
    country: 'CA',
    lat: 49.1967,
    lon: -123.1815,
    elevationM: 4,
    frequencies: { tower: '118.700', approach: '125.200', atis: '124.600', ground: '121.700' },
    streamUrl: 'https://d.liveatc.net/cyvr_twr',
  },

  // --- Europe ---
  {
    icao: 'EGLL',
    iata: 'LHR',
    name: 'London Heathrow',
    city: 'London',
    country: 'GB',
    lat: 51.4700,
    lon: -0.4543,
    elevationM: 25,
    frequencies: { tower: '118.500', approach: '119.725', atis: '128.075', ground: '121.900' },
    streamUrl: 'https://d.liveatc.net/egll_twr',
  },
  {
    icao: 'EGKK',
    iata: 'LGW',
    name: 'London Gatwick',
    city: 'London',
    country: 'GB',
    lat: 51.1537,
    lon: -0.1821,
    elevationM: 62,
    frequencies: { tower: '124.225', approach: '126.825', atis: '136.525', ground: '121.800' },
    streamUrl: 'https://d.liveatc.net/egkk_twr',
  },
  {
    icao: 'EHAM',
    iata: 'AMS',
    name: 'Amsterdam Schiphol',
    city: 'Amsterdam',
    country: 'NL',
    lat: 52.3105,
    lon: 4.7683,
    elevationM: -3,
    frequencies: { tower: '119.050', approach: '121.200', atis: '122.200', ground: '121.700' },
    streamUrl: 'https://d.liveatc.net/eham_del',
  },
  {
    icao: 'LFPG',
    iata: 'CDG',
    name: 'Paris Charles de Gaulle',
    city: 'Paris',
    country: 'FR',
    lat: 49.0097,
    lon: 2.5479,
    elevationM: 119,
    frequencies: { tower: '120.900', approach: '121.150', atis: '127.125', ground: '121.800' },
    streamUrl: 'https://d.liveatc.net/lfpg_twr',
  },
  {
    icao: 'EDDF',
    iata: 'FRA',
    name: 'Frankfurt Airport',
    city: 'Frankfurt',
    country: 'DE',
    lat: 50.0379,
    lon: 8.5622,
    elevationM: 111,
    frequencies: { tower: '119.900', approach: '120.150', atis: '118.025', ground: '121.800' },
    streamUrl: 'https://d.liveatc.net/eddf_twr',
  },
  {
    icao: 'LEMD',
    iata: 'MAD',
    name: 'Madrid-Barajas',
    city: 'Madrid',
    country: 'ES',
    lat: 40.4839,
    lon: -3.5680,
    elevationM: 610,
    frequencies: { tower: '118.150', approach: '124.025', atis: '118.250', ground: '121.700' },
    streamUrl: 'https://d.liveatc.net/lemd_twr',
  },
  {
    icao: 'LEBL',
    iata: 'BCN',
    name: 'Barcelona-El Prat',
    city: 'Barcelona',
    country: 'ES',
    lat: 41.2974,
    lon: 2.0833,
    elevationM: 4,
    frequencies: { tower: '118.100', approach: '119.100', atis: '121.975', ground: '121.650' },
    streamUrl: 'https://d.liveatc.net/lebl_twr',
  },
  {
    icao: 'LSZH',
    iata: 'ZRH',
    name: 'Zurich Airport',
    city: 'Zurich',
    country: 'CH',
    lat: 47.4582,
    lon: 8.5555,
    elevationM: 432,
    frequencies: { tower: '118.100', approach: '118.000', atis: '128.525', ground: '121.900' },
    streamUrl: 'https://d.liveatc.net/lszh_twr',
  },
  {
    icao: 'LIRF',
    iata: 'FCO',
    name: 'Rome Fiumicino',
    city: 'Rome',
    country: 'IT',
    lat: 41.8003,
    lon: 12.2389,
    elevationM: 5,
    frequencies: { tower: '118.700', approach: '125.500', atis: '126.125', ground: '121.900' },
    streamUrl: 'https://d.liveatc.net/lirf_twr',
  },
  {
    icao: 'LOWW',
    iata: 'VIE',
    name: 'Vienna Intl',
    city: 'Vienna',
    country: 'AT',
    lat: 48.1103,
    lon: 16.5697,
    elevationM: 183,
    frequencies: { tower: '119.400', approach: '118.775', atis: '121.725', ground: '121.775' },
    streamUrl: 'https://d.liveatc.net/loww_twr',
  },

  // --- Asia & Middle East ---
  {
    icao: 'RJTT',
    iata: 'HND',
    name: 'Tokyo Haneda',
    city: 'Tokyo',
    country: 'JP',
    lat: 35.5494,
    lon: 139.7798,
    elevationM: 11,
    frequencies: { tower: '118.100', approach: '119.100', atis: '128.800', ground: '121.700' },
    streamUrl: 'https://d.liveatc.net/rjtt_twr',
  },
  {
    icao: 'RJAA',
    iata: 'NRT',
    name: 'Tokyo Narita',
    city: 'Tokyo',
    country: 'JP',
    lat: 35.7647,
    lon: 140.3863,
    elevationM: 43,
    frequencies: { tower: '118.200', approach: '124.400', atis: '128.250', ground: '121.950' },
    streamUrl: 'https://d.liveatc.net/rjaa_twr',
  },
  {
    icao: 'VHHH',
    iata: 'HKG',
    name: 'Hong Kong Intl',
    city: 'Hong Kong',
    country: 'HK',
    lat: 22.3080,
    lon: 113.9185,
    elevationM: 9,
    frequencies: { tower: '118.400', approach: '119.100', atis: '128.200', ground: '121.600' },
    streamUrl: 'https://d.liveatc.net/vhhh_twr',
  },
  {
    icao: 'WSSS',
    iata: 'SIN',
    name: 'Singapore Changi',
    city: 'Singapore',
    country: 'SG',
    lat: 1.3644,
    lon: 103.9915,
    elevationM: 7,
    frequencies: { tower: '118.600', approach: '120.300', atis: '128.600', ground: '121.725' },
    streamUrl: 'https://d.liveatc.net/wsss_twr',
  },
  {
    icao: 'OMDB',
    iata: 'DXB',
    name: 'Dubai Intl',
    city: 'Dubai',
    country: 'AE',
    lat: 25.2532,
    lon: 55.3657,
    elevationM: 19,
    frequencies: { tower: '119.550', approach: '124.900', atis: '131.700', ground: '118.350' },
    streamUrl: 'https://d.liveatc.net/omdb_twr',
  },
  {
    icao: 'OTHH',
    iata: 'DOH',
    name: 'Hamad Intl',
    city: 'Doha',
    country: 'QA',
    lat: 25.2731,
    lon: 51.6081,
    elevationM: 4,
    frequencies: { tower: '118.050', approach: '119.750', atis: '126.550', ground: '121.750' },
    streamUrl: 'https://d.liveatc.net/othh_twr',
  },

  // --- Australia & Oceania ---
  {
    icao: 'YSSY',
    iata: 'SYD',
    name: 'Sydney Kingsford Smith',
    city: 'Sydney',
    country: 'AU',
    lat: -33.9399,
    lon: 151.1753,
    elevationM: 6,
    frequencies: { tower: '120.500', approach: '124.400', atis: '126.250', ground: '121.700' },
    streamUrl: 'https://d.liveatc.net/yssy_twr',
  },
  {
    icao: 'YMML',
    iata: 'MEL',
    name: 'Melbourne Airport',
    city: 'Melbourne',
    country: 'AU',
    lat: -37.6690,
    lon: 144.8410,
    elevationM: 132,
    frequencies: { tower: '120.500', approach: '132.000', atis: '128.000', ground: '121.700' },
    streamUrl: 'https://d.liveatc.net/ymml_twr',
  },

  // --- Latin America & Africa ---
  {
    icao: 'MMMX',
    iata: 'MEX',
    name: 'Mexico City Intl',
    city: 'Mexico City',
    country: 'MX',
    lat: 19.4361,
    lon: -99.0719,
    elevationM: 2230,
    frequencies: { tower: '118.500', approach: '121.200', atis: '127.650', ground: '121.900' },
    streamUrl: 'https://d.liveatc.net/mmmx_twr',
  },
  {
    icao: 'SBGR',
    iata: 'GRU',
    name: 'São Paulo/Guarulhos Intl',
    city: 'São Paulo',
    country: 'BR',
    lat: -23.4356,
    lon: -46.4731,
    elevationM: 750,
    frequencies: { tower: '118.000', approach: '119.600', atis: '127.750', ground: '121.900' },
    streamUrl: 'https://d.liveatc.net/sbgr_twr',
  },
  {
    icao: 'FACT',
    iata: 'CPT',
    name: 'Cape Town Intl',
    city: 'Cape Town',
    country: 'ZA',
    lat: -33.9715,
    lon: 18.6021,
    elevationM: 46,
    frequencies: { tower: '118.100', approach: '119.700', atis: '127.000', ground: '121.900' },
    streamUrl: 'https://d.liveatc.net/fact_twr',
  },
]);

/**
 * Fast ICAO lookup map.
 */
export const AIRPORT_BY_ICAO = new Map(GLOBAL_AIRPORTS.map((a) => [a.icao.toUpperCase(), a]));

/**
 * Find the nearest airport to a given coordinate within an optional maximum distance.
 * @param {number} lat
 * @param {number} lon
 * @param {number} [maxDistanceM=Number.POSITIVE_INFINITY]
 * @param {Array<object>} [airports=GLOBAL_AIRPORTS]
 * @returns {{ airport: object, distanceM: number, distanceNm: number } | null}
 */
export function findNearestAirport(lat, lon, maxDistanceM = Number.POSITIVE_INFINITY, airports = GLOBAL_AIRPORTS) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  let bestAirport = null;
  let minDistanceM = Number.POSITIVE_INFINITY;

  for (const airport of airports) {
    const dist = greatCircleDistanceM(lat, lon, airport.lat, airport.lon);
    if (dist < minDistanceM && dist <= maxDistanceM) {
      minDistanceM = dist;
      bestAirport = airport;
    }
  }

  if (!bestAirport) return null;

  return {
    airport: bestAirport,
    distanceM: minDistanceM,
    distanceNm: metersToNauticalMiles(minDistanceM),
  };
}

/**
 * Get an airport record by ICAO code.
 * @param {string} icao
 * @returns {object|null}
 */
export function getAirportByIcao(icao) {
  if (!icao || typeof icao !== 'string') return null;
  return AIRPORT_BY_ICAO.get(icao.trim().toUpperCase()) || null;
}

export const ATC_AIRPORTS = GLOBAL_AIRPORTS;
