import {
  DEFAULT_STT_ID,
  DEFAULT_TTS_ID,
  findLlmModel,
  findSttModel,
  findTtsEngine,
  recommendLlmModel,
} from './modelCatalog.js';
import { naturalVoiceAvailable } from './naturalVoiceSetting.js';

export { LOCAL_WEB_VOICE, localWebVoiceRequested } from './localWebFlag.js';

export const LOCAL_VOICE_MODEL_STORAGE_KEY = 'godsEyeView.voiceLocal.model';
export const LOCAL_VOICE_STT_STORAGE_KEY = 'godsEyeView.voiceLocal.stt';
export const LOCAL_VOICE_TTS_STORAGE_KEY = 'godsEyeView.voiceLocal.tts';
export const LOCAL_VOICE_NATURAL_NOTICE_KEY =
  'godsEyeView.voiceLocal.naturalNotice';

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function read(storage, key) {
  try {
    return storageOf(storage)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage, key, value) {
  try {
    storageOf(storage)?.setItem(key, value);
  } catch {
    /* best effort */
  }
}

/** A speech output choice this build offers, or null. */
function offeredTts(id, naturalVoice) {
  const engine = findTtsEngine(id);
  if (!engine || (engine.id === 'kokoro' && !naturalVoice)) return null;
  return engine.id;
}

/**
 * Resolves the local voice settings: URL overrides, then stored choices,
 * then a model recommended for the reported device memory. Unknown ids fall
 * through, so a stale stored value can never select a missing model. When
 * the build leaves natural voice out, speech defaults to system voices.
 */
export function readLocalVoiceSettings({
  search = globalThis.location?.search,
  storage,
  deviceMemoryGB = globalThis.navigator?.deviceMemory,
  naturalVoice = naturalVoiceAvailable(),
} = {}) {
  let params;
  try {
    params = new URLSearchParams(search || '');
  } catch {
    params = new URLSearchParams();
  }
  const llm =
    findLlmModel(params.get('voiceModel'))?.id ||
    findLlmModel(read(storage, LOCAL_VOICE_MODEL_STORAGE_KEY))?.id ||
    recommendLlmModel({ deviceMemoryGB }).id;
  const stt =
    findSttModel(params.get('voiceStt'))?.id ||
    findSttModel(read(storage, LOCAL_VOICE_STT_STORAGE_KEY))?.id ||
    DEFAULT_STT_ID;
  const tts =
    offeredTts(params.get('voiceTts'), naturalVoice) ||
    offeredTts(read(storage, LOCAL_VOICE_TTS_STORAGE_KEY), naturalVoice) ||
    (naturalVoice ? DEFAULT_TTS_ID : 'system');
  return { llm, stt, tts, naturalVoice };
}

/** Persists a model choice. Unknown ids are ignored; returns the stored id. */
export function writeLocalVoiceModel(id, storage) {
  const model = findLlmModel(id);
  if (model) write(storage, LOCAL_VOICE_MODEL_STORAGE_KEY, model.id);
  return model?.id || null;
}

/** Persists a speech recognition choice. Returns the stored id. */
export function writeLocalVoiceStt(id, storage) {
  const model = findSttModel(id);
  if (model) write(storage, LOCAL_VOICE_STT_STORAGE_KEY, model.id);
  return model?.id || null;
}

/** Persists a speech output choice this build offers. Returns the id. */
export function writeLocalVoiceTts(
  id,
  storage,
  naturalVoice = naturalVoiceAvailable(),
) {
  const chosen = offeredTts(id, naturalVoice);
  if (chosen) write(storage, LOCAL_VOICE_TTS_STORAGE_KEY, chosen);
  return chosen;
}

/** Whether the natural voice download notice has been shown before. */
export function naturalVoiceNoticeSeen(storage) {
  return read(storage, LOCAL_VOICE_NATURAL_NOTICE_KEY) === 'seen';
}

/** Records that the natural voice download notice was shown. */
export function markNaturalVoiceNoticeSeen(storage) {
  write(storage, LOCAL_VOICE_NATURAL_NOTICE_KEY, 'seen');
}
