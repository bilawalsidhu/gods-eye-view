import { createTextChatHandler } from '../common/textChat.js';
import { invalidCalls } from '../common/textTools.js';
import { textInstructions } from '../common/textInstructions.js';
import { GEV_REALTIME_TOOLS, offeredTools } from '../openai/tools.js';
import { resolveOverpassUpstreams } from '../overpass/constants.js';

// The Bedrock chat route's provider throttle default
// (GEV_RATELIMIT_BEDROCK_PER_MIN); there is no voice route to share it.
export const BEDROCK_DEFAULT_PER_MIN = 30;

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) =>
  Object.keys(value).every((key) => allowed.includes(key));
// A Converse content block is a union: exactly one member is set.
const member = (value) => {
  if (!object(value)) return null;
  const names = Object.keys(value);
  return names.length === 1 ? names[0] : null;
};
const toolUseId = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,64}$/.test(value);
const toolName = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const bounded = (value, max) =>
  typeof value === 'string' && value.length <= max;

// Reasoning is opaque: it goes back exactly as received and is never shown.
function validReasoning(reasoning) {
  const kind = member(reasoning);
  if (kind === 'redactedContent')
    return bounded(reasoning.redactedContent, 64000);
  if (kind !== 'reasoningText') return false;
  const { reasoningText } = reasoning;
  return (
    object(reasoningText) &&
    keys(reasoningText, ['text', 'signature']) &&
    bounded(reasoningText.text, 64000) &&
    (reasoningText.signature === undefined ||
      bounded(reasoningText.signature, 16000))
  );
}

// Only text, tool exchanges and the model's own reasoning may cross this
// route, never media, documents, cache points or guard content.
function validBlock(block, role) {
  const kind = member(block);
  if (kind === 'text')
    return typeof block.text === 'string' && block.text.length > 0;
  if (kind === 'toolUse') {
    const use = block.toolUse;
    return (
      role === 'assistant' &&
      object(use) &&
      keys(use, ['toolUseId', 'name', 'input']) &&
      toolUseId(use.toolUseId) &&
      toolName(use.name) &&
      (use.input === null || object(use.input))
    );
  }
  if (kind === 'toolResult') {
    const result = block.toolResult;
    return (
      role === 'user' &&
      object(result) &&
      keys(result, ['toolUseId', 'content']) &&
      toolUseId(result.toolUseId) &&
      Array.isArray(result.content) &&
      result.content.length === 1 &&
      member(result.content[0]) === 'json' &&
      object(result.content[0].json)
    );
  }
  if (kind === 'reasoningContent')
    return role === 'assistant' && validReasoning(block.reasoningContent);
  return false;
}

// Roles alternate from the user. Each toolUse batch is answered by the next
// message alone, one toolResult per call in call order, and nothing is left
// pending. The history ends with the user.
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
    if (
      !Array.isArray(content) ||
      !content.length ||
      content.length > 32 ||
      !content.every((block) => validBlock(block, message.role))
    )
      return false;
    const results = content
      .filter((block) => block.toolResult)
      .map((block) => block.toolResult.toolUseId);
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
      .filter((block) => block.toolUse)
      .map((block) => block.toolUse.toolUseId);
    if (new Set(pending).size !== pending.length) return false;
  }
  return !pending.length && messages.at(-1).role === 'user';
}

// Claude binds each reasoning block to the exact system prompt, tools and
// messages before it, and the chat shortens or drops earlier turns. Only the
// current turn's reasoning is sent back; removing earlier blocks is allowed.
function replayable(messages) {
  const turn = messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      message.content.some((block) => 'text' in block),
  );
  return messages.map((message, index) => {
    if (index >= turn || message.role !== 'assistant') return message;
    const content = message.content.filter(
      (block) => !('reasoningContent' in block),
    );
    return content.length ? { ...message, content } : message;
  });
}

// A reply block is rebuilt from the members this route accepts back.
function replyBlock(block) {
  const kind = member(block);
  let value = null;
  if (kind === 'text') value = { text: block.text };
  else if (kind === 'toolUse' && object(block.toolUse))
    value = {
      toolUse: {
        toolUseId: block.toolUse.toolUseId,
        name: block.toolUse.name,
        input: block.toolUse.input,
      },
    };
  else if (kind === 'reasoningContent') {
    const reasoning = block.reasoningContent;
    const part = member(reasoning);
    if (part === 'reasoningText' && object(reasoning.reasoningText)) {
      const { text, signature } = reasoning.reasoningText;
      value = {
        reasoningContent: {
          reasoningText: {
            text,
            ...(signature === undefined ? {} : { signature }),
          },
        },
      };
    } else if (part === 'redactedContent')
      value = {
        reasoningContent: { redactedContent: reasoning.redactedContent },
      };
  }
  return value && validBlock(value, 'assistant') ? value : null;
}

/**
 * Typed chat through the Amazon Bedrock Converse API, one message format for
 * every model on Bedrock, with a Bedrock API key sent as a bearer token. A
 * long-term key works only in the Region it was created in. Bedrock has no
 * realtime voice API, so there is no voice.
 */
export function createBedrockChatHandler({
  annotationGuidance,
  tools = GEV_REALTIME_TOOLS,
  // osm_query is offered, and the prompt names it, only with Overpass, as
  // for voice.
  overpassConfigured = () => resolveOverpassUpstreams().length > 0,
  resolveChatModel = () =>
    process.env.BEDROCK_CHAT_MODEL || 'global.anthropic.claude-haiku-5-5',
  resolveRegion = () => process.env.BEDROCK_REGION || 'us-east-1',
  resolveApiKey = () => process.env.AWS_BEARER_TOKEN_BEDROCK,
  resolveProviderRateLimit = () => process.env.GEV_RATELIMIT_BEDROCK_PER_MIN,
  ...options
} = {}) {
  return createTextChatHandler({
    ...options,
    provider: 'bedrock',
    resolveApiKey,
    resolveProviderRateLimit,
    providerPerMin: BEDROCK_DEFAULT_PER_MIN,
    prepare(input) {
      // A model id may be an inference profile or an ARN.
      const model = String(resolveChatModel()).trim();
      const region = String(resolveRegion()).trim();
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,2047}$/.test(model) ||
        !/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(region)
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
        endpoint: `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`,
        headers: (key) => ({ Authorization: `Bearer ${key}` }),
        // No additionalModelRequestFields: they are model-specific, and the
        // route takes any Converse model.
        body: {
          system: [
            { text: textInstructions(annotationGuidance, { overpass }) },
          ],
          messages: replayable(input.messages),
          toolConfig: {
            tools: offeredTools(tools, { overpass }).map(
              ({ name, description, parameters }) => ({
                toolSpec: {
                  name,
                  description,
                  inputSchema: { json: parameters },
                },
              }),
            ),
          },
          inferenceConfig: { maxTokens: 4096 },
        },
      };
    },
    parse(data) {
      const message = data?.output?.message;
      if (
        message?.role !== 'assistant' ||
        !Array.isArray(message.content) ||
        !message.content.length ||
        message.content.length > 32
      )
        return null;
      // An empty text block is dropped: it cannot be sent back in history.
      const blocks = message.content
        .filter((block) => !(member(block) === 'text' && block.text === ''))
        .map(replyBlock);
      if (!blocks.length || blocks.includes(null)) return null;
      const calls = blocks
        .filter((block) => block.toolUse)
        .map((block) => ({
          name: block.toolUse.name,
          args: block.toolUse.input,
        }));
      return {
        content: { role: 'assistant', content: blocks },
        finishReason: data.stopReason,
        invalidCalls: invalidCalls(
          calls,
          offeredTools(tools, { overpass: overpassConfigured() }),
        ),
      };
    },
  });
}
