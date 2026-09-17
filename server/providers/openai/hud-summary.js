import { keylessHudSummaryResponse } from '../../../src/hudSummaryResponse.js';
import { enforceOptInRateLimit, openAiRateLimiter } from './rate-limit.js';
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

function toFiveWordHudSummary(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

async function handleHudSummary(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  const customBaseUrl = (
    process.env.OPENAI_BASE_URL ||
    process.env.LLM_BASE_URL ||
    ''
  ).trim();
  const effectiveAuth = apiKey || customBaseUrl;
  const keyless = keylessHudSummaryResponse(effectiveAuth);
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
    const baseUrl = (customBaseUrl || 'https://api.openai.com/v1').replace(
      /\/+$/,
      '',
    );
    const model =
      (
        process.env.OPENAI_HUD_SUMMARY_MODEL ||
        process.env.LLM_MODEL ||
        ''
      ).trim() || OPENAI_HUD_SUMMARY_MODEL_DEFAULT;

    const instructions = [
      "Write one concise intelligence-HUD summary for God's Eye View.",
      'Use only the supplied place, street, nearby-place, and enabled-layer text labels.',
      'Prefer the clearest named place and include a relevant enabled layer only when useful.',
      'Do not infer from coordinates or invent a place.',
      'Output exactly five words with no title, punctuation, markdown, or introductory phrase.',
    ].join(' ');

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    // Standard OpenAI-compatible /chat/completions (Groq, Grok, Ollama, DeepSeek, OpenAI)
    let response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: JSON.stringify(context) },
        ],
        max_tokens: 100,
      }),
    });

    // Fallback to OpenAI proprietary /responses endpoint if needed
    if (response.status === 404 && baseUrl === 'https://api.openai.com/v1') {
      response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          instructions,
          input: JSON.stringify(context),
          reasoning: { effort: 'minimal' },
          max_output_tokens: 100,
        }),
      });
    }

    const data = await response.json().catch(() => ({}));
    let rawText = '';
    if (data?.choices?.[0]?.message?.content) {
      rawText = data.choices[0].message.content;
    } else {
      rawText = extractOpenAiResponseText(data);
    }
    const summary = toFiveWordHudSummary(rawText);
    res.statusCode = response.ok && summary ? 200 : response.status || 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify({
        summary: summary || null,
        error: response.ok
          ? null
          : data.error?.message || 'LLM HUD summary request failed',
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
}

export { handleHudSummary };
