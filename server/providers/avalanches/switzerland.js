import {
  daySpan,
  normalizeSlfForecast,
  normalizeSlfRegions,
} from '../../../src/layers/avalanches/records.js';

// SLF avalanche bulletin (CAAMLv6) and warning regions; CC BY 4.0, credit
// the WSL Institute for Snow and Avalanche Research SLF with a link to slf.ch.
const SLF_BULLETIN_URL = 'https://aws.slf.ch/api/bulletin/caaml/en/json';
const SLF_REGIONS_URL =
  'https://aws.slf.ch/api/warningregion/warnregionDefinition/current/geojson';

const MIB = 1024 * 1024;
/** Days requested in parallel; the bulletin API answers one instant at a time. */
const DAY_CONCURRENCY = 4;
const DAY_MS = 86_400_000;

/**
 * The instant a day's bulletin is read at. SLF bulletins run 08:00–17:00 local
 * time and the evening issue covers the night; midday UTC falls inside the
 * daytime bulletin all year.
 */
const midday = (date) => `${date}T12:00:00Z`;

const datesBetween = (from, to) =>
  Array.from({ length: daySpan(from, to) + 1 }, (_, index) =>
    new Date(Date.parse(`${from}T00:00:00Z`) + index * DAY_MS)
      .toISOString()
      .slice(0, 10),
  );

/**
 * Switzerland: SLF bulletins and warning regions.
 *
 * The API serves the bulletin active at an instant, so a window is one request
 * per day. A day without a published bulletin yet (most of tomorrow, all of
 * the day after) answers an empty list, which reads as "no rating" — the same
 * as off-season — rather than as an error.
 * @param {{upstream:Function}} options Bounded JSON fetch.
 */
export function createSwitzerlandAvalancheProvider({ upstream }) {
  return {
    id: 'slf',

    async forecast({ from, to }) {
      const dates = datesBetween(from, to);
      const days = [];
      for (let start = 0; start < dates.length; start += DAY_CONCURRENCY) {
        const batch = dates.slice(start, start + DAY_CONCURRENCY);
        const payloads = await Promise.all(
          batch.map((date) =>
            upstream(
              `${SLF_BULLETIN_URL}?activeAt=${encodeURIComponent(midday(date))}`,
              4 * MIB,
              20_000,
            ),
          ),
        );
        batch.forEach((date, index) =>
          days.push({ date, payload: payloads[index] }),
        );
      }
      return normalizeSlfForecast(days);
    },

    async regions() {
      return normalizeSlfRegions(
        await upstream(SLF_REGIONS_URL, 8 * MIB, 30_000),
      );
    },
  };
}
