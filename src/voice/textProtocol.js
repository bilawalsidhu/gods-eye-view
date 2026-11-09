const gemini = {
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
};

/** Only the wire format differs; the UI and action lifetime use one text loop. */
export const textProtocols = {
  gemini,
  // Vertex AI carries Gemini's contents; its reference also prints the proto
  // name of the stop reason, so both spellings end a turn.
  vertex: {
    ...gemini,
    endpoint: '/api/vertex/chat',
    keyEnv: 'VERTEX_API_KEY',
    decode(data) {
      const decoded = gemini.decode(data);
      return {
        ...decoded,
        finished: ['STOP', 'FINISH_REASON_STOP'].includes(data.finishReason),
      };
    },
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
  anthropic: {
    endpoint: '/api/anthropic/chat',
    keyEnv: 'ANTHROPIC_API_KEY',
    user: (text) => ({ role: 'user', content: text }),
    note: (text) => ({ role: 'assistant', content: [{ type: 'text', text }] }),
    // A tool_result message is not a user turn boundary.
    isUser: (item) =>
      item.role === 'user' &&
      (typeof item.content === 'string' ||
        item.content.some((block) => block.type === 'text')),
    request: (messages) => ({ messages }),
    decode(data) {
      const content = data?.content;
      if (
        content?.role !== 'assistant' ||
        !Array.isArray(content.content) ||
        !content.content.length ||
        content.content.length > 32
      )
        throw Error('Invalid response');
      return {
        content,
        text: content.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join(''),
        calls: content.content
          .filter((block) => block.type === 'tool_use')
          .map((block) => ({
            id: block.id,
            name: block.name,
            args: block.input,
          })),
        finished: data.finishReason === 'end_turn',
      };
    },
    results: (pairs) => [
      {
        role: 'user',
        content: pairs.map(({ call, result }) => ({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(result),
        })),
      },
    ],
    compactResult(item, maxBytes) {
      if (item.role !== 'user' || !Array.isArray(item.content)) return item;
      return {
        ...item,
        content: item.content.map((block) => {
          if (block.type !== 'tool_result') return block;
          let result;
          try {
            result = JSON.parse(block.content);
          } catch {
            result = { ok: false, error: 'Tool result could not be read' };
          }
          return {
            ...block,
            content: JSON.stringify(boundedToolResult(result, maxBytes)),
          };
        }),
      };
    },
  },
  bedrock: {
    endpoint: '/api/bedrock/chat',
    keyEnv: 'AWS_BEARER_TOKEN_BEDROCK',
    user: (text) => ({ role: 'user', content: [{ text }] }),
    note: (text) => ({ role: 'assistant', content: [{ text }] }),
    // A toolResult message is not a user turn boundary.
    isUser: (item) =>
      item.role === 'user' && item.content.some((block) => 'text' in block),
    request: (messages) => ({ messages }),
    decode(data) {
      const content = data?.content;
      if (
        content?.role !== 'assistant' ||
        !Array.isArray(content.content) ||
        !content.content.length ||
        content.content.length > 32
      )
        throw Error('Invalid response');
      // Reasoning blocks stay in content for history and are never shown.
      return {
        content,
        text: content.content
          .filter((block) => typeof block.text === 'string')
          .map((block) => block.text)
          .join(''),
        calls: content.content
          .filter((block) => block.toolUse)
          .map(({ toolUse }) => ({
            id: toolUse.toolUseId,
            name: toolUse.name,
            args: toolUse.input,
          })),
        finished: data.finishReason === 'end_turn',
      };
    },
    results: (pairs) => [
      {
        role: 'user',
        content: pairs.map(({ call, result }) => ({
          toolResult: { toolUseId: call.id, content: [{ json: result }] },
        })),
      },
    ],
    compactResult: (item, maxBytes) =>
      item.role === 'user' && item.content.some((block) => block.toolResult)
        ? {
            ...item,
            content: item.content.map((block) =>
              block.toolResult
                ? {
                    toolResult: {
                      ...block.toolResult,
                      content: [
                        {
                          json: boundedToolResult(
                            block.toolResult.content[0]?.json,
                            maxBytes,
                          ),
                        },
                      ],
                    },
                  }
                : block,
            ),
          }
        : item,
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
