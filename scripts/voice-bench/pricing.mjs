/**
 * Cost estimation for benchmark turns (USD). Pure.
 *
 * OpenAI Realtime: the app's own rate table (`src/voice/voiceCost.js`).
 * `gpt-realtime-2.1` has no registry entry, so it resolves to the priciest
 * known table (gpt-realtime-2) — which matches OpenAI's published 2.1 rates
 * as read on 2026-09-23 ($4 / $0.40 cached / $24 per 1M text tokens).
 *
 * Gemini Live: https://ai.google.dev/gemini-api/docs/pricing, read 2026-09-23,
 * gemini-3.8-live paid tier, USD per 1M tokens. Thinking tokens bill as text
 * output. The native-audio Live model rejects TEXT output, so the benchmark
 * requests AUDIO and the spoken confirmation bills at the audio-output rate.
 */
import { estimateUsageCostUsd, resolveVoiceModelById } from '../../src/voice/voiceCost.js';

export const GEMINI_RATES = Object.freeze({
  'gemini-3.8-live': Object.freeze({
    textInput: 0.75,
    audioInput: 3.0,
    textOutput: 4.5,
    audioOutput: 12.0,
    verifiedOn: '2026-09-23',
  }),
});

/** Cost of one Realtime `response.usage` for `model`. */
export function openAiUsageCostUsd(model, usage) {
  return estimateUsageCostUsd(usage, resolveVoiceModelById(model).rates);
}

const modalityCount = (details, modality) =>
  (Array.isArray(details) ? details : [])
    .filter((d) => String(d?.modality || '').toUpperCase() === modality)
    .reduce((sum, d) => sum + (Number(d?.tokenCount) || 0), 0);

/**
 * Cost of one Gemini Live `usageMetadata`. Unattributed prompt tokens bill
 * as audio input and unattributed response tokens as audio output — the
 * conservative direction for a spend cap.
 */
export function geminiUsageCostUsd(model, usage) {
  const rates = GEMINI_RATES[model] || GEMINI_RATES['gemini-3.8-live'];
  if (!usage) return 0;
  const prompt = Number(usage.promptTokenCount) || 0;
  const response = Number(usage.responseTokenCount) || 0;
  const thoughts = Number(usage.thoughtsTokenCount) || 0;
  const textIn = modalityCount(usage.promptTokensDetails, 'TEXT');
  const audioIn = Math.max(0, prompt - textIn);
  const textOut = modalityCount(usage.responseTokensDetails, 'TEXT');
  const audioOut = Math.max(0, response - textOut);
  const usd =
    (textIn * rates.textInput +
      audioIn * rates.audioInput +
      (textOut + thoughts) * rates.textOutput +
      audioOut * rates.audioOutput) /
    1_000_000;
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}
