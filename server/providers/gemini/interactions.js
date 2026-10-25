/**
 * Minimal Gemini Interactions API client for short server-side text tasks.
 *
 * Google recommends the Interactions API over `generateContent` for new work
 * (https://ai.google.dev/gemini-api/docs/migrate-to-interactions). One call is
 * one stateless turn: `store: false` keeps the request off Google's
 * interaction store, since nothing here ever reads an interaction back.
 *
 * The key stays on the server (GEMINI_API_KEY) and travels only in the
 * `x-goog-api-key` header, never in a URL that a proxy or log could keep.
 */

const GEMINI_INTERACTIONS_URL =
  'https://generativelanguage.googleapis.com/v1beta/interactions';

/**
 * Upper bound on one call. The HUD abandons its summary request after 5 s
 * (src/hud.js), so waiting longer only spends quota on an answer nobody reads.
 */
const GEMINI_TEXT_TIMEOUT_MS = 5_000;

/**
 * Accept a plain Gemini model id, with or without the `models/` prefix.
 * Anything else could reshape the request, so it resolves to null.
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeGeminiTextModel(value) {
  if (typeof value !== 'string') return null;
  const model = value.trim().replace(/^models\//, '');
  return /^gemini-[a-z0-9][a-z0-9.-]{0,119}$/.test(model) ? model : null;
}

/**
 * Join the text blocks of the model-output steps of an interaction.
 * Thought steps and the echoed user input are not answer text.
 * @param {unknown} data Parsed Interaction resource.
 * @returns {string}
 */
function extractGeminiInteractionText(data) {
  if (!Array.isArray(data?.steps)) return '';
  return data.steps
    .filter((step) => step?.type === 'model_output')
    .flatMap((step) => (Array.isArray(step.content) ? step.content : []))
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
    .trim();
}

/**
 * Send one single-turn interaction.
 *
 * Only a `completed` interaction counts as an answer: `incomplete` (for
 * example the output budget ran out mid-thought) can still carry a fragment,
 * and a fragment is not something to show as a summary.
 *
 * @param {{ apiKey: string, model: string, systemInstruction: string,
 *   input: string, maxOutputTokens?: number,
 *   thinkingLevel?: 'minimal'|'low'|'medium'|'high', timeoutMs?: number,
 *   fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ ok: boolean, status: number, text: string }>}
 */
async function createGeminiInteractionText({
  apiKey,
  model,
  systemInstruction,
  input,
  maxOutputTokens = 100,
  thinkingLevel,
  timeoutMs = GEMINI_TEXT_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  const modelId = normalizeGeminiTextModel(model);
  if (!modelId) throw new Error('Invalid Gemini model id');
  const generationConfig = { max_output_tokens: maxOutputTokens };
  if (thinkingLevel) {
    generationConfig.thinking_level = thinkingLevel;
    generationConfig.thinking_summaries = 'none';
  }
  const response = await fetchImpl(GEMINI_INTERACTIONS_URL, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: modelId,
      system_instruction: systemInstruction,
      input,
      store: false,
      generation_config: generationConfig,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, status: response.status, text: '' };
  if (data?.status !== 'completed') return { ok: false, status: 502, text: '' };
  return {
    ok: true,
    status: response.status,
    text: extractGeminiInteractionText(data),
  };
}

export {
  GEMINI_INTERACTIONS_URL,
  GEMINI_TEXT_TIMEOUT_MS,
  createGeminiInteractionText,
  extractGeminiInteractionText,
  normalizeGeminiTextModel,
};
