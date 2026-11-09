import { createGeminiChatHandler } from '../gemini/chat.js';
import { toVertexSchema } from './schema.js';

// The Vertex AI chat route's provider throttle default
// (GEV_RATELIMIT_VERTEX_PER_MIN); there is no voice route to share it.
export const VERTEX_DEFAULT_PER_MIN = 30;

/**
 * Typed chat through Vertex AI in Express Mode: Gemini's generateContent on
 * the global host, with a plain API key and no project or location. Express
 * Mode offers no Live models, so there is no voice.
 */
export function createVertexChatHandler({
  resolveChatModel = () =>
    process.env.VERTEX_CHAT_MODEL || 'gemini-3-flash-preview',
  resolveApiKey = () => process.env.VERTEX_API_KEY,
  resolveProviderRateLimit = () => process.env.GEV_RATELIMIT_VERTEX_PER_MIN,
  ...options
} = {}) {
  return createGeminiChatHandler({
    ...options,
    provider: 'vertex',
    providerPerMin: VERTEX_DEFAULT_PER_MIN,
    endpoint: (model) =>
      `https://aiplatform.googleapis.com/v1beta1/publishers/google/models/${model}:generateContent`,
    // A tool without arguments declares no parameters, which are optional,
    // rather than risk the refusal Google's Schema has given an OBJECT with
    // empty properties.
    declareTool: ({ name, description, parameters }) => ({
      name,
      description,
      ...(Object.keys(parameters?.properties ?? {}).length
        ? { parameters: toVertexSchema(parameters) }
        : {}),
    }),
    // Gemini 2.5 and earlier refuse thinkingLevel; they keep their default.
    thinkingConfig: (model) =>
      /^gemini-[12]\./.test(model) ? null : { thinkingLevel: 'LOW' },
    resolveChatModel,
    resolveApiKey,
    resolveProviderRateLimit,
  });
}
