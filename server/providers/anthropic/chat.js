import { createTextChatHandler } from '../common/textChat.js';
import { invalidCalls } from '../common/textTools.js';
import { textInstructions } from '../common/textInstructions.js';
import { GEV_REALTIME_TOOLS, offeredTools } from '../openai/tools.js';
import { resolveOverpassUpstreams } from '../overpass/constants.js';

// The Anthropic chat route's provider throttle default
// (GEV_RATELIMIT_ANTHROPIC_PER_MIN); there is no voice route to share it.
export const ANTHROPIC_DEFAULT_PER_MIN = 30;

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) =>
  Object.keys(value).every((key) => allowed.includes(key));
const id = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024;

// Only text and tool exchanges may cross this route, never media or documents.
function validBlock(block, role) {
  if (!object(block)) return false;
  if (block.type === 'text')
    return (
      keys(block, ['type', 'text']) &&
      typeof block.text === 'string' &&
      block.text.length > 0
    );
  if (block.type === 'tool_use')
    return (
      role === 'assistant' &&
      keys(block, ['type', 'id', 'name', 'input']) &&
      id(block.id) &&
      typeof block.name === 'string' &&
      block.name.length <= 128 &&
      (block.input === null || object(block.input))
    );
  if (block.type === 'tool_result')
    return (
      role === 'user' &&
      keys(block, ['type', 'tool_use_id', 'content']) &&
      id(block.tool_use_id) &&
      typeof block.content === 'string'
    );
  return false;
}

// Roles alternate from the user. Each tool_use batch is answered by the next
// message alone, one tool_result per call in call order, and nothing is left
// pending. The history ends with the user, as the API takes no prefill.
function validMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 96)
    return false;
  let pending = [];
  for (const [index, message] of messages.entries()) {
    if (
      !object(message) ||
      !keys(message, ['role', 'content']) ||
      message.role !== (index % 2 ? 'assistant' : 'user')
    )
      return false;
    const { content } = message;
    if (message.role === 'user' && typeof content === 'string') {
      if (!content || pending.length) return false;
      continue;
    }
    if (
      !Array.isArray(content) ||
      !content.length ||
      content.length > 32 ||
      !content.every((block) => validBlock(block, message.role))
    )
      return false;
    const results = content
      .filter((block) => block.type === 'tool_result')
      .map((block) => block.tool_use_id);
    if (pending.length) {
      if (
        results.length !== content.length ||
        results.length !== pending.length ||
        results.some((result, i) => result !== pending[i])
      )
        return false;
      pending = [];
    } else if (results.length) return false;
    pending = content
      .filter((block) => block.type === 'tool_use')
      .map((block) => block.id);
    if (new Set(pending).size !== pending.length) return false;
  }
  return !pending.length && messages.at(-1).role === 'user';
}

// A reply may carry optional fields (citations, caller); history keeps only
// the ones this route accepts back.
function replyBlock(block) {
  if (!object(block)) return null;
  const value =
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : block.type === 'tool_use'
        ? {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          }
        : null;
  return value && validBlock(value, 'assistant') ? value : null;
}

export function createAnthropicChatHandler({
  annotationGuidance,
  tools = GEV_REALTIME_TOOLS,
  // osm_query is offered, and the prompt names it, only with Overpass, as
  // for voice.
  overpassConfigured = () => resolveOverpassUpstreams().length > 0,
  resolveChatModel = () =>
    process.env.ANTHROPIC_CHAT_MODEL || 'claude-haiku-5-5',
  resolveApiKey = () => process.env.ANTHROPIC_API_KEY,
  resolveProviderRateLimit = () => process.env.GEV_RATELIMIT_ANTHROPIC_PER_MIN,
  ...options
} = {}) {
  return createTextChatHandler({
    ...options,
    provider: 'anthropic',
    resolveApiKey,
    resolveProviderRateLimit,
    providerPerMin: ANTHROPIC_DEFAULT_PER_MIN,
    prepare(input) {
      const model = String(resolveChatModel()).trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(model))
        return { errorStatus: 503 };
      if (
        !object(input) ||
        !keys(input, ['messages']) ||
        !validMessages(input.messages)
      )
        return null;
      const overpass = overpassConfigured();
      return {
        endpoint: 'https://api.anthropic.com/v1/messages',
        headers: (key) => ({
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        }),
        body: {
          model,
          max_tokens: 4096,
          // Claude Haiku 5.5 thinks by default; chat history carries only
          // text and tool blocks.
          thinking: { type: 'disabled' },
          system: textInstructions(annotationGuidance, { overpass }),
          messages: input.messages,
          tools: offeredTools(tools, { overpass }).map(
            ({ name, description, parameters }) => ({
              name,
              description,
              input_schema: parameters,
            }),
          ),
        },
      };
    },
    parse(data) {
      if (
        data?.role !== 'assistant' ||
        !Array.isArray(data.content) ||
        !data.content.length ||
        data.content.length > 32
      )
        return null;
      // An empty text block is dropped: the API refuses it in history.
      const blocks = data.content
        .filter((block) => !(block?.type === 'text' && block.text === ''))
        .map(replyBlock);
      if (!blocks.length || blocks.includes(null)) return null;
      const calls = blocks
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({ name: block.name, args: block.input }));
      return {
        content: { role: 'assistant', content: blocks },
        finishReason: data.stop_reason,
        invalidCalls: invalidCalls(
          calls,
          offeredTools(tools, { overpass: overpassConfigured() }),
        ),
      };
    },
  });
}
