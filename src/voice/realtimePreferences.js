import {
  DEFAULT_VOICE_TIER,
  isKnownVoiceTier,
  normalizeCostLimits,
  resolveVoiceModel,
  serializeCostLimits,
} from './voiceCost.js';

// Voice cost control (repo-wide `godsEyeView.<feature>.<field>` convention;
// the neighbouring ERROR_STORAGE_KEY predates it).
export const VOICE_TIER_STORAGE_KEY = 'godsEyeView.voiceCost.tier';

export const VOICE_LIMITS_STORAGE_KEY = 'godsEyeView.voiceCost.limits';

/** Best-effort localStorage handle; absent in tests and locked-down browsers. */
export function voiceStorage(storage) {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // privacy modes throw on mere access
  }
}

/**
 * Read the persisted voice model tier. Unknown/corrupt values resolve to the
 * default, so a hand-edited localStorage entry can never pick a bad model.
 */
export function readStoredVoiceTier(storage) {
  try {
    const raw = voiceStorage(storage)?.getItem(VOICE_TIER_STORAGE_KEY);
    return isKnownVoiceTier(raw)
      ? resolveVoiceModel(raw).tier
      : DEFAULT_VOICE_TIER;
  } catch {
    return DEFAULT_VOICE_TIER;
  }
}

/** Persist the voice model tier. Never throws. */
export function writeStoredVoiceTier(tier, storage) {
  const resolved = resolveVoiceModel(tier).tier;
  try {
    voiceStorage(storage)?.setItem(VOICE_TIER_STORAGE_KEY, resolved);
  } catch {
    /* best effort */
  }
  return resolved;
}

/**
 * Read the persisted spend thresholds, falling back to the generous defaults.
 * Stored as `{"warnUsd":2,"capUsd":5}` under one key so both move together.
 */
export function readStoredVoiceLimits(storage) {
  try {
    const raw = voiceStorage(storage)?.getItem(VOICE_LIMITS_STORAGE_KEY);
    if (!raw) return normalizeCostLimits(null);
    return normalizeCostLimits(JSON.parse(raw));
  } catch {
    return normalizeCostLimits(null); // corrupt JSON must not disable the cap
  }
}

/**
 * Persist spend thresholds. Never throws.
 *
 * Serialized through `serializeCostLimits` because a DISABLED threshold is
 * Infinity, and `JSON.stringify(Infinity)` is `null` — which reads back as
 * "absent" and silently restores the default, re-arming a cap the user turned
 * off. The 'off' sentinel round-trips instead.
 */
export function writeStoredVoiceLimits(limits, storage) {
  const normalized = normalizeCostLimits(limits);
  try {
    voiceStorage(storage)?.setItem(
      VOICE_LIMITS_STORAGE_KEY,
      JSON.stringify(serializeCostLimits(normalized)),
    );
  } catch {
    /* best effort */
  }
  return normalized;
}

const VOICE_PROVIDER_STORAGE_KEY = 'godsEyeView.voice.provider';
export const VOICE_PROVIDERS = Object.freeze(['openai', 'local']);
const CONFIGURED_VOICE_PROVIDER = String(
  import.meta.env?.GEV_VOICE_PROVIDER || '',
).toLowerCase();
export const DEFAULT_VOICE_PROVIDER = VOICE_PROVIDERS.includes(
  CONFIGURED_VOICE_PROVIDER,
)
  ? CONFIGURED_VOICE_PROVIDER
  : 'openai';

/** Read the persisted voice provider, falling back safely after corruption. */
export function readStoredVoiceProvider(storage) {
  try {
    const raw = voiceStorage(storage)?.getItem(VOICE_PROVIDER_STORAGE_KEY);
    return VOICE_PROVIDERS.includes(raw) ? raw : DEFAULT_VOICE_PROVIDER;
  } catch {
    return DEFAULT_VOICE_PROVIDER;
  }
}

/** Persist the provider used by the next session. Never throws. */
export function writeStoredVoiceProvider(provider, storage) {
  const resolved = VOICE_PROVIDERS.includes(provider)
    ? provider
    : DEFAULT_VOICE_PROVIDER;
  try {
    voiceStorage(storage)?.setItem(VOICE_PROVIDER_STORAGE_KEY, resolved);
  } catch {
    /* best effort */
  }
  return resolved;
}
