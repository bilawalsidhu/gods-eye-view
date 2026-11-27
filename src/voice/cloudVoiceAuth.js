import { browserStorage } from '../browserStorage.js';

const CLOUD_VOICE_AUTH_MODES = Object.freeze(['api-key', 'oauth']);
const DEFAULT_CLOUD_VOICE_AUTH_MODE = 'api-key';
export const CLOUD_VOICE_AUTH_STORAGE_KEY = 'godsEyeView.voice.cloudAuth';

function normalizeCloudVoiceAuthMode(mode) {
  const normalized = String(mode || '')
    .trim()
    .toLowerCase();
  return CLOUD_VOICE_AUTH_MODES.includes(normalized)
    ? normalized
    : DEFAULT_CLOUD_VOICE_AUTH_MODE;
}

export function readStoredCloudVoiceAuthMode(storage) {
  try {
    return normalizeCloudVoiceAuthMode(
      (storage || browserStorage())?.getItem(CLOUD_VOICE_AUTH_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_CLOUD_VOICE_AUTH_MODE;
  }
}

export function writeStoredCloudVoiceAuthMode(mode, storage) {
  const resolved = normalizeCloudVoiceAuthMode(mode);
  try {
    (storage || browserStorage())?.setItem(
      CLOUD_VOICE_AUTH_STORAGE_KEY,
      resolved,
    );
  } catch {
    /* best effort */
  }
  return resolved;
}
