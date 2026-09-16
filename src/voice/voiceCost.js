// src/voice/voiceCost.js
/**
 * Voice model registry + Realtime session cost estimation.
 *
 * Pure module (no DOM, no network, no imports) so it can be shared by three
 * callers that cannot share anything else:
 *   1. the browser voice UI (`gevRealtime.js`) — live "~$0.42" readout + caps
 *   2. the dev-server token endpoint (`vite.config.js` → `/api/realtime/token`)
 *   3. unit tests (`voiceCost.test.mjs`)
 *
 * Supported tiers:
 *   - 'standard': OpenAI gpt-realtime-2
 *   - 'mini':     OpenAI gpt-realtime-2.1-mini
 *   - 'gemini':   Google Gemini 2.0 Flash Multimodal Live
 *
 * @module voice/voiceCost
 */

export const VOICE_MODEL_RATES_VERIFIED_ON = '2026-08-18';

/** @typedef {'standard'|'mini'|'gemini'} VoiceModelTier */

export const VOICE_MODELS = Object.freeze({
  standard: Object.freeze({
    tier: 'standard',
    id: 'gpt-realtime-2',
    label: 'STANDARD',
    provider: 'openai',
    rates: Object.freeze({
      textInput: 4,
      textCachedInput: 0.4,
      textOutput: 24,
      audioInput: 32,
      audioCachedInput: 0.4,
      audioOutput: 64,
      imageInput: 5,
      imageCachedInput: 0.5,
    }),
  }),
  mini: Object.freeze({
    tier: 'mini',
    id: 'gpt-realtime-2.1-mini',
    label: 'MINI',
    provider: 'openai',
    rates: Object.freeze({
      textInput: 0.6,
      textCachedInput: 0.06,
      textOutput: 2.4,
      audioInput: 10,
      audioCachedInput: 0.3,
      audioOutput: 20,
      imageInput: 0.8,
      imageCachedInput: 0.08,
    }),
  }),
  gemini: Object.freeze({
    tier: 'gemini',
    id: 'gemini-3.8-live',
    label: 'GEMINI 3.8',
    provider: 'gemini',
    /** Rates for Gemini 3.8 Live (USD per 1M tokens) */
    rates: Object.freeze({
      textInput: 0.75,
      textCachedInput: 0.1875,
      textOutput: 3.75,
      audioInput: 1.00,
      audioCachedInput: 0.25,
      audioOutput: 4.00,
      imageInput: 0.75,
      imageCachedInput: 0.1875,
    }),
  }),
});

export const DEFAULT_VOICE_TIER = 'standard';
export const VOICE_TIERS = Object.freeze(Object.keys(VOICE_MODELS));

export function resolveVoiceModel(tier) {
  return isKnownVoiceTier(tier)
    ? VOICE_MODELS[String(tier).trim().toLowerCase()]
    : VOICE_MODELS[DEFAULT_VOICE_TIER];
}

export function isKnownVoiceTier(tier) {
  const key = typeof tier === 'string' ? tier.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(VOICE_MODELS, key);
}

export function mostExpensiveVoiceModel() {
  return Object.values(VOICE_MODELS).reduce((worst, entry) =>
    entry.rates.audioOutput > worst.rates.audioOutput ? entry : worst,
  );
}

export function resolveVoiceModelById(modelId) {
  const id = typeof modelId === 'string' ? modelId.trim() : '';
  for (const entry of Object.values(VOICE_MODELS)) {
    if (entry.id === id) return { ...entry, recognized: true };
  }
  const worst = mostExpensiveVoiceModel();
  return {
    ...worst,
    id: id || worst.id,
    recognized: false,
  };
}

export const VOICE_COST_LIMITS = Object.freeze({
  warnUsd: 2,
  capUsd: 5,
});

export const VOICE_COST_LIMIT_OFF = 'off';

export function normalizeCostLimits(limits) {
  const clean = (value, fallback) => {
    if (
      typeof value === 'string' &&
      value.trim().toLowerCase() === VOICE_COST_LIMIT_OFF
    ) {
      return Infinity;
    }
    if (value === Infinity) return Infinity;
    if (value === null || value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return n > 0 ? n : Infinity;
  };
  return Object.freeze({
    warnUsd: clean(limits?.warnUsd, VOICE_COST_LIMITS.warnUsd),
    capUsd: clean(limits?.capUsd, VOICE_COST_LIMITS.capUsd),
  });
}

export function serializeCostLimits(limits) {
  const normalized = normalizeCostLimits(limits);
  const encode = (value) =>
    Number.isFinite(value) ? value : VOICE_COST_LIMIT_OFF;
  return {
    warnUsd: encode(normalized.warnUsd),
    capUsd: encode(normalized.capUsd),
  };
}

const nonNegative = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function splitUsageTokens(usage) {
  const inDetails = usage?.input_token_details || null;
  const outDetails = usage?.output_token_details || null;
  const cached = inDetails?.cached_tokens_details || null;

  const inputTotal = nonNegative(usage?.input_tokens);
  const outputTotal = nonNegative(usage?.output_tokens);

  let textIn;
  let audioIn;
  let imageIn;
  let textCached;
  let audioCached;
  let imageCached;

  if (inDetails) {
    textCached = nonNegative(cached?.text_tokens);
    audioCached = nonNegative(cached?.audio_tokens);
    imageCached = nonNegative(cached?.image_tokens);
    if (!cached && nonNegative(inDetails.cached_tokens) > 0) {
      audioCached = Math.min(
        nonNegative(inDetails.cached_tokens),
        nonNegative(inDetails.audio_tokens),
      );
    }
    textIn = Math.max(0, nonNegative(inDetails.text_tokens) - textCached);
    audioIn = Math.max(0, nonNegative(inDetails.audio_tokens) - audioCached);
    imageIn = Math.max(0, nonNegative(inDetails.image_tokens) - imageCached);
  } else {
    textIn = 0;
    audioIn = inputTotal;
    imageIn = 0;
    textCached = 0;
    audioCached = 0;
    imageCached = 0;
  }

  const inputResidual = Math.max(
    0,
    inputTotal -
      (textIn + audioIn + imageIn + textCached + audioCached + imageCached),
  );
  audioIn += inputResidual;

  const textOut = outDetails ? nonNegative(outDetails.text_tokens) : 0;
  let audioOut = outDetails
    ? nonNegative(outDetails.audio_tokens)
    : outputTotal;
  const outputResidual = Math.max(0, outputTotal - (textOut + audioOut));
  audioOut += outputResidual;

  return {
    textIn,
    audioIn,
    imageIn,
    textCached,
    audioCached,
    imageCached,
    textOut,
    audioOut,
    inputTotal,
    outputTotal,
  };
}

export function estimateUsageCostUsd(usage, rates) {
  if (!usage || !rates) return 0;
  const t = splitUsageTokens(usage);
  const usd =
    (t.textIn * nonNegative(rates.textInput) +
      t.textCached * nonNegative(rates.textCachedInput) +
      t.textOut * nonNegative(rates.textOutput) +
      t.audioIn * nonNegative(rates.audioInput) +
      t.audioCached * nonNegative(rates.audioCachedInput) +
      t.audioOut * nonNegative(rates.audioOutput) +
      t.imageIn * nonNegative(rates.imageInput) +
      t.imageCached * nonNegative(rates.imageCachedInput)) /
    1_000_000;
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}

export function formatCostUsd(usd) {
  const n = Number.isFinite(Number(usd)) ? Math.max(0, Number(usd)) : 0;
  if (n > 0 && n < 0.01) return '~$0.01';
  return `~$${n.toFixed(2)}`;
}

export function createVoiceCostTracker(options = {}) {
  const model = options.modelId
    ? resolveVoiceModelById(options.modelId)
    : { ...resolveVoiceModel(options.tier), recognized: true };
  const limits = normalizeCostLimits(options.limits);

  let totalUsd = 0;
  let responses = 0;
  let warned = false;
  let capped = false;
  let incomplete = false;

  const snapshot = (warnCrossed = false, capCrossed = false) => ({
    tier: model.tier,
    modelId: model.id,
    ratesRecognized: model.recognized !== false,
    totalUsd,
    responses,
    warnUsd: limits.warnUsd,
    capUsd: limits.capUsd,
    level: capped ? 'cap' : warned ? 'warn' : 'ok',
    warnCrossed,
    capCrossed,
    capReached: capped,
    incomplete,
    display: formatCostUsd(totalUsd) + (incomplete ? '*' : ''),
    note: incomplete
      ? 'Estimate is incomplete — a response was still in flight when the session ended, so its usage was never reported.'
      : null,
  });

  return {
    model,
    limits,
    record(usage) {
      const usd = estimateUsageCostUsd(usage, model.rates);
      if (usd > 0) {
        totalUsd += usd;
        responses += 1;
      }
      let warnCrossed = false;
      let capCrossed = false;
      if (!warned && totalUsd >= limits.warnUsd) {
        warned = true;
        warnCrossed = true;
      }
      if (!capped && totalUsd >= limits.capUsd) {
        capped = true;
        capCrossed = true;
      }
      return snapshot(warnCrossed, capCrossed);
    },
    state: () => snapshot(),
    markIncomplete() {
      incomplete = true;
      return snapshot();
    },
    reset() {
      totalUsd = 0;
      responses = 0;
      warned = false;
      capped = false;
      incomplete = false;
      return snapshot();
    },
  };
}