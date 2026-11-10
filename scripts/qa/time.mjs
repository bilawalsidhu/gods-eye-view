const DAY_MS = 86_400_000;

/**
 * Austin's early afternoon (18:30 UTC) nearest to `now`. The page clock then
 * moves by at most 12 hours: the sun is up over the test cities whenever a
 * scenario runs, and data stamped with the real time stays current.
 */
export function daytimeNear(now = Date.now()) {
  const day = new Date(now);
  const at = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    18,
    30,
  );
  const nearest = [at - DAY_MS, at, at + DAY_MS].reduce((best, next) =>
    Math.abs(next - now) < Math.abs(best - now) ? next : best,
  );
  return new Date(nearest).toISOString();
}

export const DAYTIME = daytimeNear();

/** Keep elapsed time moving while giving the sun a repeatable position. */
export function shiftTime(utc) {
  if (utc === 'real') return;
  const offset = Date.parse(utc) - Date.now();
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ShiftedDate;
}
