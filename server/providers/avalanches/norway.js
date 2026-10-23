import {
  normalizeEawsRegions,
  normalizeRegobsObservations,
  normalizeVarsomRegions,
} from '../../../src/layers/avalanches/records.js';

// Varsom / NVE regional avalanche forecasts (NLOD). Language key 2 = English.
const VARSOM_URL =
  'https://api01.nve.no/hydrology/forecast/avalanche/v6.3.0/api/RegionSummary/Simple/2';
// regObs public observation search (NLOD; credit regObs and the observer).
const REGOBS_SEARCH_URL = 'https://api.regobs.no/v5/Search';
const REGOBS_COUNT_URL = 'https://api.regobs.no/v5/Search/Count';
// EAWS micro-region outlines (CC0); ids match the Varsom region ids.
const EAWS_NO_URL =
  'https://regions.avalanches.org/micro-regions/NO_micro-regions.geojson.json';

const MIB = 1024 * 1024;
/** regObs geo-hazard id for snow, and registration type for avalanche observations. */
const REGOBS_SNOW = 10;
const REGOBS_AVALANCHE_OBS = 26;
/** One regObs page; a peak week is ~200 avalanche observations. */
const REGOBS_PAGE = 300;
const REGOBS_MAX_PAGES = 3;
/** Season weeks counted in parallel against regObs. */
const COUNT_CONCURRENCY = 4;

const regobsQuery = (from, to, extra = {}) =>
  JSON.stringify({
    SelectedGeoHazards: [REGOBS_SNOW],
    SelectedRegistrationTypes: [{ Id: REGOBS_AVALANCHE_OBS }],
    FromDtObsTime: `${from}T00:00:00`,
    ToDtObsTime: `${to}T23:59:59`,
    LangKey: 2,
    ...extra,
  });

const post = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body,
});

/**
 * Norway: Varsom forecasts, regObs observations and season counts, and EAWS
 * region outlines.
 * @param {{upstream:Function}} options Bounded JSON fetch.
 */
export function createNorwayAvalancheProvider({ upstream }) {
  return {
    id: 'varsom',

    async forecast({ from, to }) {
      const payload = await upstream(
        `${VARSOM_URL}/${from}/${to}`,
        8 * MIB,
        20_000,
      );
      return normalizeVarsomRegions(payload);
    },

    async regions() {
      return normalizeEawsRegions(await upstream(EAWS_NO_URL, 8 * MIB, 30_000));
    },

    async observations({ from, to }) {
      const rows = [];
      for (let page = 0; page < REGOBS_MAX_PAGES; page++) {
        const batch = await upstream(
          REGOBS_SEARCH_URL,
          24 * MIB,
          30_000,
          post(
            regobsQuery(from, to, {
              NumberOfRecords: REGOBS_PAGE,
              Offset: page * REGOBS_PAGE,
            }),
          ),
        );
        if (!Array.isArray(batch)) throw new Error('invalid_observations');
        rows.push(...batch);
        if (batch.length < REGOBS_PAGE) break;
      }
      return normalizeRegobsObservations(rows);
    },

    /** Observed avalanches per week, counted without downloading them. */
    async weekCounts(weeks) {
      const counted = [];
      for (let start = 0; start < weeks.length; start += COUNT_CONCURRENCY) {
        const batch = weeks.slice(start, start + COUNT_CONCURRENCY);
        const totals = await Promise.all(
          batch.map((week) =>
            upstream(
              REGOBS_COUNT_URL,
              64 * 1024,
              20_000,
              post(regobsQuery(week.from, week.to)),
            ),
          ),
        );
        batch.forEach((week, index) => {
          const count = Number(totals[index]?.TotalMatches);
          counted.push({ ...week, count: Number.isFinite(count) ? count : 0 });
        });
      }
      return counted;
    },
  };
}
