import { enforceOptInRateLimit, openAiRateLimiter } from './rate-limit.js';
import { readRequestBody } from '../common/request.js';
import { extractOpenAiResponseText } from './response-text.js';

/**
 * Scene analyst for the operations console.
 *
 * The browser sends a question plus a snapshot of what the console can see —
 * camera pose, place label, enabled layers and their feed health — and gets
 * plain text back. The credential stays here, exactly as it does for the
 * realtime voice token, so a hosted deployment brokers the key rather than
 * shipping it.
 *
 * Every request is bounded before it reaches OpenAI: the body is capped, the
 * question is truncated, only the last few turns are replayed, and the
 * serialized context is clipped. An unbounded prompt is a spend bug, and the
 * opt-in per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN) that already covers
 * the other paid endpoints covers this one too.
 */

const ANALYST_MODEL_DEFAULT = 'gpt-5-mini';
const BODY_MAX_BYTES = 32 * 1024;
const QUESTION_MAX_CHARS = 800;
const HISTORY_MAX_TURNS = 6;
const HISTORY_MAX_CHARS = 1200;
const CONTEXT_MAX_CHARS = 6000;
const OUTPUT_MAX_TOKENS = 900;

const ANALYST_INSTRUCTIONS = [
  "You are the scene analyst inside God's Eye View, a live 3D geospatial",
  'intelligence console. The operator is looking at a photorealistic globe.',
  'You are given a JSON snapshot of what the console can see: the camera',
  'position and attitude, the resolved place name, the visual preset, and the',
  'data layers that are enabled with their record counts and feed health.',
  'Answer only from that snapshot plus general world knowledge about the place',
  'it names. Never invent a reading, a count, a contact or a feed the snapshot',
  'does not contain, and say plainly when the snapshot cannot answer the',
  'question. You cannot move the camera or switch layers yourself — when the',
  'operator wants that, name the console control that does it (the command',
  'palette, the module rail, or the layer toggles in the dossier). Reply in the',
  'language the operator used. Keep it under 120 words, in plain prose with no',
  'markdown headings, bullets or asterisks.',
].join(' ');

/** The model the analyst answers on; overridable for cost or capability. */
function analystModel(env = process.env) {
  const configured = String(env.OPENAI_ANALYST_MODEL || '').trim();
  return configured || ANALYST_MODEL_DEFAULT;
}

/**
 * Whether a model accepts the `reasoning` parameter.
 * Sending it to a model that does not is a 400, so an operator who overrides
 * the model with a non-reasoning one keeps a working analyst.
 */
function supportsReasoningEffort(model) {
  return /^(?:gpt-5|o[134])/.test(String(model || ''));
}

/**
 * Clamp a client request into the bounded shape the prompt is built from.
 * @param {object} payload Parsed request body.
 * @returns {{question:string, history:Array<{role:string,text:string}>, context:string}}
 * @throws {Error} With `code: 'EMPTY_QUESTION'` when no question survives.
 */
function normalizeAnalystRequest(payload = {}) {
  const question = String(payload?.question ?? '')
    .trim()
    .slice(0, QUESTION_MAX_CHARS);
  if (!question) {
    const error = new Error('A question is required');
    error.code = 'EMPTY_QUESTION';
    throw error;
  }
  const history = (Array.isArray(payload?.history) ? payload.history : [])
    .slice(-HISTORY_MAX_TURNS)
    .map((turn) => ({
      role: turn?.role === 'assistant' ? 'assistant' : 'user',
      text: String(turn?.text ?? '')
        .trim()
        .slice(0, HISTORY_MAX_CHARS),
    }))
    .filter((turn) => turn.text);
  let context = '{}';
  try {
    context = JSON.stringify(payload?.context ?? {}) || '{}';
  } catch {
    context = '{}';
  }
  return { question, history, context: context.slice(0, CONTEXT_MAX_CHARS) };
}

/** Assemble the single input string the Responses API is called with. */
function analystPrompt({ question, history, context }) {
  const lines = ['SCENE SNAPSHOT (JSON):', context, ''];
  if (history.length) {
    lines.push('EARLIER TURNS:');
    for (const turn of history) {
      lines.push(
        `${turn.role === 'assistant' ? 'ANALYST' : 'OPERATOR'}: ${turn.text}`,
      );
    }
    lines.push('');
  }
  lines.push(`OPERATOR QUESTION: ${question}`);
  return lines.join('\n');
}

/**
 * Build the `/api/openai/analyst` handler.
 *
 * GET reports whether a credential is configured so the console can show the
 * analyst as offline without spending a request on finding out. POST answers
 * a question.
 */
function createAnalystHandler({
  endpoint = 'https://api.openai.com/v1/responses',
  fetchImpl = (...args) => fetch(...args),
  resolveApiKey = () => process.env.OPENAI_API_KEY,
  resolveModel = () => analystModel(),
} = {}) {
  return async (req, res) => {
    const send = (statusCode, payload) => {
      res.statusCode = statusCode;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(payload));
    };

    const apiKey = resolveApiKey();
    const model = resolveModel();

    if (req.method === 'GET') {
      send(200, { configured: Boolean(apiKey), model });
      return;
    }
    if (req.method !== 'POST') {
      send(405, { error: 'Method not allowed' });
      return;
    }
    if (!apiKey) {
      send(503, { error: 'OPENAI_API_KEY is not set', configured: false });
      return;
    }
    if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;

    let request;
    try {
      const body = await readRequestBody(req, BODY_MAX_BYTES);
      request = normalizeAnalystRequest(JSON.parse(body || '{}'));
    } catch (error) {
      send(400, {
        error:
          error?.code === 'EMPTY_QUESTION'
            ? 'A question is required'
            : 'Malformed analyst request',
      });
      return;
    }

    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          instructions: ANALYST_INSTRUCTIONS,
          input: analystPrompt(request),
          ...(supportsReasoningEffort(model)
            ? { reasoning: { effort: 'low' } }
            : {}),
          max_output_tokens: OUTPUT_MAX_TOKENS,
        }),
      });
      const data = await response.json().catch(() => ({}));
      const answer = extractOpenAiResponseText(data);
      if (!response.ok || !answer) {
        send(response.ok ? 502 : response.status || 502, {
          error: data?.error?.message || 'OpenAI analyst request failed',
        });
        return;
      }
      send(200, { answer, model });
    } catch (error) {
      send(502, { error: error?.message || 'OpenAI analyst request failed' });
    }
  };
}

export {
  ANALYST_INSTRUCTIONS,
  ANALYST_MODEL_DEFAULT,
  analystModel,
  analystPrompt,
  createAnalystHandler,
  normalizeAnalystRequest,
  supportsReasoningEffort,
};
