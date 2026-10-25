const UNITS = { h: 3600, d: 86400, w: 604800, m: 2592000, y: 31536000 };
export const ALL_LAYERS = ['air', 'mil', 'vessel', 'local'];

/** "6h", "14d", "8w", "3m", "1y" or a bare number of days -> seconds; 0 = forever. */
export function parseDuration(text, fallbackDays = 7) {
  const s = String(text ?? '')
    .trim()
    .toLowerCase();
  if (!s) return fallbackDays * 86400;
  const match = /^(\d+(?:\.\d+)?)\s*([hdwmy]?)$/.exec(s);
  if (!match)
    throw new TypeError(`Bad retention "${text}" (use 6h, 14d, 8w, 3m)`);
  return Math.round(Number(match[1]) * UNITS[match[2] || 'd']);
}

/** Recorder settings from the environment. */
export function recorderConfig(env = process.env) {
  const retention = env.GEV_HISTORY_RETENTION ?? env.GEV_HISTORY_DAYS;
  const layers = (env.GEV_RECORDER_LAYERS || '')
    .split(',')
    .map((l) => l.trim())
    .filter((l) => ALL_LAYERS.includes(l));
  const maxMb = Number(env.GEV_HISTORY_MAX_MB ?? 0);
  const interval = Number(env.GEV_RECORDER_INTERVAL ?? 30);
  return {
    retentionSec: parseDuration(retention, 7),
    layers: layers.length ? layers : ALL_LAYERS,
    maxBytes: Number.isFinite(maxMb) && maxMb > 0 ? maxMb * 1048576 : 0,
    intervalSec: Number.isFinite(interval) && interval >= 1 ? interval : 30,
    databaseUrl: String(env.GEV_HISTORY_DB || '').trim(),
  };
}
