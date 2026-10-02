import { localWebVoiceRequested } from './local/localWebFlag.js';
import { voiceStorage } from './realtimePreferences.js';

/**
 * Where voice runs: the cloud (OpenAI Realtime through this server) or
 * on this device (models in the browser). Chosen in the voice control and
 * kept per browser (`godsEyeView.<feature>.<field>` convention).
 */
export const VOICE_ENGINES = Object.freeze(['cloud', 'on-device']);
export const DEFAULT_VOICE_ENGINE = 'cloud';
export const VOICE_ENGINE_STORAGE_KEY = 'godsEyeView.voiceEngine.choice';

const known = (value) => (VOICE_ENGINES.includes(value) ? value : null);

/**
 * The engine for this page: `?voice=local-web` (or `?voice=cloud`) is a
 * shortcut that wins, then the stored choice, then Cloud.
 */
export function readVoiceEngine({
  search = globalThis.location?.search,
  storage,
} = {}) {
  if (localWebVoiceRequested(search)) return 'on-device';
  try {
    if (new URLSearchParams(search || '').get('voice') === 'cloud')
      return 'cloud';
  } catch {
    /* malformed query: use the stored choice */
  }
  try {
    return (
      known(voiceStorage(storage)?.getItem(VOICE_ENGINE_STORAGE_KEY)) ||
      DEFAULT_VOICE_ENGINE
    );
  } catch {
    return DEFAULT_VOICE_ENGINE;
  }
}

/** Persists an engine choice. Never throws; returns the stored value. */
export function writeVoiceEngine(engine, storage) {
  const chosen = known(engine);
  if (!chosen) return null;
  try {
    voiceStorage(storage)?.setItem(VOICE_ENGINE_STORAGE_KEY, chosen);
  } catch {
    /* best effort */
  }
  return chosen;
}
