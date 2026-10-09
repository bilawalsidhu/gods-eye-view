/**
 * Shapes the message array that crosses the wire on every typed command.
 *
 * The browser owns the transcript and resends it, which keeps the server
 * stateless like every other proxy in this project. That makes this module the
 * one both sides need: the browser trims history to fit the request body, and
 * the server treats whatever arrives as untrusted — an over-long transcript is
 * a cost problem, an unknown role is an upstream 400, and a `tool` message
 * whose originating `assistant` call was trimmed away is a hard API error
 * rather than a degraded answer.
 */

/** Roles the chat-completions surface accepts. */
const AGENT_ROLES = Object.freeze(['system', 'user', 'assistant', 'tool']);

/**
 * Turns of history retained before trimming.
 *
 * The instructions and tool schemas already dominate every request, so
 * history is the one part of the payload that can be bounded without breaking
 * tool calling.
 */
const MAX_HISTORY_MESSAGES = 40;

/** Per-message content ceiling. Tool results are the usual offender. */
const MAX_CONTENT_CHARS = 8000;

/** Serialized tool-result ceiling, kept well inside MAX_CONTENT_CHARS. */
const MAX_TOOL_RESULT_CHARS = 6000;

/** Characters per token used for every rough budget readout here. */
const CHARS_PER_TOKEN = 4;

/**
 * Result fields never shed when a tool result is too large.
 *
 * The manual tells the model never to claim an action without `ok: true` and
 * to speak the `say` line, so a bounded result that dropped those would be
 * worse than no result at all.
 */
const ESSENTIAL_RESULT_KEYS = Object.freeze([
  'ok',
  'action',
  'error',
  'say',
  'partial',
  'scopeLabel',
  'count',
]);

/** Clamp a string, marking the truncation so the model knows it is partial. */
function clampContent(text, maxChars) {
  if (typeof text !== 'string') return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} characters]`;
}

/** Byte length of a UTF-8 string without allocating a Buffer. */
function utf8Length(text) {
  let bytes = 0;
  for (const character of String(text)) {
    const code = character.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Describe one shed value compactly, so the model can see that something was
 * there rather than concluding the field was absent.
 */
function describeShedValue(value) {
  if (Array.isArray(value)) return `[omitted ${value.length} items]`;
  if (value !== null && typeof value === 'object') {
    return `[omitted ${Object.keys(value).length} fields]`;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value) || '';
  return `[omitted ${text.length} characters]`;
}

/**
 * Serialize one action result to JSON that is bounded AND still valid JSON.
 *
 * Clamping the serialized string would cut mid-object, and a model handed
 * `{"ok":true,"records":[{"callsi` has to guess; the guesses are confident and
 * wrong. So the bound is applied to the VALUE: the largest non-essential
 * fields are replaced by a marker, largest first, until the result fits, and
 * the output is always parseable.
 *
 * @param {unknown} result
 * @param {{maxChars?: number, essentialKeys?: readonly string[]}} [options]
 * @returns {string} Valid JSON, at most `maxChars` characters.
 */
function boundedResultJson(
  result,
  {
    maxChars = MAX_TOOL_RESULT_CHARS,
    essentialKeys = ESSENTIAL_RESULT_KEYS,
  } = {},
) {
  const value = result ?? { ok: false };
  let json = JSON.stringify(value) ?? 'null';
  if (json.length <= maxChars) return json;

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    // A bare oversized string or array has no fields to shed; say so instead
    // of returning a prefix of its own serialization.
    return JSON.stringify({
      ok: false,
      error: 'Result too large to return',
      omitted: describeShedValue(value),
    });
  }

  const bounded = { ...value };
  const sheddable = Object.keys(bounded)
    .filter((key) => !essentialKeys.includes(key))
    .map((key) => ({ key, size: (JSON.stringify(bounded[key]) ?? '').length }))
    .sort((a, b) => b.size - a.size);

  for (const { key } of sheddable) {
    bounded[key] = describeShedValue(value[key]);
    json = JSON.stringify(bounded);
    if (json.length <= maxChars) return json;
  }

  // Every sheddable field is a marker and it still does not fit, which means
  // an essential field is itself enormous. Keep `ok` legible and say why.
  const essentials = { ok: bounded.ok === true };
  json = JSON.stringify({
    ...essentials,
    error: 'Result too large to return',
  });
  return json.length <= maxChars ? json : JSON.stringify({ ok: false });
}

/**
 * Normalize one tool call from an assistant message.
 *
 * Arguments stay a string: they are validated against the tool schema at
 * dispatch time, not on the way through.
 */
function sanitizeToolCall(raw) {
  const id = typeof raw?.id === 'string' && raw.id ? raw.id : null;
  const name =
    typeof raw?.function?.name === 'string' ? raw.function.name.trim() : '';
  if (!id || !name) return null;
  const args = raw.function.arguments;
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    },
  };
}

/**
 * Normalize one message, dropping anything the upstream API would reject.
 *
 * @param {unknown} raw
 * @param {{maxContentChars?: number}} [options]
 * @returns {object|null} A wire-safe message, or null when unusable.
 */
function sanitizeMessage(raw, { maxContentChars = MAX_CONTENT_CHARS } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const role = typeof raw.role === 'string' ? raw.role.trim() : '';
  if (!AGENT_ROLES.includes(role)) return null;

  if (role === 'tool') {
    const toolCallId =
      typeof raw.tool_call_id === 'string' && raw.tool_call_id
        ? raw.tool_call_id
        : null;
    if (!toolCallId) return null;
    // A tool result is already bounded JSON when this app wrote it; a result
    // arriving as something else is bounded again rather than trusted.
    const content =
      typeof raw.content === 'string'
        ? clampContent(raw.content, maxContentChars)
        : boundedResultJson(raw.content ?? null);
    return { role: 'tool', tool_call_id: toolCallId, content };
  }

  if (role === 'assistant') {
    const toolCalls = Array.isArray(raw.tool_calls)
      ? raw.tool_calls.map(sanitizeToolCall).filter(Boolean)
      : [];
    const content =
      typeof raw.content === 'string'
        ? clampContent(raw.content, maxContentChars)
        : '';
    // An assistant turn with neither content nor a tool call carries nothing.
    if (!content && !toolCalls.length) return null;
    const message = { role: 'assistant', content };
    if (toolCalls.length) message.tool_calls = toolCalls;
    return message;
  }

  const content =
    typeof raw.content === 'string'
      ? clampContent(raw.content, maxContentChars)
      : '';
  if (!content) return null;
  return { role, content };
}

/**
 * Normalize a whole transcript.
 *
 * @param {unknown} raw
 * @param {{maxContentChars?: number}} [options]
 * @returns {object[]}
 */
function sanitizeMessages(raw, options = {}) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((message) => sanitizeMessage(message, options))
    .filter(Boolean);
}

/**
 * Drop `tool` messages that no longer answer an assistant tool call.
 *
 * Sending one is not a degraded request, it is a 400 from every provider, so
 * this runs after any trim that could have removed the originating call.
 *
 * @param {object[]} messages
 * @returns {object[]}
 */
function dropOrphanToolMessages(messages) {
  const answered = new Set();
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) answered.add(call.id);
    }
  }
  return messages.filter(
    (message) => message.role !== 'tool' || answered.has(message.tool_call_id),
  );
}

/**
 * The nearest index at or before `desiredStart` that is not a tool result.
 *
 * Starting a kept slice on a `tool` message would send a result whose
 * originating `assistant` call was trimmed away, which every provider answers
 * with a 400 rather than a degraded completion.
 */
function pairSafeStart(messages, desiredStart) {
  let start = Math.max(0, Math.min(desiredStart, messages.length));
  while (start > 0 && messages[start]?.role === 'tool') start -= 1;
  return start;
}

/** Indexes a kept slice may begin on, oldest first. */
function safeStarts(messages) {
  const starts = [];
  messages.forEach((message, index) => {
    if (message?.role !== 'tool') starts.push(index);
  });
  return starts;
}

/**
 * Trim history to a bounded number of messages, keeping the newest.
 *
 * The cap is a target rather than a hard ceiling: a trim refuses to cut
 * between an assistant tool call and its results.
 *
 * @param {object[]} messages
 * @param {{maxMessages?: number}} [options]
 * @returns {object[]}
 */
function trimHistory(messages, { maxMessages = MAX_HISTORY_MESSAGES } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= maxMessages) return dropOrphanToolMessages([...list]);
  return dropOrphanToolMessages(
    list.slice(pairSafeStart(list, list.length - maxMessages)),
  );
}

/**
 * Serialized size of one request body's message array.
 *
 * @param {object[]} messages
 * @returns {number} UTF-8 bytes.
 */
function messagesByteLength(messages) {
  return utf8Length(JSON.stringify(Array.isArray(messages) ? messages : []));
}

/**
 * Drop the oldest exchanges until the transcript fits a byte budget.
 *
 * The server caps the request body, so a long session would otherwise reach a
 * point where every command fails at once with a 413 and nothing in the panel
 * explains why. Trimming on the client keeps the session usable and keeps
 * tool-call pairs intact; the newest turn is always retained even when it
 * alone exceeds the budget, because refusing to send it is not an improvement.
 *
 * @param {object[]} messages
 * @param {{maxBytes: number}} options
 * @returns {{messages: object[], dropped: number}}
 */
function fitHistoryToBytes(messages, { maxBytes }) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return { messages: [], dropped: 0 };
  for (const start of safeStarts(list)) {
    const candidate = dropOrphanToolMessages(list.slice(start));
    if (messagesByteLength(candidate) <= maxBytes) {
      return { messages: candidate, dropped: list.length - candidate.length };
    }
  }
  // Even the newest exchange alone exceeds the budget. Send it anyway: the
  // server's own cap is the authority on refusal, and silently sending an
  // empty transcript would make the model answer a question nobody asked.
  const newestStart = safeStarts(list).at(-1) ?? 0;
  const newest = dropOrphanToolMessages(list.slice(newestStart));
  return { messages: newest, dropped: list.length - newest.length };
}

/**
 * Assemble the final request payload: instructions first, then bounded history.
 *
 * Any `system` message arriving from the client is discarded. The instructions
 * are the app's contract with the model and are not client-supplied.
 *
 * @param {{instructions: string, messages: object[], maxMessages?: number,
 *   maxContentChars?: number}} options
 * @returns {object[]}
 */
function buildRequestMessages({
  instructions,
  messages,
  maxMessages = MAX_HISTORY_MESSAGES,
  maxContentChars = MAX_CONTENT_CHARS,
}) {
  const sanitized = sanitizeMessages(messages, { maxContentChars }).filter(
    (message) => message.role !== 'system',
  );
  const trimmed = trimHistory(sanitized, { maxMessages });
  return [{ role: 'system', content: String(instructions ?? '') }, ...trimmed];
}

/**
 * Build the tool result message answering one call.
 *
 * The action runner returns plain objects; JSON is what the model reads best,
 * and it keeps the `ok` flag legible so the model can honour the "never claim
 * an action without ok=true" directive.
 *
 * @param {string} toolCallId
 * @param {unknown} result
 * @returns {{role: 'tool', tool_call_id: string, content: string}}
 */
function toolResultMessage(toolCallId, result) {
  return {
    role: 'tool',
    tool_call_id: String(toolCallId),
    content: boundedResultJson(result),
  };
}

export {
  AGENT_ROLES,
  CHARS_PER_TOKEN,
  ESSENTIAL_RESULT_KEYS,
  MAX_CONTENT_CHARS,
  MAX_HISTORY_MESSAGES,
  MAX_TOOL_RESULT_CHARS,
  boundedResultJson,
  buildRequestMessages,
  dropOrphanToolMessages,
  fitHistoryToBytes,
  messagesByteLength,
  sanitizeMessage,
  sanitizeMessages,
  toolResultMessage,
  trimHistory,
};
