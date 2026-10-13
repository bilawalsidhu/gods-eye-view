import {
  HUD_SUMMARY_INSTRUCTIONS,
  keylessHudSummaryResponse,
} from '../../../src/hudSummaryResponse.js';
import { enforceRateLimit, openAiRateLimiter } from './rate-limit.js';
import { readRequestBody } from '../common/request.js';
import {
  OPENAI_HUD_SUMMARY_MODEL_DEFAULT,
  OPENAI_HUD_SUMMARY_REASONING_DEFAULT,
} from './constants.js';
import { openAiEndpoint } from './endpoints.js';

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

/**
 * The `reasoning` member of the HUD request. `off` omits it: a model behind an
 * OpenAI-compatible gateway may not know OpenAI's effort names, and a thinking
 * model given `minimal` can spend the whole 100-token budget reasoning and
 * return its reasoning as the summary.
 * @param {Record<string, string|undefined>} [environment]
 * @returns {{ reasoning?: { effort: string } }}
 */
function hudSummaryReasoning(environment = process.env) {
  const effort =
    String(environment.OPENAI_HUD_SUMMARY_REASONING_EFFORT ?? '').trim() ||
    OPENAI_HUD_SUMMARY_REASONING_DEFAULT;
  return effort.toLowerCase() === 'off' ? {} : { reasoning: { effort } };
}

async function handleHudSummary(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const keyless = keylessHudSummaryResponse(apiKey);
  if (keyless) {
    res.statusCode = keyless.statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(keyless.payload));
    return;
  }

  // Per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN). On by default; 0 disables.
  // Keyless HUD fallback has no provider cost and resolves above without
  // consuming a paid-endpoint quota slot.
  if (!enforceRateLimit(openAiRateLimiter(), req, res)) return;

  try {
    const body = await readRequestBody(req, 64 * 1024);
    const context = JSON.parse(body || '{}');
    const response = await fetch(openAiEndpoint('responses'), {
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
        ...hudSummaryReasoning(),
        max_output_tokens: 100,
      }),
    });
    const data = await response.json().catch(() => ({}));
    const summary = toFiveWordHudSummary(extractOpenAiResponseText(data));
    res.statusCode = response.ok && summary ? 200 : response.status || 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (!response.ok)
      console.warn(`[hud-summary] upstream HTTP ${response.status}`);
    res.end(
      JSON.stringify({
        summary: summary || null,
        // Never relay `data.error.message`: that is OpenAI's own wording, and
        // it carries request ids, organization hints and quota phrasing.
        error: response.ok ? null : 'OpenAI HUD summary request failed',
      }),
    );
  } catch {
    console.warn('[hud-summary] request failed');
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: 'OpenAI HUD summary request failed',
      }),
    );
  }
}

export { handleHudSummary, hudSummaryReasoning };
