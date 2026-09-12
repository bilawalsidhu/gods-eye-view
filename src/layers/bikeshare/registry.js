function buildBcycleUrls(systemId) {
  return {
    stationInformationUrl: `https://gbfs.bcycle.com/${systemId}/station_information.json`,
    stationStatusUrl: `https://gbfs.bcycle.com/${systemId}/station_status.json`,
  };
}
function bcycleEntry({
  id,
  city,
  centerLat,
  centerLon,
  systemId,
  loadRadiusKm = 100,
  provider = 'BCycle',
}) {
  return {
    id,
    city,
    centerLat,
    centerLon,
    loadRadiusKm,
    provider,
    ...buildBcycleUrls(systemId),
  };
}
const RAW_GBFS_CITY_REGISTRY = [
  {
    id: 'nyc-citibike',
    city: 'New York, NY',
    centerLat: 40.7484,
    centerLon: -73.9967,
    loadRadiusKm: 140,
    stationInformationUrl:
      'https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_information.json',
    stationStatusUrl:
      'https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json',
    provider: 'Citi Bike',
  },
  {
    id: 'chicago-divvy',
    city: 'Chicago, IL',
    centerLat: 41.8781,
    centerLon: -87.6298,
    loadRadiusKm: 120,
    stationInformationUrl:
      'https://gbfs.lyft.com/gbfs/2.3/chi/en/station_information.json',
    stationStatusUrl:
      'https://gbfs.lyft.com/gbfs/2.3/chi/en/station_status.json',
    provider: 'Divvy',
  },
  {
    id: 'dc-capital-bikeshare',
    city: 'Washington, DC',
    centerLat: 38.9072,
    centerLon: -77.0369,
    loadRadiusKm: 120,
    stationInformationUrl:
      'https://gbfs.lyft.com/gbfs/2.3/dca-cabi/en/station_information.json',
    stationStatusUrl:
      'https://gbfs.lyft.com/gbfs/2.3/dca-cabi/en/station_status.json',
    provider: 'Capital Bikeshare',
  },
  {
    id: 'sf-bay-wheels',
    city: 'San Francisco, CA',
    centerLat: 37.7749,
    centerLon: -122.4194,
    loadRadiusKm: 110,
    stationInformationUrl:
      'https://gbfs.lyft.com/gbfs/2.3/bay/en/station_information.json',
    stationStatusUrl:
      'https://gbfs.lyft.com/gbfs/2.3/bay/en/station_status.json',
    provider: 'Bay Wheels',
  },
  {
    id: 'boston-bluebikes',
    city: 'Boston, MA',
    centerLat: 42.3601,
    centerLon: -71.0589,
    loadRadiusKm: 100,
    stationInformationUrl:
      'https://gbfs.bluebikes.com/gbfs/en/station_information.json',
    stationStatusUrl: 'https://gbfs.bluebikes.com/gbfs/en/station_status.json',
    provider: 'Blue Bikes',
  },
  {
    id: 'philadelphia-indego',
    city: 'Philadelphia, PA',
    centerLat: 39.9526,
    centerLon: -75.1652,
    loadRadiusKm: 100,
    stationInformationUrl:
      'https://gbfs.bcycle.com/bcycle_indego/station_information.json',
    stationStatusUrl:
      'https://gbfs.bcycle.com/bcycle_indego/station_status.json',
    provider: 'Indego',
  },
  {
    id: 'portland-biketown',
    city: 'Portland, OR',
    centerLat: 45.5152,
    centerLon: -122.6784,
    loadRadiusKm: 95,
    stationInformationUrl:
      'https://gbfs.biketownpdx.com/gbfs/2.3/en/station_information.json',
    stationStatusUrl:
      'https://gbfs.biketownpdx.com/gbfs/2.3/en/station_status.json',
    provider: 'BIKETOWN',
  },
  {
    id: 'la-metro-bike',
    city: 'Los Angeles, CA',
    centerLat: 34.0522,
    centerLon: -118.2437,
    loadRadiusKm: 120,
    stationInformationUrl:
      'https://gbfs.bcycle.com/bcycle_lametro/station_information.json',
    stationStatusUrl:
      'https://gbfs.bcycle.com/bcycle_lametro/station_status.json',
    provider: 'Metro Bike',
  },
  {
    id: 'austin-capmetro',
    city: 'Austin, TX',
    centerLat: 30.2672,
    centerLon: -97.7431,
    loadRadiusKm: 90,
    stationInformationUrl:
      'https://austin.publicbikesystem.net/customer/gbfs/v2/en/station_information.json',
    stationStatusUrl:
      'https://austin.publicbikesystem.net/customer/gbfs/v2/en/station_status.json',
    provider: 'CapMetro',
  },
  {
    id: 'honolulu-biki',
    city: 'Honolulu, HI',
    centerLat: 21.3069,
    centerLon: -157.8583,
    loadRadiusKm: 90,
    stationInformationUrl:
      'https://hon.publicbikesystem.net/customer/gbfs/v2/en/station_information.json',
    stationStatusUrl:
      'https://hon.publicbikesystem.net/customer/gbfs/v2/en/station_status.json',
    provider: 'Biki',
  },
  {
    id: 'columbus-cogo',
    city: 'Columbus, OH',
    centerLat: 39.9612,
    centerLon: -82.9988,
    loadRadiusKm: 90,
    stationInformationUrl:
      'https://gbfs.cogobikeshare.com/gbfs/2.3/en/station_information.json',
    stationStatusUrl:
      'https://gbfs.cogobikeshare.com/gbfs/2.3/en/station_status.json',
    provider: 'CoGo',
  },
  {
    id: 'chattanooga-bikechatt',
    city: 'Chattanooga, TN',
    centerLat: 35.0456,
    centerLon: -85.3097,
    loadRadiusKm: 90,
    stationInformationUrl:
      'https://chat.publicbikesystem.net/customer/gbfs/v2/en/station_information.json',
    stationStatusUrl:
      'https://chat.publicbikesystem.net/customer/gbfs/v2/en/station_status.json',
    provider: 'Bike Chattanooga',
  },
  {
    id: 'sao-paulo-bike-itau',
    city: 'São Paulo, SP',
    centerLat: -23.5505,
    centerLon: -46.6333,
    loadRadiusKm: 100,
    stationInformationUrl:
      'https://saopaulo.publicbikesystem.net/customer/gbfs/v2/en/station_information.json',
    stationStatusUrl:
      'https://saopaulo.publicbikesystem.net/customer/gbfs/v2/en/station_status.json',
    provider: 'Bike Itaú',
  },
  {
    id: 'rio-de-janeiro-bike-itau',
    city: 'Rio de Janeiro, RJ',
    centerLat: -22.9068,
    centerLon: -43.1729,
    loadRadiusKm: 100,
    stationInformationUrl:
      'https://riodejaneiro.publicbikesystem.net/customer/gbfs/v2/en/station_information.json',
    stationStatusUrl:
      'https://riodejaneiro.publicbikesystem.net/customer/gbfs/v2/en/station_status.json',
    provider: 'Bike Itaú',
  },
  {
    id: 'salvador-bike-itau',
    city: 'Salvador, BA',
    centerLat: -12.9777,
    centerLon: -38.5016,
    loadRadiusKm: 90,
    stationInformationUrl:
      'https://salvador.publicbikesystem.net/customer/gbfs/v2/en/station_information.json',
    stationStatusUrl:
      'https://salvador.publicbikesystem.net/customer/gbfs/v2/en/station_status.json',
    provider: 'Bike Itaú',
  },
  {
    id: 'recife-bike-itau',
    city: 'Recife, PE',
    centerLat: -8.0476,
    centerLon: -34.877,
    loadRadiusKm: 90,
    stationInformationUrl:
      'https://recife.publicbikesystem.net/customer/gbfs/v2/en/station_information.json',
    stationStatusUrl:
      'https://recife.publicbikesystem.net/customer/gbfs/v2/en/station_status.json',
    provider: 'Bike Itaú',
  },
  {
    id: 'porto-alegre-bike-itau',
    city: 'Porto Alegre, RS',
    centerLat: -30.0346,
    centerLon: -51.2177,
    loadRadiusKm: 90,
    stationInformationUrl:
      'https://portoalegre.publicbikesystem.net/customer/gbfs/v2/en/station_information.json',
    stationStatusUrl:
      'https://portoalegre.publicbikesystem.net/customer/gbfs/v2/en/station_status.json',
    provider: 'Bike Itaú',
  },
  {
    id: 'brasilia-bike-itau',
    city: 'Brasília, DF',
    centerLat: -15.7939,
    centerLon: -47.8828,
    loadRadiusKm: 90,
    stationInformationUrl:
      'https://brasilia.publicbikesystem.net/customer/gbfs/v2/en/station_information.json',
    stationStatusUrl:
      'https://brasilia.publicbikesystem.net/customer/gbfs/v2/en/station_status.json',
    provider: 'Bike Itaú',
  },
  {
    id: 'curitiba-bike-itau',
    city: 'Curitiba, PR',
    centerLat: -25.4284,
    centerLon: -49.2733,
    loadRadiusKm: 90,
    stationInformationUrl:
      'https://curitiba.publicbikesystem.net/customer/gbfs/v2/en/station_information.json',
    stationStatusUrl:
      'https://curitiba.publicbikesystem.net/customer/gbfs/v2/en/station_status.json',
    provider: 'Bike Itaú',
  },
  bcycleEntry({
    id: 'boulder-bcycle',
    city: 'Boulder, CO',
    centerLat: 40.015,
    centerLon: -105.2705,
    systemId: 'bcycle_boulder',
  }),
  bcycleEntry({
    id: 'milwaukee-bublr',
    city: 'Milwaukee, WI',
    centerLat: 43.0389,
    centerLon: -87.9065,
    systemId: 'bcycle_bublr',
    provider: 'Bublr',
  }),
  bcycleEntry({
    id: 'madison-bcycle',
    city: 'Madison, WI',
    centerLat: 43.0731,
    centerLon: -89.4012,
    systemId: 'bcycle_madison',
  }),
  bcycleEntry({
    id: 'nashville-bcycle',
    city: 'Nashville, TN',
    centerLat: 36.1627,
    centerLon: -86.7816,
    systemId: 'bcycle_nashville',
  }),
  bcycleEntry({
    id: 'salt-lake-greenbike',
    city: 'Salt Lake City, UT',
    centerLat: 40.7608,
    centerLon: -111.891,
    systemId: 'bcycle_greenbikeslc',
    provider: 'GREENbike',
  }),
  bcycleEntry({
    id: 'san-antonio-bcycle',
    city: 'San Antonio, TX',
    centerLat: 29.4241,
    centerLon: -98.4936,
    systemId: 'bcycle_sanantonio',
  }),
  bcycleEntry({
    id: 'cincinnati-red-bike',
    city: 'Cincinnati, OH',
    centerLat: 39.1031,
    centerLon: -84.512,
    systemId: 'bcycle_cincyredbike',
    provider: 'Red Bike',
  }),
  bcycleEntry({
    id: 'el-paso-bcycle',
    city: 'El Paso, TX',
    centerLat: 31.7619,
    centerLon: -106.485,
    systemId: 'bcycle_elpaso',
  }),
  bcycleEntry({
    id: 'indianapolis-pacers',
    city: 'Indianapolis, IN',
    centerLat: 39.7684,
    centerLon: -86.1581,
    systemId: 'bcycle_pacersbikeshare',
    provider: 'Pacers Bikeshare',
  }),
  bcycleEntry({
    id: 'fort-lauderdale-broward',
    city: 'Fort Lauderdale, FL',
    centerLat: 26.1224,
    centerLon: -80.1373,
    systemId: 'bcycle_broward',
    provider: 'Broward B-cycle',
  }),
  bcycleEntry({
    id: 'memphis-bcycle',
    city: 'Memphis, TN',
    centerLat: 35.1495,
    centerLon: -90.049,
    systemId: 'bcycle_memphis',
  }),
  bcycleEntry({
    id: 'des-moines-bcycle',
    city: 'Des Moines, IA',
    centerLat: 41.5868,
    centerLon: -93.625,
    systemId: 'bcycle_desmoines',
  }),
  bcycleEntry({
    id: 'tucson-tugo',
    city: 'Tucson, AZ',
    centerLat: 32.2226,
    centerLon: -110.9747,
    systemId: 'bcycle_tugo',
    provider: 'Tugo',
  }),
  bcycleEntry({
    id: 'fort-worth-trinity',
    city: 'Fort Worth, TX',
    centerLat: 32.7555,
    centerLon: -97.3308,
    systemId: 'bcycle_fortworth',
    provider: 'Trinity Metro',
  }),
  bcycleEntry({
    id: 'omaha-heartland',
    city: 'Omaha, NE',
    centerLat: 41.2565,
    centerLon: -95.9345,
    systemId: 'bcycle_heartland',
    provider: 'Heartland B-cycle',
  }),
  bcycleEntry({
    id: 'lincoln-bikelnk',
    city: 'Lincoln, NE',
    centerLat: 40.8136,
    centerLon: -96.7026,
    systemId: 'bcycle_bikelnk',
    provider: 'BikeLNK',
  }),
  bcycleEntry({
    id: 'greenville-sc-bcycle',
    city: 'Greenville, SC',
    centerLat: 34.8526,
    centerLon: -82.394,
    systemId: 'bcycle_greenville',
  }),
  bcycleEntry({
    id: 'buffalo-reddy',
    city: 'Buffalo, NY',
    centerLat: 42.8864,
    centerLon: -78.8784,
    systemId: 'bcycle_reddy',
    provider: 'Reddy Bikeshare',
  }),
  bcycleEntry({
    id: 'las-vegas-rtc-bike-share',
    city: 'Las Vegas, NV',
    centerLat: 36.1699,
    centerLon: -115.1398,
    systemId: 'bcycle_rtcbikeshare',
    provider: 'RTC Bike Share',
  }),
  bcycleEntry({
    id: 'santa-barbara-bcycle',
    city: 'Santa Barbara, CA',
    centerLat: 34.4208,
    centerLon: -119.6982,
    systemId: 'bcycle_santabarbara',
  }),
];
function normalizeRegistryEntry(entry) {
  const id = String(entry?.id || '')
    .trim()
    .toLowerCase();
  const city = String(entry?.city || '').trim();
  const centerLat = Number(entry?.centerLat);
  const centerLon = Number(entry?.centerLon);
  const loadRadiusKm = Number(entry?.loadRadiusKm);
  const stationInformationUrl = new URL(
    String(entry?.stationInformationUrl || '').trim(),
  );
  const stationStatusUrl = new URL(
    String(entry?.stationStatusUrl || '').trim(),
  );

  if (!id) throw new Error('GBFS entry id is required');
  if (!city) throw new Error(`GBFS entry "${id}" city is required`);
  if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon)) {
    throw new Error(`GBFS entry "${id}" has invalid center coordinates`);
  }
  // Enforce HTTPS-only for GBFS feeds
  if (
    stationInformationUrl.protocol !== 'https:' ||
    stationStatusUrl.protocol !== 'https:'
  ) {
    throw new Error(`GBFS entry "${id}" must use https URLs`);
  }
  // Validate that URLs end with expected GBFS endpoint filenames
  if (!/\/station_information\.json$/i.test(stationInformationUrl.pathname)) {
    throw new Error(`GBFS entry "${id}" station_information URL is invalid`);
  }
  if (!/\/station_status\.json$/i.test(stationStatusUrl.pathname)) {
    throw new Error(`GBFS entry "${id}" station_status URL is invalid`);
  }

  // Deduplicate hostnames across both feed URLs for proxy allowlisting
  const hosts = Array.from(
    new Set([
      stationInformationUrl.hostname.toLowerCase(),
      stationStatusUrl.hostname.toLowerCase(),
    ]),
  );

  return {
    id,
    city,
    centerLat,
    centerLon,
    loadRadiusKm:
      Number.isFinite(loadRadiusKm) && loadRadiusKm > 0
        ? loadRadiusKm
        : CITY_RANGE_BASE_KM,
    stationInformationUrl: stationInformationUrl.toString(),
    stationStatusUrl: stationStatusUrl.toString(),
    provider: String(entry?.provider || 'GBFS').trim() || 'GBFS',
    hosts,
  };
}
const GBFS_CITY_REGISTRY = (() => {
  const seen = new Set();
  return RAW_GBFS_CITY_REGISTRY.map((entry) => {
    const normalized = normalizeRegistryEntry(entry);
    if (seen.has(normalized.id)) {
      throw new Error(`Duplicate GBFS city id: ${normalized.id}`);
    }
    seen.add(normalized.id);
    return normalized;
  });
})();
const CITY_BY_ID = new Map(
  GBFS_CITY_REGISTRY.map((entry) => [entry.id, entry]),
);
export { GBFS_CITY_REGISTRY, CITY_BY_ID };
