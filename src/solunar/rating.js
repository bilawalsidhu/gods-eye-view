/**
 * The 1-4 star day rating for hunting and fishing. The rule is data, so the
 * panel can print exactly what the code does (RATING_RULE).
 *
 *   Moon points (both): new or full moon within 1 day of the day's noon = 2,
 *   within 2.5 days = 1, otherwise 0.
 *   Dawn and dusk bands: sunrise +/- 1 h and sunset +/- 1 h.
 *   Fishing = moon points + 1 for each band (dawn, dusk) that a MAJOR
 *     window (about 2 h) overlaps.
 *   Hunting = moon points + 1 for each band that ANY window (major or minor,
 *     about 1 h) overlaps.
 *   Stars = points, at least 1 and at most 4.
 *
 * A day without a sunrise or sunset (polar) has no band for it.
 */
export const BAND_HALF_MS = 60 * 60_000;
export const NEAR_SYZYGY_DAYS = 1;
export const CLOSE_SYZYGY_DAYS = 2.5;
export const MAX_STARS = 4;

export const RATING_RULE = Object.freeze({
  moonPoints: Object.freeze([
    { withinDays: NEAR_SYZYGY_DAYS, points: 2 },
    { withinDays: CLOSE_SYZYGY_DAYS, points: 1 },
  ]),
  bandHours: BAND_HALF_MS / 3_600_000,
  maxStars: MAX_STARS,
});

const overlaps = (a, b) => a.startMs < b.endMs && b.startMs < a.endMs;

export function moonPoints(daysFromSyzygy) {
  if (daysFromSyzygy <= NEAR_SYZYGY_DAYS) return 2;
  if (daysFromSyzygy <= CLOSE_SYZYGY_DAYS) return 1;
  return 0;
}

const clampStars = (points) => Math.max(1, Math.min(MAX_STARS, points));

/**
 * @param {{sunrise:number[], sunset:number[], windows:object[],
 *   daysFromSyzygy:number}} day
 * @returns {{bands:object[], moonPoints:number, fishingStars:number,
 *   huntingStars:number, fishingPoints:number, huntingPoints:number}}
 */
export function rateDay(day) {
  const bands = [
    ...day.sunrise.map((ms) => ({
      name: 'dawn',
      startMs: ms - BAND_HALF_MS,
      endMs: ms + BAND_HALF_MS,
    })),
    ...day.sunset.map((ms) => ({
      name: 'dusk',
      startMs: ms - BAND_HALF_MS,
      endMs: ms + BAND_HALF_MS,
    })),
  ];
  const moon = moonPoints(day.daysFromSyzygy);
  const hit = (band, kinds) =>
    day.windows.some((w) => kinds.includes(w.kind) && overlaps(w, band));
  const named = (name) => bands.filter((b) => b.name === name);
  const bandHits = (kinds) =>
    ['dawn', 'dusk'].filter((name) =>
      named(name).some((band) => hit(band, kinds)),
    ).length;
  const fishingPoints = moon + bandHits(['major']);
  const huntingPoints = moon + bandHits(['major', 'minor']);
  return {
    bands,
    moonPoints: moon,
    fishingPoints,
    huntingPoints,
    fishingStars: clampStars(fishingPoints),
    huntingStars: clampStars(huntingPoints),
  };
}
