const SERVICE_ROOT =
  'https://services.arcgis.com/g1fRTDLeMgspWrYp/ArcGIS/rest/services';

export const SAN_ANTONIO_TERMS_URL =
  'https://www.sanantonio.gov/Portals/0/Files/ITSD/COSA-OpenDataPortalTermsofUs.pdf';
export const SAN_ANTONIO_ATTRIBUTION = 'City of San Antonio Parks & Recreation';
export const SAN_ANTONIO_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** City catalog entries; field lists are deliberately explicit. */
export const SAN_ANTONIO_DATASETS = Object.freeze(
  [
    {
      id: 'san-antonio-parks',
      name: 'San Antonio Parks',
      icon: '▱',
      color: '#66bb6a',
      serviceUrl: `${SERVICE_ROOT}/Park_Boundaries/FeatureServer/0`,
      datasetUrl: 'https://data.sanantonio.gov/dataset/park-boundaries',
      itemId: '29fd105cac45483f99058b1a5e2a07ac',
      publishedDate: '2017-08-21',
      geometryType: 'esriGeometryPolygon',
      geometryTypes: ['Polygon', 'MultiPolygon'],
      fields: ['OBJECTID', 'ParkID', 'ParkName', 'AltParkName', 'ParkType'],
      countLabel: 'park boundary features',
      description:
        'Park boundaries, greenways and other park-system land. Features are not a count of distinct City parks.',
    },
    {
      id: 'san-antonio-trails',
      name: 'San Antonio Trails',
      icon: '⌁',
      color: '#ffb74d',
      serviceUrl: `${SERVICE_ROOT}/Park_Trails/FeatureServer/0`,
      datasetUrl: 'https://data.sanantonio.gov/dataset/park-trails',
      itemId: '8fd478b2a1f047dc93b9d50e13a8d412',
      publishedDate: '2019-10-17',
      geometryType: 'esriGeometryPolyline',
      geometryTypes: ['LineString', 'MultiLineString'],
      fields: [
        'OBJECTID',
        'Trail_ID',
        'TrailType',
        'TrailSubtype',
        'TrailName',
        'TrailMiles',
        'TrailSource',
      ],
      countLabel: 'trail network segments',
      description:
        'Mapped trails, sidewalks, connectors, park roads and bridges. Check posted rules and current conditions before visiting.',
    },
    {
      id: 'san-antonio-trailheads',
      name: 'San Antonio Trailheads',
      icon: '●',
      color: '#4dd0e1',
      serviceUrl: `${SERVICE_ROOT}/Park_Trailheads/FeatureServer/0`,
      datasetUrl: 'https://data.sanantonio.gov/dataset/park-trailheads',
      itemId: 'ed00038f9f5c44988eb38a0bafd9a227',
      publishedDate: '2017-08-21',
      geometryType: 'esriGeometryPoint',
      geometryTypes: ['Point'],
      fields: ['OBJECTID', 'Name'],
      countLabel: 'trailhead locations',
      description:
        'Mapped trail access locations. Check posted rules and current conditions before visiting.',
    },
  ].map((dataset) =>
    Object.freeze({
      ...dataset,
      fields: Object.freeze(dataset.fields),
      geometryTypes: Object.freeze(dataset.geometryTypes),
    }),
  ),
);

export function getSanAntonioDataset(id) {
  const dataset = SAN_ANTONIO_DATASETS.find((entry) => entry.id === id);
  if (!dataset) throw new TypeError(`Unknown San Antonio dataset: ${id}`);
  return dataset;
}
