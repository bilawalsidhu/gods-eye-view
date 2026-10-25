export const GFS_BUCKET = 'noaa-gfs-bdp-pds';

/** Build the public GFS object key. */
export function gfsObjectKey({ date, hour, forecastHour = 0 }) {
  const hh = String(hour).padStart(2, '0');
  return `gfs.${date}/${hh}/atmos/gfs.t${hh}z.pgrb2.0p25.f${String(forecastHour).padStart(3, '0')}`;
}

/** Select the latest GFS cycle that should be available. */
export function selectLatestGfsCycle(
  nowMs,
  { availabilityLagMs = 5 * 3600_000 } = {},
) {
  const d = new Date(nowMs - availabilityLagMs);
  const date = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const hour = Math.floor(d.getUTCHours() / 6) * 6;
  date.setUTCHours(hour);
  return { date: date.toISOString().slice(0, 10).replaceAll('-', ''), hour };
}

/**
 * Round a time offset to the nearest published GFS forecast step so the field
 * shown is the one valid closest to now, not always the analysis (f000).
 * GFS 0.25° is hourly through f120, then every 3 h through f384.
 * @param {number} hours - Hours elapsed since the cycle run time.
 * @returns {number} A valid forecast step.
 */
export function nearestGfsStep(hours) {
  const value = Math.max(0, Number.isFinite(hours) ? hours : 0);
  const step = value <= 120 ? Math.round(value) : Math.round(value / 3) * 3;
  return Math.max(0, Math.min(384, step));
}

export function selectGfsForecast(nowMs) {
  const issue = selectLatestGfsCycle(nowMs);
  const runMs = Date.UTC(
    Number(issue.date.slice(0, 4)),
    Number(issue.date.slice(4, 6)) - 1,
    Number(issue.date.slice(6, 8)),
    issue.hour,
  );
  const forecastHour = nearestGfsStep((nowMs - runMs) / 3600_000);
  const cycle = {
    ...issue,
    forecastHour,
    runIso: new Date(runMs).toISOString(),
    validIso: new Date(runMs + forecastHour * 3600_000).toISOString(),
  };
  return {
    cycle,
    base: `https://${GFS_BUCKET}.s3.amazonaws.com/${gfsObjectKey(cycle)}`,
  };
}
