export const GFS_BUCKET = 'noaa-gfs-bdp-pds';

/** Build the public GFS object key. */
export function gfsObjectKey({ date, hour, forecastHour = 0 }) {
  const hh = String(hour).padStart(2, '0');
  return `gfs.${date}/${hh}/atmos/gfs.t${hh}z.pgrb2.0p25.f${String(forecastHour).padStart(3, '0')}`;
}

/** Select the latest GFS cycle that should be available. */
export function selectLatestGfsCycle(nowMs, { availabilityLagMs = 5 * 3600_000 } = {}) {
  const d = new Date(nowMs - availabilityLagMs);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const hour = Math.floor(d.getUTCHours() / 6) * 6;
  date.setUTCHours(hour);
  return { date: date.toISOString().slice(0, 10).replaceAll('-', ''), hour };
}
