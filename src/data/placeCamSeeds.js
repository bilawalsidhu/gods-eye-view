/**
 * @module data/placeCamSeeds
 * @description Curated registry of notable places that have a public YouTube
 * **live** webcam, folded into the CCTV layer as `feedType: 'youtube'` cameras.
 * Each shows as a marker on the globe; selecting one opens the CCTV panel.
 *
 *  - `videoIds` — ordered candidate YouTube video ids the panel probes and plays
 *    INLINE. Each id is validated against the watch page's `playabilityStatus`
 *    (NOT just oEmbed — oEmbed returns 200 for an ended stream whose recording
 *    is gone). Ids reporting `OK` / `isLive` are kept, ordered currently-live
 *    first; `UNPLAYABLE` ("this live stream recording is not available") ids are
 *    dropped. Live-stream ids still rot when a channel restarts its broadcast,
 *    so the panel walks the list on embed error / no-play timeout, then falls
 *    back to the button below. Entries with no dependable live id ship none.
 *  - `watchUrl` — a YouTube search **filtered to live results** for that place's
 *    cam (the `sp=EgJAAQ%3D%3D` filter). The panel's "OPEN LIVE STREAM" button
 *    uses it, so every marker is one click from a real, current stream even when
 *    the inline ids have all rotated away.
 *
 * Attribution: `src/data/dataCredits.js` (`youtube-placecams`).
 */

/** YouTube search filter that restricts results to currently-live streams. */
const LIVE_FILTER = 'sp=EgJAAQ%3D%3D';

/** @param {string} query @returns {string} YouTube live-filtered search URL. */
const search = (query) =>
  `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&${LIVE_FILTER}`;

/**
 * @typedef {object} PlaceCamSeed
 * @property {string} id       Stable camera id (prefixed `place-`).
 * @property {string} label
 * @property {string} city
 * @property {string} country
 * @property {number} lat
 * @property {number} lon
 * @property {string[]} videoIds  Ordered candidate YouTube video ids (may be empty).
 * @property {string} watchUrl    Fallback: a live-filtered YouTube search for the place's cam.
 */

/** Build an entry; `videoIds` defaults to none, `watchUrl` to a live-cam search. */
const cam = (id, label, city, country, lat, lon, videoIds = []) => ({
  id, label, city, country, lat, lon, videoIds,
  watchUrl: search(`${label} ${city} live cam`),
});

/** @type {ReadonlyArray<PlaceCamSeed>} */
export const PLACE_CAM_SEEDS = Object.freeze([
  // ── City crossings, squares & streets ─────────────────────────────
  cam('place-nyc-times-square', 'Times Square', 'New York', 'USA', 40.7570, -73.9860,
    ['VjSIXFwB_WQ']),
  cam('place-tokyo-shibuya', 'Shibuya Scramble Crossing', 'Tokyo', 'Japan', 35.6595, 139.7005,
    ['dfVK7ld38Ys', 'pM_NifRh0RQ']),
  cam('place-london-abbey-road', 'Abbey Road Crossing', 'London', 'UK', 51.5320, -0.1779,
    ['zMCea32gpmg']),
  cam('place-neworleans-bourbon', 'Bourbon Street', 'New Orleans', 'USA', 29.9585, -90.0648,
    ['QhFYcPBmkcI']),
  cam('place-dublin-temple-bar', 'Temple Bar', 'Dublin', 'Ireland', 53.3453, -6.2637,
    ['3nyPER2kzqk', 'D_zdsCpFvWA']),
  cam('place-jackson-town-square', 'Town Square', 'Jackson Hole', 'USA', 43.4799, -110.7624,
    ['1EiC9bvVGnk', 'DoUOrTJbIu4']),
  cam('place-nashville-broadway', 'Lower Broadway', 'Nashville', 'USA', 36.1601, -86.7761,
    ['v3xkN0kMzqg']),
  cam('place-vegas-fremont', 'Fremont Street', 'Las Vegas', 'USA', 36.1699, -115.1421,
    ['ZvYvZLfPatQ']),
  cam('place-keywest-duval', 'Duval Street', 'Key West', 'USA', 24.5601, -81.8009,
    ['cjhviN6wsSI', 'lcVm-Izrpa0', 'HDlmUp4JBLg']),
  cam('place-prague-oldtown', 'Old Town Square', 'Prague', 'Czechia', 50.0875, 14.4213,
    ['0FvTdT3EJY4']),
  cam('place-venice-rialto', 'Rialto Bridge', 'Venice', 'Italy', 45.4380, 12.3358,
    ['Kmf_wiTFuXY']),
  cam('place-rome-spanish-steps', 'Piazza di Spagna', 'Rome', 'Italy', 41.9058, 12.4823),
  cam('place-venicebeach-ca', 'Venice Beach Boardwalk', 'Los Angeles', 'USA', 33.9850, -118.4695,
    ['98jOtUeM3m8', 'EO_1LWqsCNE']),
  cam('place-miami-beach', 'South Beach', 'Miami', 'USA', 25.7826, -80.1300,
    ['kwk3-KWmnrk']),
  cam('place-dubrovnik-oldport', 'Old Port', 'Dubrovnik', 'Croatia', 42.6412, 18.1116),
  // Hallstatt dropped: no YouTube live stream exists — the only public cam is a
  // daily-refreshed still on dachstein.salzkammergut.at, not a live feed.
  // Copacabana: EarthCam's stream ID rotated and the old recording is gone;
  // no current dependable YouTube live id — rides the OPEN LIVE STREAM search.
  cam('place-copacabana', 'Copacabana Beach', 'Rio de Janeiro', 'Brazil', -22.9711, -43.1822),

  // ── Landmarks & skylines ──────────────────────────────────────────
  cam('place-paris-eiffel', 'Eiffel Tower', 'Paris', 'France', 48.8584, 2.2945,
    ['eoyvZBOn3ZU']),
  cam('place-nyc-empire', 'Empire State & Midtown', 'New York', 'USA', 40.7484, -73.9857),
  cam('place-sf-goldengate', 'Golden Gate Bridge', 'San Francisco', 'USA', 37.8199, -122.4783),
  cam('place-seattle-spaceneedle', 'Space Needle & Skyline', 'Seattle', 'USA', 47.6205, -122.3493),
  cam('place-sydney-operahouse', 'Opera House & Harbour', 'Sydney', 'Australia', -33.8568, 151.2153,
    ['5uZa3-RMFos']),
  cam('place-fuji-kawaguchiko', 'Mount Fuji', 'Kawaguchiko', 'Japan', 35.5104, 138.7699,
    ['bdUbACCWmoY']),
  cam('place-matterhorn-zermatt', 'Matterhorn', 'Zermatt', 'Switzerland', 46.0207, 7.7491),
  cam('place-niagara-falls', 'Niagara Falls', 'Niagara Falls', 'Canada', 43.0799, -79.0747,
    ['qx7gry390YA', 'UBTpYGj4cik', '7gBzLGlJnwk']),
  cam('place-vatican-stpeters', "St Peter's Square", 'Vatican City', 'Vatican', 41.9022, 12.4568,
    ['89d3tEaqImM', 'YNXui7lLcSw', '38_Ir14A_ms']),

  // ── Nature & wildlife (explore.org / Africam) ─────────────────────
  cam('place-africa-waterhole', 'Tembe Elephant Park Waterhole', 'Tembe', 'South Africa', -26.9167, 32.4167,
    ['0P_LBKqVbfs', 'gdrNUUf-cQw']),
  cam('place-katmai-brooksfalls', 'Brooks Falls Bears', 'Katmai', 'USA', 58.5561, -155.7797,
    ['J7ZrIDvqlic', 'EwTH5yY7Mks']),
  cam('place-namibia-waterhole', 'Namibia Waterhole', 'Namib Desert', 'Namibia', -23.5000, 15.5000,
    ['gC43pyCDi4M']),
  cam('place-decorah-eagles', 'Decorah Bald Eagles', 'Decorah', 'USA', 43.3033, -91.7854,
    ['IVmL3diwJuw']),
  cam('place-monterey-kelp', 'Monterey Bay Kelp Forest', 'Monterey', 'USA', 36.6182, -121.9015,
    ['w3LjpFhySTg']),
  cam('place-monterey-jellies', 'Monterey Bay Jellies', 'Monterey', 'USA', 36.6182, -121.9015,
    ['eQ_foBERmzA', 'zL68biE6wAs']),
  cam('place-panda-chengdu', 'Panda Cam', 'Chengdu', 'China', 30.7333, 104.0167,
    ['V7MUP69nLqA', 'ufeOVrV8piw']),
  cam('place-aurora-churchill', 'Northern Lights', 'Churchill', 'Canada', 58.7684, -94.1650,
    ['a0i1Kg6fROg']),
  cam('place-oldfaithful', 'Old Faithful Geyser', 'Yellowstone', 'USA', 44.4605, -110.8281,
    ['lACNgkIio0c', '2Mo9WDT1xTY', 'uW883pZxDac']),
  cam('place-bigsur-condors', 'Big Sur Condors', 'Big Sur', 'USA', 36.2704, -121.8081),
  cam('place-kruger-nkorho', 'Nkorho Bush Lodge', 'Sabi Sand', 'South Africa', -24.7500, 31.5000,
    ['dIChLG4_WNs']),

  // ── Volcanoes & geology ──────────────────────────────────────────
  cam('place-kilauea', 'Kīlauea Caldera', 'Hawaiʻi', 'USA', 19.4069, -155.2834,
    ['FVdmnpJ2kM0', 'LZkFH1EFmF8']),
  cam('place-etna', 'Mount Etna', 'Catania', 'Italy', 37.7510, 14.9934,
    ['EGk3Mr0OshE', '6-WqLFrrAtw']),
  cam('place-iceland-volcano', 'Reykjanes Volcano', 'Reykjanes', 'Iceland', 63.8900, -22.2700,
    ['qkSvU9j4kqM']),
  cam('place-stromboli', 'Stromboli', 'Aeolian Islands', 'Italy', 38.7890, 15.2130,
    ['eGWaJYQgYIE']),

  // ── Water: harbours, beaches, reefs ──────────────────────────────
  cam('place-maho-beach', 'Maho Beach Plane Spotting', 'Sint Maarten', 'Sint Maarten', 18.0400, -63.1200,
    ['iSeH45R-8R0', '2IQmpCXbOmM']),
  // Waikiki: EarthCam / hotel stream ids all rotated; no current dependable
  // YouTube live id — rides the OPEN LIVE STREAM search.
  cam('place-waikiki', 'Waikiki Beach', 'Honolulu', 'USA', 21.2765, -157.8271),
  cam('place-capetown-tablebay', 'Table Bay & Table Mountain', 'Cape Town', 'South Africa', -33.9036, 18.4180,
    ['vOLCjL4kv-w', 'jOqASqt3vVI']),
  cam('place-venicebeach-fl', 'Venice Fishing Pier', 'Venice, FL', 'USA', 27.0731, -82.4537),
  cam('place-gibraltar-strait', 'Strait of Gibraltar', 'Tarifa', 'Spain', 36.0128, -5.6067),
  cam('place-nazare', 'Nazaré Big Waves', 'Nazaré', 'Portugal', 39.6039, -9.0866,
    ['ehP7yH4W4Fc']),
  cam('place-scripps-lajolla', 'La Jolla Cove', 'San Diego', 'USA', 32.8503, -117.2720),

  // ── Airports & transport ────────────────────────────────────────
  cam('place-lax-approach', 'LAX Runway 25L', 'Los Angeles', 'USA', 33.9416, -118.4085,
    ['KzsNnyN8D_Q', 'A7udErqk2ho']),
  cam('place-schiphol', 'Amsterdam Schiphol', 'Amsterdam', 'Netherlands', 52.3105, 4.7683),
  cam('place-heathrow', 'London Heathrow', 'London', 'UK', 51.4700, -0.4543,
    ['9C2DOPJ5EsU', 'H70RQ3mfDHA', 'nVLZHM_1qVE']),
  // Innsbruck dropped: no YouTube live stream — feratel / PANOMAX webcam sites only.

  // ── Ski & mountain resorts ──────────────────────────────────────
  cam('place-zermatt-village', 'Zermatt Village', 'Zermatt', 'Switzerland', 46.0207, 7.7491),
  cam('place-chamonix', 'Chamonix & Mont Blanc', 'Chamonix', 'France', 45.9237, 6.8694),
  cam('place-whistler', 'Whistler Village', 'Whistler', 'Canada', 50.1163, -122.9574),
  cam('place-aspen', 'Aspen Mountain', 'Aspen', 'USA', 39.1863, -106.8175),

  // ── More cities ────────────────────────────────────────────────
  cam('place-chicago-river', 'Chicago River & Loop', 'Chicago', 'USA', 41.8879, -87.6270,
    ['O0UGT7AT3aw']),
  cam('place-boston-harbor', 'Boston Harbor', 'Boston', 'USA', 42.3540, -71.0490),
  cam('place-toronto-skyline', 'Toronto Skyline', 'Toronto', 'Canada', 43.6426, -79.3871,
    ['bbjwotvAvDM']),
  cam('place-hongkong-victoria', 'Victoria Harbour', 'Hong Kong', 'China', 22.2940, 114.1722,
    ['bNOWG3jcOlQ', '4KU_8MwEfFc']),
  cam('place-singapore-marinabay', 'Marina Bay', 'Singapore', 'Singapore', 1.2834, 103.8607,
    ['nXdp7DkqAcc', 'LhsIlmvwEbc']),
]);

const _byId = new Map(PLACE_CAM_SEEDS.map((seed) => [seed.id, seed]));

/** @param {string} id @returns {PlaceCamSeed|null} */
export function placeCamById(id) {
  return _byId.get(String(id)) || null;
}

/** @returns {string[]} All place-cam ids. */
export function placeCamIds() {
  return [..._byId.keys()];
}
