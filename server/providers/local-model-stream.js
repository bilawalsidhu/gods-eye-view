import { cancelResponseBodyBounded } from './common/http.js';

/** Read OpenAI-compatible SSE without buffering text until completion. */
export async function readLocalModelStream(
  response,
  { signal, onDelta, model, maxBytes },
) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes || signal.aborted) {
    await cancelResponseBodyBounded(response);
    signal.throwIfAborted();
    throw new Error('Oversized stream');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing stream');
  let cancellation;
  const cancel = () => {
    cancellation ??= cancelResponseBodyBounded({ body: reader });
    void cancellation.catch(() => {});
    return cancellation;
  };
  let rejectAbort;
  const aborted = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    rejectAbort(signal.reason);
    void cancel();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let buffer = '';
  let dataLines = [];
  let content = '';
  let finishReason = null;
  let done = false;
  const calls = new Map();

  const event = async () => {
    if (!dataLines.length) return;
    const raw = dataLines.join('\n');
    dataLines = [];
    if (raw === '[DONE]') {
      if (!finishReason) throw new Error('Missing finish reason');
      done = true;
      return;
    }
    const data = JSON.parse(raw);
    if (!data || data.error) throw new Error('Model stream failed');
    if (typeof data.model === 'string' && data.model.length <= 200)
      model = data.model;
    if (!Array.isArray(data.choices)) throw new Error('Invalid stream choice');
    if (!data.choices.length) return; // Accounting-only frame.
    if (data.choices.length !== 1) throw new Error('Unexpected choices');
    const choice = data.choices[0];
    if (choice.index !== undefined && choice.index !== 0)
      throw new Error('Unexpected choice');
    const delta = choice.delta;
    if (!delta || typeof delta !== 'object') throw new Error('Invalid delta');
    if (delta.content != null && typeof delta.content !== 'string')
      throw new Error('Invalid content');
    if (finishReason && (delta.content || delta.tool_calls?.length))
      throw new Error('Data after finish');
    if (delta.content) {
      content += delta.content;
      await onDelta({ content: delta.content, model }, signal);
    }
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 4)
        throw new Error('Invalid tool deltas');
      for (const part of delta.tool_calls) {
        if (!Number.isInteger(part.index) || part.index < 0 || part.index >= 4)
          throw new Error('Invalid tool index');
        const call = calls.get(part.index) || {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        if (part.type != null && part.type !== 'function')
          throw new Error('Invalid tool type');
        for (const [target, key, value, cap] of [
          [call, 'id', part.id, 200],
          [call.function, 'name', part.function?.name, 200],
          [call.function, 'arguments', part.function?.arguments, 16384],
        ]) {
          if (value == null) continue;
          if (
            typeof value !== 'string' ||
            target[key].length + value.length > cap
          )
            throw new Error('Invalid tool fragment');
          target[key] += value;
        }
        calls.set(part.index, call);
      }
    }
    if (choice.finish_reason != null) {
      if (
        !['stop', 'tool_calls'].includes(choice.finish_reason) ||
        (finishReason && finishReason !== choice.finish_reason)
      )
        throw new Error('Incomplete response');
      finishReason = choice.finish_reason;
    }
  };
  const consume = async (final = false) => {
    while (buffer.length) {
      const match = /[\r\n]/.exec(buffer);
      if (!match) break;
      const index = match.index;
      if (!final && buffer[index] === '\r' && index === buffer.length - 1)
        break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(
        index + (buffer.slice(index, index + 2) === '\r\n' ? 2 : 1),
      );
      if (!line) await event();
      else if (line === 'data' || line.startsWith('data:'))
        dataLines.push(line.slice(5).replace(/^ /, ''));
      if (done) return;
    }
  };
  try {
    while (!done) {
      signal.throwIfAborted();
      const chunk = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (chunk.done) {
        buffer += decoder.decode();
        await consume(true);
        if (!done) throw new Error('Truncated stream');
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error('Oversized stream');
      buffer += decoder.decode(chunk.value, { stream: true });
      await consume();
    }
    if (calls.size > 0 !== (finishReason === 'tool_calls'))
      throw new Error('Inconsistent tool finish');
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b);
    if (toolCalls.some(([index], i) => index !== i))
      throw new Error('Missing tool index');
    return {
      model,
      choices: [
        {
          finish_reason: finishReason,
          message: { content, tool_calls: toolCalls.map(([, call]) => call) },
        },
      ],
    };
  } finally {
    signal.removeEventListener('abort', onAbort);
    try {
      await cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
