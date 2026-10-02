const HF = 'https://huggingface.co';
const litert = (name, revision) =>
  `${HF}/litert-community/${name}-litert-lm/resolve/${revision}/${name}-web.litertlm`;

/**
 * Gemma 4 web builds for LiteRT-LM, pinned to a repository revision and
 * checked against the published SHA-256 when downloaded.
 */
export const LLM_MODELS = Object.freeze([
  {
    id: 'gemma-4-e2b',
    label: 'Gemma 4 E2B',
    url: litert('gemma-4-E2B-it', 'b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1'),
    sha256: '3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5',
    bytes: 2008432640,
    minMemoryGB: 8,
  },
  {
    id: 'gemma-4-e4b',
    label: 'Gemma 4 E4B',
    url: litert('gemma-4-E4B-it', '2eee7ac325f20eb8c9ac1d0e972f7c84663062da'),
    sha256: '3904d826d5dddd25ea173e85204caec09e68ba038116e9b992b69cbdc94f57a0',
    bytes: 2969059328,
    minMemoryGB: 8,
  },
  {
    id: 'gemma-4-12b',
    label: 'Gemma 4 12B',
    url: litert('gemma-4-12B-it', '7a0b1ce0ea821bcd01c5f72af84155e02191152f'),
    sha256: 'd37f9392b4f093b470b50b72624c9a752cc0b288ed549b769037cbbd04024449',
    bytes: 5986074624,
    minMemoryGB: 16,
    recommended: true,
  },
  {
    id: 'gemma-4-26b-a4b',
    label: 'Gemma 4 26B A4B',
    url: litert(
      'gemma-4-26B-A4B-it',
      'a6268756268ac3eab06333eb28f279cff56e9ea6',
    ),
    sha256: '4523b2de695a7f22dc675b716253ba9a8512ca9f4852fb6a682fe4c2eb859c16',
    bytes: 15786524672,
    minMemoryGB: 32,
    experimental: true,
  },
]);

/** Speech recognition models for transformers.js on WebGPU. */
export const STT_MODELS = Object.freeze([
  {
    id: 'moonshine-base',
    label: 'Moonshine Base',
    repo: 'onnx-community/moonshine-base-ONNX',
    revision: 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad',
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    approxBytes: 160e6,
  },
  {
    id: 'whisper-base',
    label: 'Whisper Base (English)',
    repo: 'onnx-community/whisper-base.en',
    revision: '51eefc0af78b103839eda9e7e4f4186acc6517fe',
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    approxBytes: 210e6,
  },
  {
    id: 'whisper-large-v3-turbo',
    label: 'Whisper Large v3 Turbo',
    repo: 'onnx-community/whisper-large-v3-turbo',
    revision: '360ebcde2559d60bb474678be3c1de9ef347d01a',
    dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4f16' },
    approxBytes: 1.5e9,
  },
]);

export const TTS_MODEL = Object.freeze({
  id: 'kokoro-82m',
  repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
  dtype: 'fp32',
  voice: 'af_heart',
  sampleRate: 24000,
  approxBytes: 330e6,
});

/**
 * The phonemizer Kokoro turns text into phonemes with. It is not part of
 * this build: the browser downloads this exact file from the public npm CDN
 * when natural voice first starts and checks its SHA-256 before using it.
 */
export const PHONEMIZER_RUNTIME = Object.freeze({
  name: 'phonemizer',
  version: '1.2.1',
  url: 'https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/dist/phonemizer.js',
  sha256: '193481f474f7c1ea81df3195d18b45df8ef7254dbdccb3f193d60215c4897bec',
  bytes: 1322380,
});

/** Speech output engines. */
export const TTS_ENGINES = Object.freeze([
  {
    id: 'kokoro',
    label: 'Natural',
    approxBytes: TTS_MODEL.approxBytes + PHONEMIZER_RUNTIME.bytes,
    note: 'Kokoro-82M. Downloads an open-source speech component (GPL) to this browser.',
  },
  {
    id: 'system',
    label: 'System',
    approxBytes: 0,
    note: 'Browser speech synthesis limited to voices on this device',
  },
  { id: 'none', label: 'Text only', approxBytes: 0, note: 'No speech' },
]);

export const DEFAULT_STT_ID = 'moonshine-base';
export const DEFAULT_TTS_ID = 'kokoro';

export function findTtsEngine(id) {
  return TTS_ENGINES.find((engine) => engine.id === id) || null;
}

export function findLlmModel(id) {
  return LLM_MODELS.find((model) => model.id === id) || null;
}

export function findSttModel(id) {
  return STT_MODELS.find((model) => model.id === id) || null;
}

/**
 * Picks the largest recommended model that fits the reported memory.
 * navigator.deviceMemory is capped (Chrome reports at most 32), so the
 * largest tier is never chosen automatically.
 */
export function recommendLlmModel({ deviceMemoryGB } = {}) {
  const memory = Number(deviceMemoryGB);
  if (!Number.isFinite(memory) || memory <= 0)
    return findLlmModel('gemma-4-e4b');
  if (memory >= 16) return findLlmModel('gemma-4-12b');
  return findLlmModel('gemma-4-e4b');
}

/**
 * Decides whether this browser can run the local tier.
 * @param {{hasWebGpu: boolean, adapter?: boolean, maxBufferSize?: number,
 *   deviceMemoryGB?: number, isSecureContext?: boolean, model?: object}} env
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkLocalVoiceSupport(env = {}) {
  if (env.isSecureContext === false)
    return { ok: false, reason: 'On-device voice needs HTTPS or localhost.' };
  if (!env.hasWebGpu)
    return {
      ok: false,
      reason: 'On-device voice needs WebGPU. Use a current Chrome or Edge.',
    };
  if (env.adapter === false)
    return { ok: false, reason: 'No WebGPU graphics adapter is available.' };
  if (
    Number.isFinite(env.maxBufferSize) &&
    env.maxBufferSize < 1024 * 1024 * 1024
  )
    return {
      ok: false,
      reason: 'This GPU cannot allocate the buffers a local model needs.',
    };
  const model = env.model;
  const memory = Number(env.deviceMemoryGB);
  if (model && Number.isFinite(memory) && memory > 0 && memory < 32) {
    if (memory < model.minMemoryGB)
      return {
        ok: false,
        reason: `${model.label} needs about ${model.minMemoryGB} GB of memory; this device reports ${memory} GB.`,
      };
  }
  return { ok: true };
}

/**
 * Warns when the browser cannot keep the models between sessions. Returns
 * null when everything still to download fits and storage is persistent.
 * @param {{quota?: number, usage?: number}} estimate StorageManager estimate.
 * @param {Array<{label: string, bytes: number}>} pending Models not yet cached.
 * @param {{persisted?: boolean}} [options] Whether storage is persistent.
 */
export function storageAdvice(estimate, pending = [], { persisted } = {}) {
  const needed = pending.reduce((sum, model) => sum + (model.bytes || 0), 0);
  const quota = Number(estimate?.quota);
  const usage = Number(estimate?.usage) || 0;
  const notes = [];
  if (needed > 0 && Number.isFinite(quota) && quota > 0) {
    const free = Math.max(0, quota - usage);
    if (free < needed * 1.05)
      notes.push(
        `Browser storage has ${formatBytes(free)} free but ${pending
          .map((model) => model.label)
          .join(
            ', ',
          )} need ${formatBytes(needed)}; they will download again next session.`,
      );
  }
  if (persisted === false && needed > 0)
    notes.push('The browser may clear downloaded models when space runs low.');
  return notes.length ? notes.join(' ') : null;
}

/** Human-readable byte count for download progress. */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB`;
  if (value >= 1e6) return `${Math.round(value / 1e6)} MB`;
  return `${Math.round(value / 1e3)} KB`;
}
