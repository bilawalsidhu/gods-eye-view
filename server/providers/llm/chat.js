import { readResponseJsonCapped } from '../common/http.js';
import { LLM_CHAT_TIMEOUT_MS, boundFetch, llmAuthHeaders } from './config.js';

/** A one-line completion; anything larger is a runaway model, not an answer. */
const CHAT_BYTE_CAP = 256 * 1024;

/**
 * Pull the assistant text out of an OpenAI-compatible chat completion.
 *
 * llama-server and Ollama both answer with `choices[0].message.content`, but
 * a reasoning model may put the visible answer in `reasoning_content` or
 * split it into content parts — so read all three shapes rather than
 * returning '' and blaming the server.
 * @param {unknown} data
 * @returns {string}
 */
export function extractChatCompletionText(data) {
  const message = data?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join(' ')
      .trim();
    if (joined) return joined;
  }
  if (typeof data?.choices?.[0]?.text === 'string') {
    return data.choices[0].text.trim();
  }
  return '';
}

/**
 * Ask a local, OpenAI-compatible server for one short completion.
 *
 * Total, like the probe: a refused connection, a timeout, an HTTP error, or a
 * body we cannot parse all resolve to `{ok:false, error}`. Callers degrade;
 * nothing throws into a request handler.
 *
 * @param {{config: object, instructions: string, input: string, maxTokens?: number, fetchImpl?: Function, timeoutMs?: number}} request
 * @returns {Promise<{ok: boolean, text: string, error: string|null, status: number|null}>}
 */
export async function requestLlmChatText({
  config,
  instructions,
  input,
  maxTokens = 128,
  fetchImpl = boundFetch(),
  timeoutMs = LLM_CHAT_TIMEOUT_MS,
} = {}) {
  const endpoint = config?.chatUrl || '';
  if (!endpoint) {
    return { ok: false, text: '', error: 'No usable base URL', status: null };
  }
  if (!config.model) {
    return {
      ok: false,
      text: '',
      error: `Set GEV_LLM_MODEL — ${config.label} needs a model id`,
      status: null,
    };
  }
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...llmAuthHeaders(config),
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: input },
        ],
        // A HUD line is deterministic reporting, not creative writing.
        temperature: 0.2,
        max_tokens: maxTokens,
        stream: false,
      }),
    });
    const status = Number.isFinite(response?.status) ? response.status : null;
    if (!response?.ok) {
      return {
        ok: false,
        text: '',
        error: `${config.label} answered ${status ?? '(no status)'}`,
        status,
      };
    }
    const data = await readResponseJsonCapped(response, CHAT_BYTE_CAP);
    const text = extractChatCompletionText(data);
    return {
      ok: Boolean(text),
      text,
      error: text ? null : `${config.label} returned no text`,
      status,
    };
  } catch (error) {
    return {
      ok: false,
      text: '',
      error:
        error?.name === 'TimeoutError'
          ? `${config.label} did not answer in time`
          : error?.message || 'Local model request failed',
      status: null,
    };
  }
}
