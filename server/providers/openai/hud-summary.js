import { keylessHudSummaryResponse } from '../../../src/hudSummaryResponse.js';
import { enforceOptInRateLimit, openAiRateLimiter } from './rate-limit.js';
import { readRequestBody } from '../common/request.js';
import {
  OPENAI_HUD_SUMMARY_CODEX_MODEL_DEFAULT,
  OPENAI_HUD_SUMMARY_MODEL_DEFAULT,
} from './constants.js';
import { resolveOpenAiCredential, SOURCE_CODEX_OAUTH } from './codex-auth.js';

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

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
 * Pull the assistant text out of a Codex-backend SSE stream. The completed
 * response object is preferred; output_text.done events are the fallback.
 *
 * @param {string} sseBody
 * @returns {string}
 */
function extractCodexStreamText(sseBody) {
  let fallback = '';
  for (const line of String(sseBody).split('\n')) {
    if (!line.startsWith('data:')) continue;
    let event;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (event?.type === 'response.completed') {
      const text = extractOpenAiResponseText(event.response);
      if (text) return text;
    }
    if (event?.type === 'response.output_text.done' && event.text) {
      fallback = fallback ? `${fallback} ${event.text}` : event.text;
    }
  }
  return fallback;
}

function createHudSummaryHandler({
  fetchImpl = (...args) => fetch(...args),
  resolveCredential = resolveOpenAiCredential,
  env = process.env,
} = {}) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Same layered auth as the voice token endpoint: an explicit
    // GEV_PREFER_CODEX_OAUTH pin, then OPENAI_API_KEY, then the local Codex
    // CLI login. No credential at all keeps the free deterministic fallback.
    let credential = null;
    try {
      credential = resolveCredential();
    } catch {
      credential = null;
    }
    const keyless = keylessHudSummaryResponse(credential?.token);
    if (keyless) {
      res.statusCode = keyless.statusCode;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(keyless.payload));
      return;
    }

    // Opt-in per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN). Keyless HUD
    // fallback has no provider cost and resolves above without consuming a
    // paid-endpoint quota slot.
    if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;

    try {
      const body = await readRequestBody(req, 64 * 1024);
      const context = JSON.parse(body || '{}');
      // The Codex lane talks to the ChatGPT backend (the same endpoint the
      // Codex CLI uses): strict wire shape, SSE stream, account-id header.
      // The key lane keeps the platform Responses API.
      const viaCodex = credential.source === SOURCE_CODEX_OAUTH;
      const response = viaCodex
        ? await fetchImpl(CODEX_RESPONSES_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${credential.token}`,
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              'ChatGPT-Account-Id': credential.chatgptAccountId || '',
            },
            body: JSON.stringify({
              model:
                env.OPENAI_HUD_SUMMARY_CODEX_MODEL ||
                OPENAI_HUD_SUMMARY_CODEX_MODEL_DEFAULT,
              store: false,
              stream: true,
              instructions: HUD_SUMMARY_INSTRUCTIONS,
              input: [
                {
                  type: 'message',
                  role: 'user',
                  content: [
                    { type: 'input_text', text: JSON.stringify(context) },
                  ],
                },
              ],
            }),
          })
        : await fetchImpl('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${credential.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model:
                env.OPENAI_HUD_SUMMARY_MODEL ||
                OPENAI_HUD_SUMMARY_MODEL_DEFAULT,
              instructions: HUD_SUMMARY_INSTRUCTIONS,
              input: JSON.stringify(context),
              reasoning: { effort: 'minimal' },
              max_output_tokens: 100,
            }),
          });
      const raw = await response.text();
      let data = {};
      if (!viaCodex || !response.ok) {
        try {
          data = JSON.parse(raw || '{}');
        } catch {
          data = {};
        }
      }
      const summary = toFiveWordHudSummary(
        viaCodex
          ? extractCodexStreamText(raw)
          : extractOpenAiResponseText(data),
      );
      res.statusCode = response.ok && summary ? 200 : response.status || 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-GEV-Hud-Auth', credential.source);
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

const handleHudSummary = createHudSummaryHandler();

export { createHudSummaryHandler, extractCodexStreamText, handleHudSummary };
