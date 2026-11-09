import { validateValue } from '../../../src/tools/schema.js';

export function invalidCalls(calls, tools) {
  const schemas = new Map(tools.map((tool) => [tool.name, tool.parameters]));
  return calls.flatMap((call, index) => {
    const schema = schemas.get(call.name);
    const errors = !schema
      ? ['Unknown tool']
      : call.parseError
        ? ['Arguments must be valid JSON']
        : validateValue(schema, call.args === undefined ? {} : call.args);
    return errors.length
      ? [{ index, error: errors.slice(0, 4).join('; ').slice(0, 1000) }]
      : [];
  });
}

// Missing usage stays unknown, never an invented zero-cost request.
export function parseUsage(provider, data) {
  // Vertex AI answers with Gemini's usageMetadata.
  const geminiShape = provider === 'gemini' || provider === 'vertex';
  const raw = geminiShape ? data?.usageMetadata : data?.usage;
  const number = (value) =>
    Number.isSafeInteger(value) && value >= 0 ? value : null;
  // Anthropic's input_tokens excludes cache reads and writes, and it reports
  // no total; both are added up here.
  if (provider === 'anthropic') {
    const input = number(raw?.input_tokens);
    const output = number(raw?.output_tokens);
    if (input === null || output === null) return null;
    const cacheRead = number(raw?.cache_read_input_tokens) ?? 0;
    const cacheCreation = number(raw?.cache_creation_input_tokens) ?? 0;
    const inputTokens = input + cacheRead + cacheCreation;
    return {
      inputTokens,
      outputTokens: output,
      totalTokens: inputTokens + output,
      reasoningTokens: 0,
      cachedInputTokens: cacheRead,
    };
  }
  const inputTokens = number(
    geminiShape ? raw?.promptTokenCount : raw?.prompt_tokens,
  );
  const candidateTokens = number(
    geminiShape ? raw?.candidatesTokenCount : raw?.completion_tokens,
  );
  const totalTokens = number(
    geminiShape ? raw?.totalTokenCount : raw?.total_tokens,
  );
  if (inputTokens === null || candidateTokens === null || totalTokens === null)
    return null;
  const reasoningTokens =
    number(
      geminiShape
        ? raw?.thoughtsTokenCount
        : raw?.completion_tokens_details?.reasoning_tokens,
    ) ?? 0;
  const outputTokens = candidateTokens + (geminiShape ? reasoningTokens : 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cachedInputTokens:
      number(
        geminiShape
          ? raw?.cachedContentTokenCount
          : raw?.prompt_tokens_details?.cached_tokens,
      ) ?? 0,
  };
}
