import {
  HUD_SUMMARY_INSTRUCTIONS,
  keylessHudSummaryResponse,
} from '../../../src/hudSummaryResponse.js';
import { enforceRateLimit, openAiRateLimiter } from './rate-limit.js';
import { readRequestBody } from '../common/request.js';
import { OPENAI_HUD_SUMMARY_MODEL_DEFAULT } from './constants.js';
import { createGeminiInteractionText } from '../gemini/interactions.js';

/** Google's fastest, lowest-cost stable text model; it thinks minimally by default. */
const GEMINI_HUD_SUMMARY_MODEL_DEFAULT = 'gemini-3.5-flash-lite';

function extractOpenAiResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => part?.text || part?.output_text || '')
    .join(' ')
    .trim();
}

function toFiveWordHudSummary(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

/** Providers that can answer the HUD summary, in automatic order. */
const HUD_SUMMARY_PROVIDERS = Object.freeze({
  openai: Object.freeze({ label: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY' }),
  gemini: Object.freeze({ label: 'Gemini', apiKeyEnv: 'GEMINI_API_KEY' }),
});

/**
 * Pick the provider for a HUD summary.
 *
 * GEV_HUD_SUMMARY_PROVIDER=openai|gemini names one, and naming one is binding:
 * its key missing means the keyless response, not a quiet switch to the other
 * account. Unset (or `auto`) keeps OpenAI first, so an existing install sees
 * no change, and uses Gemini only when it holds the only key.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ id: 'openai'|'gemini', apiKey: string }|null}
 */
function resolveHudSummaryProvider(env = process.env) {
  const wanted = String(env.GEV_HUD_SUMMARY_PROVIDER ?? '')
    .trim()
    .toLowerCase();
  const order = Object.hasOwn(HUD_SUMMARY_PROVIDERS, wanted)
    ? [wanted]
    : Object.keys(HUD_SUMMARY_PROVIDERS);
  for (const id of order) {
    const apiKey = String(
      env[HUD_SUMMARY_PROVIDERS[id].apiKeyEnv] ?? '',
    ).trim();
    if (apiKey) return { id, apiKey };
  }
  return null;
}

async function requestOpenAiSummary(apiKey, context) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model:
        process.env.OPENAI_HUD_SUMMARY_MODEL ||
        OPENAI_HUD_SUMMARY_MODEL_DEFAULT,
      instructions: HUD_SUMMARY_INSTRUCTIONS,
      input: JSON.stringify(context),
      reasoning: { effort: 'minimal' },
      max_output_tokens: 100,
    }),
  });
  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    text: extractOpenAiResponseText(data),
  };
}

function requestGeminiSummary(apiKey, context) {
  return createGeminiInteractionText({
    apiKey,
    model:
      process.env.GEMINI_HUD_SUMMARY_MODEL || GEMINI_HUD_SUMMARY_MODEL_DEFAULT,
    systemInstruction: HUD_SUMMARY_INSTRUCTIONS,
    input: JSON.stringify(context),
    // Same budget as the OpenAI request; thought tokens count against it.
    maxOutputTokens: 100,
    thinkingLevel: 'minimal',
  });
}

const SUMMARY_REQUESTS = {
  openai: requestOpenAiSummary,
  gemini: requestGeminiSummary,
};

async function handleHudSummary(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const provider = resolveHudSummaryProvider();
  const keyless = keylessHudSummaryResponse(provider?.apiKey);
  if (keyless) {
    res.statusCode = keyless.statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(keyless.payload));
    return;
  }

  // Per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN). On by default; 0 disables.
  // It guards this route whichever provider answers, so switching to Gemini
  // does not double the budget. Keyless HUD fallback has no provider cost and
  // resolves above without consuming a paid-endpoint quota slot.
  if (!enforceRateLimit(openAiRateLimiter(), req, res)) return;

  // Never relay the provider's own error text: it carries request ids,
  // organization or project hints and quota phrasing.
  const failure = `${HUD_SUMMARY_PROVIDERS[provider.id].label} HUD summary request failed`;
  try {
    const body = await readRequestBody(req, 64 * 1024);
    const context = JSON.parse(body || '{}');
    const result = await SUMMARY_REQUESTS[provider.id](
      provider.apiKey,
      context,
    );
    const summary = toFiveWordHudSummary(result.text);
    res.statusCode = result.ok && summary ? 200 : result.status || 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (!result.ok)
      console.warn(`[hud-summary] upstream HTTP ${result.status}`);
    res.end(
      JSON.stringify({
        summary: summary || null,
        error: result.ok ? null : failure,
      }),
    );
  } catch {
    console.warn('[hud-summary] request failed');
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: failure }));
  }
}

export {
  GEMINI_HUD_SUMMARY_MODEL_DEFAULT,
  handleHudSummary,
  resolveHudSummaryProvider,
};
