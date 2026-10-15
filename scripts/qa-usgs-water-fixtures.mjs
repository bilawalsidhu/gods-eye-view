// Invented locations and observations, shared by focused units and browser QA.
export function usgsWaterFixtures(now) {
  const make = (id, properties, geometry = null) => ({
    type: 'Feature',
    id,
    properties,
    geometry,
  });
  const definitions = [
    [
      'stage-a',
      'USGS-08100001',
      '00065',
      '-0.75',
      'ft',
      'Gage height',
      'Upstream',
    ],
    [
      'stage-b',
      'USGS-08100001',
      '00065',
      '0.00',
      'ft',
      'Gage height',
      'Downstream',
    ],
    ['flow', 'USGS-08100001', '00060', null, 'ft^3/s', 'Discharge', null],
    [
      'rain',
      'USGS-08100001',
      '00045',
      '0.00',
      'in',
      'Precipitation, total',
      null,
    ],
    [
      'well-null',
      'USGS-295000098200001',
      '72019',
      null,
      'ft',
      'Depth below land surface',
      'Sensor A',
    ],
    [
      'well-blank',
      'USGS-295000098200001',
      '72019',
      '  ',
      'ft',
      'Depth below land surface',
      'Sensor B',
    ],
    [
      'well-text',
      'USGS-295000098200001',
      '72019',
      'Ice',
      'ft',
      'Depth below land surface',
      'Sensor C',
    ],
  ];
  const observedTime = new Date(now - 15 * 60000).toISOString();
  const observations = definitions.map(([id, site, parameter, value, unit]) =>
    make(`obs-${id}`, {
      time_series_id: id,
      monitoring_location_id: site,
      parameter_code: parameter,
      statistic_id: '00011',
      time: observedTime,
      value,
      unit_of_measure: unit,
      approval_status: 'Provisional',
      qualifier: value === null ? ['UNAVAIL'] : null,
      last_modified: new Date(now).toISOString(),
    }),
  );
  const series = definitions.map(
    ([id, site, parameter, _value, unit, name, sublocation]) =>
      make(id, {
        id,
        monitoring_location_id: site,
        parameter_code: parameter,
        statistic_id: '00011',
        parameter_name: name,
        parameter_description:
          name === 'Gage height' ? 'Gage height, feet' : name,
        unit_of_measure: unit,
        sublocation_identifier: sublocation,
        computation_identifier: 'Instantaneous',
        computation_period_identifier: 'Points',
        web_description: null,
      }),
  );
  const stations = [
    make(
      'USGS-08100001',
      {
        id: 'USGS-08100001',
        monitoring_location_name:
          'QA Creek <img src=qa-water-injection onerror=window.__waterInjection=1>',
        agency_code: 'USGS',
        state_code: '48',
        state_name: 'Texas',
        county_code: '029',
        county_name: 'Bexar County',
        site_type: 'Stream',
      },
      { type: 'Point', coordinates: [-98.5, 29.42] },
    ),
    make(
      'USGS-295000098200001',
      {
        id: 'USGS-295000098200001',
        monitoring_location_name: 'QA Neighbor Well',
        agency_code: 'USGS',
        state_code: '48',
        state_name: 'Texas',
        county_code: '091',
        county_name: 'Comal County',
        site_type: 'Well',
      },
      { type: 'Point', coordinates: [-98.492, 29.424] },
    ),
  ];
  return { observations, stations, series };
}

export function usgsWaterFixturePage(
  input,
  now,
  { pageSize = 2, fixtures = usgsWaterFixtures(now), matched = false } = {},
) {
  const url = new URL(input);
  const collection = url.pathname.split('/').at(-2);
  const source = {
    'latest-continuous': fixtures.observations,
    'monitoring-locations': fixtures.stations,
    'time-series-metadata': fixtures.series,
  }[collection];
  if (!source) throw new Error('Unexpected fixture collection');
  let rows = source;
  if (collection !== 'latest-continuous') {
    const filter = url.searchParams.get('filter') || '';
    if (
      url.searchParams.get('filter-lang') !== 'cql2-text' ||
      !/^id IN \(/.test(filter)
    )
      throw new Error('Unexpected metadata query');
    const ids = [...filter.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    rows = rows.filter((row) => ids.includes(row.id));
  } else if (!url.searchParams.get('bbox') || !url.searchParams.get('datetime'))
    throw new Error('Missing observation scope');
  const offset = Number(url.searchParams.get('cursor') || 0);
  const size = Math.min(pageSize, Number(url.searchParams.get('limit')));
  const features = structuredClone(rows.slice(offset, offset + size));
  const links = [];
  if (offset + size < rows.length) {
    const next = new URL(url);
    next.searchParams.set('cursor', String(offset + size));
    links.push({ rel: 'next', href: next.href, type: 'application/geo+json' });
  }
  return {
    type: 'FeatureCollection',
    features,
    numberReturned: features.length,
    ...(matched ? { numberMatched: rows.length } : {}),
    links,
  };
}
