import { keylessHudSummaryResponse } from '../../../src/hudSummaryResponse.js';
import { enforceOptInRateLimit, openAiRateLimiter } from './rate-limit.js';
import { readRequestBody } from '../common/request.js';
import { OPENAI_HUD_SUMMARY_MODEL_DEFAULT } from './constants.js';
import { boundFetch, llmRuntimeConfig } from '../llm/config.js';
import { requestLlmChatText } from '../llm/chat.js';

/** The HUD line's whole brief, shared by every provider. */
const HUD_SUMMARY_INSTRUCTIONS = [
  "Write one concise intelligence-HUD summary for God's Eye View.",
  'Use only the supplied place, street, nearby-place, and enabled-layer text labels.',
  'Prefer the clearest named place and include a relevant enabled layer only when useful.',
  'Do not infer from coordinates or invent a place.',
  'Output exactly five words with no title, punctuation, markdown, or introductory phrase.',
].join(' ');

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
 * POST /api/openai/hud-summary — the five-word AI HUD line.
 *
 * Routes to whichever text backend GEV_LLM_PROVIDER selects. OpenAI (the
 * default) keeps using the Responses API exactly as before; Ollama and
 * llama.cpp go through their OpenAI-compatible /v1/chat/completions.
 *
 * @param {{fetchImpl?: Function, env?: Record<string, string|undefined>}} options
 */
function createHudSummaryHandler({ fetchImpl, env } = {}) {
  return async (req, res) => {
    const environment = env || process.env;
    const doFetch = fetchImpl || boundFetch();
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const config = llmRuntimeConfig(environment);
    const unconfigured = () => {
      // The deliberate, successful "no capability" answer. src/hud.js reads
      // it and shows its own fallback line without logging — which is also
      // the right answer for a local model that is simply not running: the
      // globe must never care, and Provider Settings' "Test connection" is
      // where you find out why.
      const keyless = keylessHudSummaryResponse('');
      res.statusCode = keyless.statusCode;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(keyless.payload));
    };

    const apiKey = config.apiKey;
    if (config.requiresKey && !apiKey) {
      unconfigured();
      return;
    }

    // Opt-in per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN). The unconfigured
    // fallback above has no provider cost and resolves without consuming a
    // quota slot; a local model is free but still worth bounding on a shared
    // host, so the limiter applies to every backend that actually runs.
    if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;

    let context;
    try {
      context = JSON.parse((await readRequestBody(req, 64 * 1024)) || '{}');
    } catch (error) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: error?.message || 'HUD summary request failed',
        }),
      );
      return;
    }

    if (config.api === 'chat') {
      const result = await requestLlmChatText({
        config,
        instructions: HUD_SUMMARY_INSTRUCTIONS,
        input: JSON.stringify(context),
        maxTokens: 64,
        fetchImpl: doFetch,
      });
      const summary = toFiveWordHudSummary(result.text);
      if (!summary) {
        // Unreachable, misconfigured, or silent: degrade, never break.
        unconfigured();
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ summary, error: null }));
      return;
    }

    try {
      const response = await doFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model:
            environment.OPENAI_HUD_SUMMARY_MODEL ||
            OPENAI_HUD_SUMMARY_MODEL_DEFAULT,
          instructions: HUD_SUMMARY_INSTRUCTIONS,
          input: JSON.stringify(context),
          reasoning: { effort: 'minimal' },
          max_output_tokens: 100,
        }),
      });
      const data = await response.json().catch(() => ({}));
      const summary = toFiveWordHudSummary(extractOpenAiResponseText(data));
      res.statusCode = response.ok && summary ? 200 : response.status || 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(
        JSON.stringify({
          summary: summary || null,
          error: response.ok
            ? null
            : data.error?.message || 'OpenAI HUD summary request failed',
        }),
      );
    } catch (error) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: error?.message || 'OpenAI HUD summary request failed',
        }),
      );
    }
  };
}

/** The dev server's instance; reads the live process.env on every request. */
const handleHudSummary = createHudSummaryHandler();

export { createHudSummaryHandler, handleHudSummary, HUD_SUMMARY_INSTRUCTIONS };
