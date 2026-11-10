import { createTextChatHandler } from '../common/textChat.js';
import { preferCodexOAuth } from './codex-auth.js';
import { OPENAI_DEFAULT_PER_MIN } from './rate-limit.js';
import { invalidCalls } from '../common/textTools.js';
import { textInstructions } from '../common/textInstructions.js';
import { GEV_REALTIME_TOOLS, offeredTools } from './tools.js';
import { resolveOverpassUpstreams } from '../overpass/constants.js';

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) =>
  Object.keys(value).every((key) => allowed.includes(key));
const callShape = (call) =>
  object(call) &&
  keys(call, ['id', 'type', 'function']) &&
  typeof call.id === 'string' &&
  call.id.length > 0 &&
  call.id.length <= 1024 &&
  call.type === 'function' &&
  object(call.function) &&
  keys(call.function, ['name', 'arguments']) &&
  typeof call.function.name === 'string' &&
  call.function.name.length <= 128 &&
  typeof call.function.arguments === 'string';
function assistantShape(message) {
  return (
    object(message) &&
    keys(message, ['role', 'content', 'tool_calls']) &&
    message.role === 'assistant' &&
    (message.content == null || typeof message.content === 'string') &&
    (message.tool_calls === undefined ||
      (Array.isArray(message.tool_calls) &&
        message.tool_calls.length > 0 &&
        message.tool_calls.length <= 32 &&
        message.tool_calls.every(callShape) &&
        new Set(message.tool_calls.map((call) => call.id)).size ===
          message.tool_calls.length))
  );
}
function validMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 96)
    return false;
  let pending = [];
  for (const message of messages) {
    if (!object(message)) return false;
    if (pending.length) {
      if (
        !keys(message, ['role', 'content', 'tool_call_id']) ||
        message.role !== 'tool' ||
        typeof message.content !== 'string' ||
        message.tool_call_id !== pending.shift()
      )
        return false;
    } else if (message.role === 'user') {
      if (
        !keys(message, ['role', 'content']) ||
        typeof message.content !== 'string'
      )
        return false;
    } else if (assistantShape(message)) {
      pending = (message.tool_calls || []).map((call) => call.id);
    } else return false;
  }
  return !pending.length;
}

/**
 * A tool schema without the `pattern`s Chat Completions refuses: it answers
 * 400 for a whole request whose tool uses Unicode property classes (`\p{L}`),
 * as `resolve_area`'s area ids do. Every argument is still checked against
 * the action's own contract before the tool runs, so the model loses a hint,
 * not a rule. Realtime voice refuses them too now (#1618) and uses this as well.
 */
export function chatSchema(schema) {
  if (Array.isArray(schema)) return schema.map(chatSchema);
  if (!object(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(
        ([key, value]) =>
          !(
            key === 'pattern' &&
            typeof value === 'string' &&
            /\\[pP]\{/.test(value)
          ),
      )
      .map(([key, value]) => [key, chatSchema(value)]),
  );
}

export function createOpenAiChatHandler({
  annotationGuidance,
  tools = GEV_REALTIME_TOOLS,
  // osm_query is offered, and the prompt names it, only with Overpass, as
  // for voice.
  overpassConfigured = () => resolveOverpassUpstreams().length > 0,
  resolveApiKey = () => process.env.OPENAI_API_KEY,
  resolveChatModel = () => process.env.OPENAI_CHAT_MODEL || 'gpt-4.1-mini',
  resolveProviderRateLimit = () => process.env.GEV_RATELIMIT_OPENAI_PER_MIN,
  environment = process.env,
  ...options
} = {}) {
  return createTextChatHandler({
    ...options,
    provider: 'openai',
    resolveApiKey,
    resolveProviderRateLimit,
    providerPerMin: OPENAI_DEFAULT_PER_MIN,
    // Chat can only bill the API key, which this operator lock forbids.
    refuse() {
      let error =
        'ChatGPT OAuth is required by GEV_PREFER_CODEX_OAUTH, and typed OpenAI chat needs an API key.';
      try {
        if (!preferCodexOAuth(environment)) return null;
      } catch (invalid) {
        error = invalid.message;
      }
      return { error, code: 'CODEX_OAUTH_REQUIRED' };
    },
    prepare(input) {
      const model = String(resolveChatModel()).trim();
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(model) ||
        /realtime|audio|tts/i.test(model)
      )
        return { errorStatus: 503 };
      if (
        !object(input) ||
        !keys(input, ['messages']) ||
        !validMessages(input.messages)
      )
        return null;
      const overpass = overpassConfigured();
      return {
        endpoint: 'https://api.openai.com/v1/chat/completions',
        headers: (key) => ({ Authorization: `Bearer ${key}` }),
        body: {
          model,
          n: 1,
          stream: false,
          store: false,
          max_completion_tokens: 4096,
          messages: [
            {
              role: 'system',
              content: textInstructions(annotationGuidance, { overpass }),
            },
            ...input.messages,
          ],
          tools: offeredTools(tools, { overpass }).map(
            ({ name, description, parameters }) => ({
              type: 'function',
              function: {
                name,
                description,
                parameters: chatSchema(parameters),
                strict: false,
              },
            }),
          ),
        },
      };
    },
    parse(data) {
      const choice = data?.choices?.[0];
      const raw = choice?.message;
      if (!raw) return null;
      const content = {
        role: raw.role,
        content: raw.content ?? null,
        ...(raw.tool_calls?.length ? { tool_calls: raw.tool_calls } : {}),
      };
      if (
        !assistantShape(content) ||
        (!content.content && !content.tool_calls?.length)
      )
        return null;
      const calls = (content.tool_calls || []).map((call) => {
        try {
          return {
            name: call.function.name,
            args: JSON.parse(call.function.arguments),
          };
        } catch {
          return { name: call.function.name, parseError: true };
        }
      });
      return {
        content,
        finishReason: choice.finish_reason,
        invalidCalls: invalidCalls(
          calls,
          offeredTools(tools, { overpass: overpassConfigured() }),
        ),
      };
    },
  });
}
