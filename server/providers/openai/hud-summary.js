import {
  HUD_SUMMARY_FEED_STATES,
  HUD_SUMMARY_MAX_UNSPACED_CHARS,
  HUD_SUMMARY_RESPONSE_FORMAT,
  hudSummaryInput,
  hudSummaryInstructions,
  keylessHudSummaryResponse,
} from '../../../src/hudSummaryResponse.js';
import { enforceRateLimit, openAiRateLimiter } from './rate-limit.js';
import { readRequestBody } from '../common/request.js';
import { OPENAI_HUD_SUMMARY_MODEL_DEFAULT } from './constants.js';

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

/** Parse the summary and normalize the canonical feed state. */
function parseHudSummaryReply(text) {
  let reply = null;
  try {
    reply = JSON.parse(text);
  } catch {
    /* not JSON: no summary */
  }
  const feedState = HUD_SUMMARY_FEED_STATES.includes(reply?.feedState)
    ? reply.feedState
    : null;
  return {
    summary: toFiveWordHudSummary(reply?.summary),
    feedState: feedState === 'none' ? null : feedState,
  };
}

function toFiveWordHudSummary(value) {
  const words = String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
  // Japanese and Chinese have no spaces to count words by: cap characters.
  if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(words))
    return words;
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return [...graphemes.segment(words)]
    .slice(0, HUD_SUMMARY_MAX_UNSPACED_CHARS)
    .map(({ segment }) => segment)
    .join('')
    .trim();
}

async function handleHudSummary(req, res) {
  // Capability probe: lets the HUD skip its paid place lookups when there is
  // no summary to feed them to.
  if (req.method === 'GET' && req.url?.split('?')[0] === '/status') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify({
        configured: !keylessHudSummaryResponse(process.env.OPENAI_API_KEY),
      }),
    );
    return;
  }
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
        instructions: hudSummaryInstructions(context?.locale),
        input: hudSummaryInput(context),
        text: { format: HUD_SUMMARY_RESPONSE_FORMAT },
        reasoning: { effort: 'minimal' },
        max_output_tokens: 200,
      }),
    });
    const data = await response.json().catch(() => ({}));
    const { summary, feedState } = parseHudSummaryReply(
      extractOpenAiResponseText(data),
    );
    res.statusCode = response.ok && summary ? 200 : response.status || 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (!response.ok)
      console.warn(`[hud-summary] upstream HTTP ${response.status}`);
    res.end(
      JSON.stringify({
        summary: summary || null,
        feedState,
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

export { handleHudSummary };
