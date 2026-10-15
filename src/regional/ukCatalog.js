const ogl =
  'Contains public sector information licensed under the Open Government Licence v3.0';
export const UK_FEEDS = Object.freeze([
  {
    id: 'cameras',
    name: 'Traffic cameras',
    coverage:
      'Published London and North East camera packs; partial UK coverage',
    credit: 'Powered by TfL Open Data; © Newcastle City Council / UTMC',
    page: 'https://netrafficcams.co.uk/',
    interval: 60000,
  },
  {
    id: 'ea-floods',
    name: 'Flood warnings · England',
    coverage: 'Environment Agency warning areas in England',
    credit: `Environment Agency · ${ogl}`,
    page: 'https://check-for-flooding.service.gov.uk/',
    interval: 300000,
  },
  {
    id: 'ea-rivers',
    name: 'River levels · England',
    coverage: 'Environment Agency reporting level gauges',
    credit: `Environment Agency · ${ogl}`,
    page: 'https://environment.data.gov.uk/flood-monitoring/doc/reference',
    interval: 900000,
  },
  {
    id: 'sepa-rivers',
    name: 'River levels · Scotland',
    coverage:
      'SEPA river and tidal reporting gauges; anonymous access is rate limited',
    credit: `SEPA · ${ogl}`,
    page: 'https://timeseries.sepa.org.uk/',
    interval: 900000,
  },
  {
    id: 'air',
    name: 'Air quality stations · UK',
    coverage:
      'Defra UK-AIR station catalogue, including historical stations; select a station for its last observation',
    credit: `© Crown copyright Defra via uk-air.defra.gov.uk · ${ogl}`,
    page: 'https://uk-air.defra.gov.uk/data/about_sos',
    interval: 3600000,
  },
  {
    id: 'weather',
    name: 'Weather observations · UK airfields',
    coverage:
      'Reporting UK aviation weather stations; observations, not a street-level forecast',
    credit: 'NOAA / National Weather Service Aviation Weather Center',
    page: 'https://aviationweather.gov/data/api/',
    interval: 900000,
  },
  {
    id: 'london-roads',
    name: 'Road disruptions · London',
    coverage: 'TfL-reported road disruptions in London',
    credit: 'Powered by TfL Open Data',
    page: 'https://tfl.gov.uk/traffic/status/',
    interval: 300000,
  },
  {
    id: 'london-rail',
    name: 'Tube, rail and tram · London',
    coverage:
      'TfL Tube, DLR, Overground, Elizabeth line and tram service status',
    credit: 'Powered by TfL Open Data',
    page: 'https://tfl.gov.uk/tube-dlr-overground/status/',
    interval: 300000,
  },
  {
    id: 'wales-incidents',
    name: 'Road incidents · Wales',
    coverage:
      'Traffic Wales motorway and trunk road updates; may include cleared incidents',
    credit: 'Traffic Wales / Welsh Government',
    page: 'https://traffic.wales/',
    interval: 300000,
  },
  {
    id: 'wales-roadworks',
    name: 'Roadworks · Wales',
    coverage: 'Traffic Wales motorway and trunk road planned works',
    credit: 'Traffic Wales / Welsh Government',
    page: 'https://traffic.wales/',
    interval: 300000,
  },
  {
    id: 'ni-incidents',
    name: 'Road incidents · Northern Ireland',
    coverage:
      'TrafficwatchNI published updates; check item dates and cleared status',
    credit: 'DfI Traffic Information and Control Centre',
    page: 'https://www.trafficwatchni.com/',
    interval: 300000,
  },
  {
    id: 'ni-roadworks',
    name: 'Roadworks · Northern Ireland',
    coverage: 'TrafficwatchNI published roadworks',
    credit: 'DfI Traffic Information and Control Centre',
    page: 'https://www.trafficwatchni.com/',
    interval: 300000,
  },
  {
    id: 'ni-events',
    name: 'Road events · Northern Ireland',
    coverage: 'TrafficwatchNI published traffic and travel events',
    credit: 'DfI Traffic Information and Control Centre',
    page: 'https://www.trafficwatchni.com/',
    interval: 300000,
  },
  {
    id: 'places',
    name: 'Nearby useful places · UK',
    coverage:
      'OpenStreetMap locations within 10 km of the map centre; operation and availability are unverified',
    credit: '© OpenStreetMap contributors · ODbL',
    page: 'https://www.openstreetmap.org/copyright',
    interval: 3600000,
  },
]);

export const UK_ACCESS_SOURCES = Object.freeze([
  {
    name: 'National Highways cameras and transport feeds · England',
    status: 'Provider access / reuse licence required',
    url: 'https://nationalhighways.co.uk/roads-and-travel/live-travel-updates/traffic-cameracctv-services/crown-copyright-notice/',
  },
  {
    name: 'Traffic Scotland cameras and road feeds',
    status: 'Approved subscriber access required',
    url: 'https://www.traffic.gov.scot/traffic-scotland-developer-hub',
  },
  {
    name: 'Traffic Wales cameras',
    status: 'Restricted image service; provider permission required',
    url: 'https://traffic.wales/developers',
  },
  {
    name: 'Bus Open Data Service · England',
    status: 'Legitimate BODS account and API key required',
    url: 'https://data.bus-data.dft.gov.uk/',
  },
  {
    name: 'Natural Resources Wales floods and river data',
    status: 'Official API subscription key required',
    url: 'https://api-portal.naturalresources.wales/',
  },
  {
    name: 'National Rail real-time services',
    status: 'Official account and applicable feed terms required',
    url: 'https://opendata.nationalrail.co.uk/',
  },
  {
    name: 'North East congestion, journey times and car parks',
    status:
      'Official UTMC account required; unauthenticated access returns 401',
    url: 'https://www.netraveldata.co.uk/?page_id=9',
  },
]);

export const UK_VIEWS = Object.freeze([
  ['United Kingdom', 54.6, -3.3, 1100000],
  ['North East', 54.97, -1.6, 160000],
  ['London', 51.5074, -0.1278, 70000],
  ['Scotland', 57, -4, 650000],
  ['Wales', 52.4, -3.7, 310000],
  ['Northern Ireland', 54.65, -6.7, 220000],
  ['Northallerton', 54.34, -1.435, 20000],
  ['Peterlee', 54.76, -1.34, 20000],
  ['Nuneaton', 52.523, -1.468, 22000],
  ['Manchester', 53.48, -2.24, 70000],
  ['Birmingham', 52.486, -1.89, 70000],
  ['Bristol', 51.455, -2.587, 70000],
]);
