import { normalizeResponseReasoning } from '../../../../src/agent/responseReasoning.js';
import { readResponseTextCapped } from '../../common/http.js';
import { ChatGptError, RESOURCE, chatGptJson, planError } from './http.js';

const MAX_STREAM_BYTES = 8 * 1024 * 1024;

/** Convert the existing, server-owned manual/tool contract to Responses. */
export function responsesBody({ model, messages, tools }) {
  const input = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: message.content,
      });
      continue;
    }
    if (message.role === 'assistant')
      input.push(...normalizeResponseReasoning(message.response_reasoning));
    if (message.content)
      input.push({ role: message.role, content: message.content });
    for (const call of message.tool_calls || [])
      input.push({
        type: 'function_call',
        call_id: call.id,
        namespace: 'gev',
        name: call.function.name,
        arguments: call.function.arguments,
      });
  }
  return {
    model,
    store: false,
    stream: true,
    instructions: messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n'),
    input,
    include: ['reasoning.encrypted_content'],
    tools: [
      {
        type: 'namespace',
        name: 'gev',
        description: "God's Eye View map and data actions.",
        tools: tools.map(({ function: definition }) => ({
          type: 'function',
          ...definition,
          strict: false,
        })),
      },
    ],
  };
}

/** Read SSE through its terminal event; partial tool arguments never execute. */
export async function readCompletedResponse(
  response,
  signal,
  maxBytes = MAX_STREAM_BYTES,
) {
  if (
    !response.body ||
    !response.headers.get('content-type')?.includes('text/event-stream')
  )
    throw new ChatGptError('ChatGPT returned no event stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let bytes = 0;
  const reasoning = new Map();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done)
        throw new ChatGptError(
          'ChatGPT stream ended before completion. Retry the command.',
        );
      bytes += value.byteLength;
      if (bytes > maxBytes)
        throw new ChatGptError('ChatGPT response exceeded the size limit.');
      buffered += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffered))) {
        const frame = buffered.slice(0, boundary.index);
        buffered = buffered.slice(boundary.index + boundary[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data);
        if (
          event.type === 'response.output_item.done' &&
          event.item?.type === 'reasoning'
        )
          reasoning.set(event.item.id, event.item);
        if (event.type === 'response.failed' || event.type === 'error')
          throw planError(event.response?.error?.code || event.code);
        if (event.type === 'response.incomplete')
          throw new ChatGptError(
            'ChatGPT response was incomplete. No tools were executed for this response.',
          );
        if (event.type === 'response.completed') {
          if (
            event.response?.status !== 'completed' ||
            !Array.isArray(event.response.output)
          )
            throw planError();
          return {
            ...event.response,
            output: event.response.output.map(
              (item) => reasoning.get(item.id) || item,
            ),
          };
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Adapt only final GEV function calls to the shared validator and browser loop. */
export function normalizeResponse(data, model) {
  const calls = [];
  const seen = new Set();
  let text = '';
  for (const item of data.output) {
    if (item.type === 'function_call') {
      if (
        item.namespace !== 'gev' ||
        typeof item.call_id !== 'string' ||
        !item.call_id ||
        seen.has(item.call_id) ||
        typeof item.name !== 'string' ||
        typeof item.arguments !== 'string' ||
        (item.status && item.status !== 'completed')
      )
        throw new ChatGptError('ChatGPT returned an invalid GEV tool call.');
      seen.add(item.call_id);
      calls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      });
    } else if (item.type === 'message') {
      if (item.role !== 'assistant') throw planError();
      for (const part of item.content || []) {
        if (part.type === 'output_text') text += part.text;
        if (part.type === 'refusal') text += part.refusal;
      }
    } else if (item.type !== 'reasoning') {
      // No hosted tools or unsupported execution modes are part of this channel.
      throw new ChatGptError('ChatGPT returned an unsupported output item.');
    }
  }
  const rawReasoning = data.output.filter((item) => item.type === 'reasoning');
  const responseReasoning = normalizeResponseReasoning(rawReasoning);
  if (rawReasoning.length !== responseReasoning.length)
    throw new ChatGptError(
      'ChatGPT reasoning state is missing or too large to continue safely.',
    );
  if (!text && !calls.length)
    throw new ChatGptError('ChatGPT returned no message or tool calls.');
  const message = { role: 'assistant', content: text };
  if (calls.length) message.tool_calls = calls;
  if (responseReasoning.length) message.response_reasoning = responseReasoning;
  return {
    ok: true,
    message,
    model: data.model || model,
    finishReason: calls.length ? 'tool_calls' : 'stop',
    usage: data.usage
      ? {
          prompt_tokens: data.usage.input_tokens,
          completion_tokens: data.usage.output_tokens,
          total_tokens: data.usage.total_tokens,
        }
      : null,
  };
}

/** Account-specific catalog: preserve server order and never invent API pricing. */
export async function fetchChatGptModels({
  auth,
  binding,
  fetchImpl = fetch,
  signal,
}) {
  const lease = await auth.lease(binding);
  const data = await chatGptJson(`${RESOURCE}/models`, {
    fetchImpl,
    headers: { Authorization: `Bearer ${lease.token}` },
    signal: signal ? AbortSignal.any([signal, lease.signal]) : lease.signal,
  });
  auth.assertBinding(binding);
  if (!Array.isArray(data?.models))
    throw new ChatGptError('ChatGPT returned an invalid model catalog.');
  return {
    ok: true,
    models: data.models
      .filter((m) => m.visibility === 'list' && typeof m.slug === 'string')
      .map((m) => ({
        id: m.slug,
        label: m.display_name || m.slug,
        provider: 'chatgpt',
        contextLength: 0,
        supportsTools: true,
        supportsVision: false,
        pricing: null,
      })),
    binding,
  };
}

export async function requestChatGptCompletion({
  auth,
  binding,
  model,
  messages,
  tools,
  fetchImpl = fetch,
  signal,
  timeoutMs = 120_000,
}) {
  try {
    const lease = await auth.lease(binding);
    const combined = AbortSignal.any([
      lease.signal,
      AbortSignal.timeout(timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    const response = await fetchImpl(`${RESOURCE}/responses`, {
      method: 'POST',
      redirect: 'error',
      signal: combined,
      headers: {
        Authorization: `Bearer ${lease.token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(responsesBody({ model, messages, tools })),
    });
    if (!response.ok) {
      const body = await readResponseTextCapped(response, 64 * 1024, combined);
      let code;
      try {
        code = JSON.parse(body)?.error?.code;
      } catch {
        /* Never relay raw upstream bodies. */
      }
      throw planError(code, response.status);
    }
    const completed = await readCompletedResponse(response, combined);
    combined.throwIfAborted();
    auth.assertBinding(binding);
    return normalizeResponse(completed, model);
  } catch (error) {
    return {
      ok: false,
      status: error instanceof ChatGptError ? error.status : 502,
      error:
        error instanceof ChatGptError
          ? error.message
          : 'ChatGPT request interrupted or timed out. No tools were executed for this response.',
    };
  }
}
