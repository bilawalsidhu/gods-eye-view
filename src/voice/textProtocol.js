/** Only the wire format differs; the UI and action lifetime use one text loop. */
export const textProtocols = {
  gemini: {
    endpoint: '/api/gemini/chat',
    keyEnv: 'GEMINI_API_KEY',
    user: (text) => ({ role: 'user', parts: [{ text }] }),
    note: (text) => ({ role: 'model', parts: [{ text }] }),
    isUser: (item) =>
      item.role === 'user' &&
      item.parts.some((part) => typeof part.text === 'string'),
    request: (contents) => ({ contents }),
    decode(data) {
      const content = data?.content;
      if (
        content?.role !== 'model' ||
        !Array.isArray(content.parts) ||
        !content.parts.length ||
        content.parts.length > 32
      )
        throw Error('Invalid response');
      return {
        content,
        text: content.parts
          .filter((part) => typeof part.text === 'string' && !part.thought)
          .map((part) => part.text)
          .join(''),
        calls: content.parts
          .filter((part) => part.functionCall)
          .map((part) => part.functionCall),
        finished: data.finishReason === 'STOP',
      };
    },
    results: (pairs) => [
      {
        role: 'user',
        parts: pairs.map(({ call, result }) => ({
          functionResponse: {
            name: call.name,
            ...(call.id ? { id: call.id } : {}),
            response: result,
          },
        })),
      },
    ],
    compactResult: (item, maxBytes) =>
      item.role === 'user' && item.parts.some((part) => part.functionResponse)
        ? {
            ...item,
            parts: item.parts.map((part) =>
              part.functionResponse
                ? {
                    ...part,
                    functionResponse: {
                      ...part.functionResponse,
                      response: boundedToolResult(
                        part.functionResponse.response,
                        maxBytes,
                      ),
                    },
                  }
                : part,
            ),
          }
        : item,
  },
  openai: {
    endpoint: '/api/openai/chat',
    keyEnv: 'OPENAI_API_KEY',
    user: (content) => ({ role: 'user', content }),
    note: (content) => ({ role: 'assistant', content }),
    isUser: (item) => item.role === 'user',
    request: (messages) => ({ messages }),
    decode(data) {
      const content = data?.content;
      if (
        content?.role !== 'assistant' ||
        (content.content != null && typeof content.content !== 'string') ||
        (content.tool_calls !== undefined && !Array.isArray(content.tool_calls))
      )
        throw Error('Invalid response');
      return {
        content,
        text: content.content || '',
        calls: (content.tool_calls || []).map((call) => {
          let args;
          try {
            args = JSON.parse(call.function.arguments);
          } catch {
            /* Server supplies the paired validation error. */
          }
          return { id: call.id, name: call.function.name, args };
        }),
        finished: data.finishReason === 'stop',
      };
    },
    results: (pairs) =>
      pairs.map(({ call, result }) => ({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      })),
    compactResult(item, maxBytes) {
      if (item.role !== 'tool') return item;
      let result;
      try {
        result = JSON.parse(item.content);
      } catch {
        result = { ok: false, error: 'Tool result could not be read' };
      }
      return {
        ...item,
        content: JSON.stringify(boundedToolResult(result, maxBytes)),
      };
    },
  },
};

export const emptyTextUsage = () => ({
  requests: 0,
  reportedRequests: 0,
  unknownRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
});
export function addTextUsage(total, usage) {
  total.requests++;
  if (
    !usage ||
    !['inputTokens', 'outputTokens', 'totalTokens'].every(
      (key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0,
    )
  ) {
    total.unknownRequests++;
    return;
  }
  total.reportedRequests++;
  for (const key of [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'reasoningTokens',
    'cachedInputTokens',
  ]) {
    if (Number.isSafeInteger(usage[key]) && usage[key] >= 0)
      total[key] += usage[key];
  }
}

const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
// Adapted from Darren Dignam's GEV COMMAND (#976): reduce values, never cut JSON.
// Byte limits also cover multibyte strings; success/failure and the say line survive.
export function boundedToolResult(result, maxBytes = 12000) {
  let value;
  try {
    value = JSON.parse(JSON.stringify(result ?? { ok: false }));
  } catch {
    return { ok: false, error: 'Tool result could not be serialized' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    value = { ok: false, value };
  if (bytes(value) <= maxBytes) return value;
  const essential = new Set([
    'ok',
    'action',
    'error',
    'say',
    'partial',
    'scopeLabel',
    'count',
    'reason',
    'responseGuidance',
  ]);
  value.truncated = true;
  for (const key of Object.keys(value)
    .filter((key) => !essential.has(key) && key !== 'truncated')
    .sort((a, b) => bytes(value[b]) - bytes(value[a]))) {
    value[key] = '[omitted oversized field]';
    if (bytes(value) <= maxBytes) return value;
  }
  // Preserve the action outcome while explicitly omitting oversized details.
  return {
    ok: value.ok === true,
    truncated: true,
    partial: true,
    error: 'Detailed tool result exceeded the response limit',
  };
}
