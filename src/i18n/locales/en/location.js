/**
 * LOCATION tray: mini-status copy, toasts, orbit indicator and the curated
 * city/POI display names. The pack names mirror CITY_POIS records one-to-one;
 * records outside the pack fall back to their own `name` field.
 */
export default {
  status: {
    emptyCity: '📍 Location: --',
    emptyPoi: 'Landmark: --',
    searched: 'Searched location',
  },
  toast: {
    notFound: 'Location not found',
    searchFailed: 'Search failed',
    outlineUnavailable: 'Detailed outline unavailable',
  },
  orbit: {
    first: 'Fly to a POI first',
    label: 'ORBIT',
  },
  aria: {
    resettingGlobe: 'Resetting to full globe view',
    resetCockpit: 'Reset cockpit to full globe view',
    resettingCockpit: 'Resetting cockpit to full globe view',
  },
  cities: {
    austin: {
      name: 'Austin',
      pois: [
        'Texas State Capitol',
        'Frost Bank Tower',
        'Pennybacker Bridge',
        'The Jenga Tower',
        'UT Tower',
      ],
    },
    sf: {
      name: 'San Francisco',
      pois: [
        'Golden Gate Bridge',
        'Transamerica Pyramid',
        'Salesforce Tower',
        'Alcatraz Island',
        'Coit Tower',
      ],
    },
    nyc: {
      name: 'New York',
      pois: [
        'Statue of Liberty',
        'Empire State Building',
        'One World Trade Center',
        'Brooklyn Bridge',
        'Chrysler Building',
      ],
    },
    tokyo: {
      name: 'Tokyo',
      pois: [
        'Tokyo Tower',
        'Tokyo Skytree',
        'Imperial Palace',
        'Senso-ji Temple',
        'Mode Gakuen Cocoon Tower',
      ],
    },
    london: {
      name: 'London',
      pois: [
        'Tower Bridge',
        'The Shard',
        'Big Ben / Parliament',
        "St. Paul's Cathedral",
        'The Gherkin',
      ],
    },
    paris: {
      name: 'Paris',
      pois: [
        'Eiffel Tower',
        'Arc de Triomphe',
        'Notre-Dame',
        'Sacré-Cœur',
        'Louvre Pyramid',
      ],
    },
    dubai: {
      name: 'Dubai',
      pois: [
        'Burj Khalifa',
        'Burj Al Arab',
        'Palm Jumeirah',
        'Dubai Frame',
        'Museum of the Future',
      ],
    },
    dc: {
      name: 'Washington DC',
      pois: [
        'US Capitol',
        'Washington Monument',
        'Lincoln Memorial',
        'Pentagon',
        'Jefferson Memorial',
      ],
    },
    tallinn: {
      name: 'Tallinn',
      pois: [
        'Viru Square',
        'Old Town / Raekoja plats',
        'Teatri väljak',
        'Port of Tallinn',
        'Ülemiste',
      ],
    },
  },
};
