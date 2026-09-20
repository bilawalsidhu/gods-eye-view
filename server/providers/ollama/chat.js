/**
 * Streaming Ollama /api/chat client used by the local voice path.
 * Owns the request shape (context size, keep-alive, thinking toggle) so the
 * voice loop and the HUD summary send consistent requests.
 */
export function ollamaBaseUrl(env = process.env) {
  const value = env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('Invalid Ollama URL');
  return url.href.replace(/\/$/, '');
}

export function ollamaRequestDefaults(env = process.env) {
  return {
    keep_alive: env.OLLAMA_KEEP_ALIVE || '30m',
    num_ctx: Number(env.OLLAMA_NUM_CTX) || 24576,
    timeoutMs: Number(env.OLLAMA_TIMEOUT_MS) || 90_000,
  };
}

const capabilityCache = new Map();

/** Does this model accept `think: false`? Cached per model per process. */
export async function modelSupportsThinking(
  model,
  { fetchImpl = fetch, baseUrl = ollamaBaseUrl() } = {},
) {
  if (!model) return false;
  if (capabilityCache.has(model)) return capabilityCache.get(model);
  const probe = (async () => {
    try {
      const response = await fetchImpl(`${baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await response.json().catch(() => ({}));
      if (Array.isArray(data?.capabilities))
        return data.capabilities.includes('thinking');
    } catch {
      /* fall through to the name heuristic */
    }
    return /^(qwen3|deepseek-r1|gpt-oss|magistral)/i.test(model);
  })();
  capabilityCache.set(model, probe);
  return probe;
}

export function resetModelCapabilityCache() {
  capabilityCache.clear();
}

/**
 * Stream one chat completion. Resolves with the assembled message, forwarding
 * content deltas to onToken as they arrive.
 */
export async function streamChat({
  model,
  messages,
  tools = [],
  signal,
  onToken,
  fetchImpl = fetch,
  baseUrl = ollamaBaseUrl(),
  env = process.env,
  options = {},
  think,
}) {
  const defaults = ollamaRequestDefaults(env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), defaults.timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  // think === 'omit' sends no flag: qwen3-vl keeps reasoning in
  // message.thinking only when the flag is absent.
  const thinkingCapable =
    think === 'omit'
      ? false
      : think === undefined
        ? await modelSupportsThinking(model, { fetchImpl, baseUrl })
        : Boolean(think !== false);
  const payload = {
    model,
    stream: true,
    keep_alive: defaults.keep_alive,
    options: {
      num_ctx: defaults.num_ctx,
      num_predict: 256,
      temperature: 0.2,
      ...options,
    },
    messages,
    ...(tools.length ? { tools } : {}),
    ...(thinkingCapable ? { think: false } : {}),
  };
  try {
    const response = await fetchImpl(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Ollama chat failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      );
    }
    let content = '';
    const toolCalls = [];
    let last = null;
    for await (const chunk of ndjson(response.body)) {
      last = chunk;
      if (chunk.error) throw new Error(chunk.error);
      const delta = chunk.message?.content;
      if (delta) {
        content += delta;
        onToken?.(delta);
      }
      if (Array.isArray(chunk.message?.tool_calls))
        toolCalls.push(...chunk.message.tool_calls);
    }
    return {
      content,
      toolCalls,
      doneReason: last?.done_reason || null,
      promptEvalCount: last?.prompt_eval_count ?? null,
      evalCount: last?.eval_count ?? null,
      totalDurationMs: last?.total_duration
        ? Math.round(last.total_duration / 1e6)
        : null,
    };
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted)
      throw new Error(
        `Local model timed out (${Math.round(defaults.timeoutMs / 1000)} s)`,
      );
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Parse a newline-delimited JSON body stream. */
export async function* ndjson(body) {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer +=
      typeof chunk === 'string'
        ? chunk
        : decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield JSON.parse(line);
    }
  }
  const tail = buffer.trim();
  if (tail) yield JSON.parse(tail);
}
