import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

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

export const CONFIG_FILE = 'recorder.config.json';

/**
 * Reads the optional settings file (recorder.config.json in the project
 * folder, or the path in GEV_RECORDER_CONFIG) and returns its values in the
 * same form as the environment variables. Returns {} when there is no file.
 */
export function loadConfigFile(root, env = process.env) {
  const target = path.resolve(root, env.GEV_RECORDER_CONFIG || CONFIG_FILE);
  if (!existsSync(target)) return {};
  let raw;
  try {
    raw = JSON.parse(readFileSync(target, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${target}: ${error.message}`);
  }
  const out = {};
  const set = (key, value) => {
    if (value !== undefined && value !== null && value !== '')
      out[key] = String(value);
  };
  if (typeof raw.enabled === 'boolean')
    set('GEV_RECORDER', raw.enabled ? 1 : 0);
  set('GEV_HISTORY_RETENTION', raw.retention);
  set('GEV_HISTORY_MAX_MB', raw.maxMb);
  set('GEV_RECORDER_LAYERS', [].concat(raw.layers ?? []).join(','));
  set('GEV_RECORDER_INTERVAL', raw.interval);
  set('GEV_HISTORY_DB', raw.database);
  if (raw.file) out.GEV_HISTORY_FILE = path.resolve(root, String(raw.file));
  return out;
}

/** Settings file first, then environment variables on top of it. */
export function mergedSettings(root, env = process.env) {
  const merged = { ...loadConfigFile(root, env) };
  for (const [key, value] of Object.entries(env))
    if (key.startsWith('GEV_') && value !== undefined && value !== '')
      merged[key] = value;
  return merged;
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
