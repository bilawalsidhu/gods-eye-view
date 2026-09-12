/**
 * Multi-Provider AI Architecture for God's Eye View.
 *
 * Implements an extensible Strategy / Registry pattern for AI Providers
 * (OpenAI, Anthropic, Google Gemini, Ollama, etc.).
 *
 * To add a new provider:
 * 1. Subclass `BaseAiProvider` and implement `generateSummary` and `chat`.
 * 2. Register it with `aiRegistry.register(new MyProvider())`.
 *
 * @module server/providers/ai
 */

export const HUD_SUMMARY_INSTRUCTIONS = [
  "Write one concise intelligence-HUD summary for God's Eye View.",
  'Use only the supplied place, street, nearby-place, and enabled-layer text labels.',
  'Prefer the clearest named place and include a relevant enabled layer only when useful.',
  'Do not infer from coordinates or invent a place.',
  'Output exactly five words with no title, punctuation, markdown, or introductory phrase.',
].join(' ');

export const VOICE_CHAT_INSTRUCTIONS = [
  "You are GEV Voice Control, a concise voice controller for a Cesium geospatial app called God's Eye View.",
  'Have a natural spoken conversation with the user and control the app by calling the provided tools.',
  'Keep spoken confirmations short (e.g. "Flying to London", "Opening datacenters").',
].join(' ');

/** Helper to clean and enforce exactly 5-word summaries without punctuation. */
export function toFiveWordHudSummary(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

/** Helper to extract output text from OpenAI responses. */
export function extractOpenAiResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => part?.text || part?.output_text || '')
    .join(' ')
    .trim();
}

/**
 * Base Abstract Provider
 */
export class BaseAiProvider {
  /**
   * @param {object} options
   * @param {string} options.id - Unique lowercase identifier (e.g. 'openai')
   * @param {string} options.name - Human-readable name
   * @param {string} options.envKeyName - Name of the environment variable holding the API key/url
   * @param {string} [options.defaultModel] - Default model identifier
   */
  constructor({ id, name, envKeyName, defaultModel = '' }) {
    this.id = id;
    this.name = name;
    this.envKeyName = envKeyName;
    this.defaultModel = defaultModel;
  }

  getApiKey(env = process.env) {
    return env[this.envKeyName];
  }

  isConfigured(env = process.env) {
    return Boolean(String(this.getApiKey(env) ?? '').trim());
  }

  async generateSummary(context, env = process.env) {
    throw new Error(`generateSummary not implemented for ${this.name}`);
  }

  async chat({ message, context, tools = [] }, env = process.env) {
    throw new Error(`chat not implemented for ${this.name}`);
  }
}

/**
 * OpenAI Provider Adapter
 */
export class OpenAiProvider extends BaseAiProvider {
  constructor() {
    super({
      id: 'openai',
      name: 'OpenAI',
      envKeyName: 'OPENAI_API_KEY',
      defaultModel: 'gpt-4o-mini',
    });
  }

  async generateSummary(context, env = process.env) {
    const apiKey = this.getApiKey(env);
    if (!apiKey) throw new Error(`${this.envKeyName} is not set`);
    const model = env.OPENAI_HUD_SUMMARY_MODEL || 'gpt-5-nano';
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        instructions: HUD_SUMMARY_INSTRUCTIONS,
        input: JSON.stringify(context),
        reasoning: { effort: 'minimal' },
        max_output_tokens: 100,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        data.error?.message || `OpenAI HUD summary failed (${response.status})`,
      );
    return toFiveWordHudSummary(extractOpenAiResponseText(data));
  }

  async chat({ message, context, tools = [] }, env = process.env) {
    const apiKey = this.getApiKey(env);
    if (!apiKey) throw new Error(`${this.envKeyName} is not set`);
    const model = env.OPENAI_CHAT_MODEL || this.defaultModel;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: VOICE_CHAT_INSTRUCTIONS },
          {
            role: 'user',
            content: context
              ? `Context: ${JSON.stringify(context)}\n\nUser: ${message}`
              : message,
          },
        ],
        tools: tools.length ? tools : undefined,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        data.error?.message || `OpenAI chat failed (${response.status})`,
      );
    const toolCalls = (data.choices?.[0]?.message?.tool_calls || []).map(
      (t) => ({
        name: t.function?.name,
        args:
          typeof t.function?.arguments === 'string'
            ? JSON.parse(t.function.arguments || '{}')
            : t.function?.arguments || {},
      }),
    );
    const text = data.choices?.[0]?.message?.content || '';
    return { text, toolCalls };
  }
}

/**
 * Anthropic Provider Adapter
 */
export class AnthropicProvider extends BaseAiProvider {
  constructor() {
    super({
      id: 'anthropic',
      name: 'Anthropic',
      envKeyName: 'ANTHROPIC_API_KEY',
      defaultModel: 'claude-3-5-haiku-20241022',
    });
  }

  async generateSummary(context, env = process.env) {
    const apiKey = this.getApiKey(env);
    if (!apiKey) throw new Error(`${this.envKeyName} is not set`);
    const model = env.ANTHROPIC_MODEL || this.defaultModel;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 60,
        system: HUD_SUMMARY_INSTRUCTIONS,
        messages: [{ role: 'user', content: JSON.stringify(context) }],
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        data.error?.message ||
          `Anthropic HUD summary failed (${response.status})`,
      );
    const text = (data.content || [])
      .map((c) => c.text || '')
      .join(' ')
      .trim();
    return toFiveWordHudSummary(text);
  }

  async chat({ message, context, tools = [] }, env = process.env) {
    const apiKey = this.getApiKey(env);
    if (!apiKey) throw new Error(`${this.envKeyName} is not set`);
    const model = env.ANTHROPIC_MODEL || this.defaultModel;
    const anthropicTools = (tools || []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 500,
        system: VOICE_CHAT_INSTRUCTIONS,
        messages: [
          {
            role: 'user',
            content: context
              ? `Context: ${JSON.stringify(context)}\n\nUser: ${message}`
              : message,
          },
        ],
        tools: anthropicTools.length ? anthropicTools : undefined,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        data.error?.message || `Anthropic chat failed (${response.status})`,
      );
    const toolCalls = (data.content || [])
      .filter((c) => c.type === 'tool_use')
      .map((c) => ({ name: c.name, args: c.input }));
    const text = (data.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join(' ')
      .trim();
    return { text, toolCalls };
  }
}

/**
 * Google Gemini Provider Adapter
 */
export class GeminiProvider extends BaseAiProvider {
  constructor() {
    super({
      id: 'gemini',
      name: 'Google Gemini',
      envKeyName: 'GEMINI_API_KEY',
      defaultModel: 'gemini-2.0-flash',
    });
  }

  async generateSummary(context, env = process.env) {
    const apiKey = this.getApiKey(env);
    if (!apiKey) throw new Error(`${this.envKeyName} is not set`);
    const model = env.GEMINI_MODEL || this.defaultModel;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: HUD_SUMMARY_INSTRUCTIONS }] },
          contents: [
            { role: 'user', parts: [{ text: JSON.stringify(context) }] },
          ],
          generationConfig: { maxOutputTokens: 60 },
        }),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        data.error?.message || `Gemini HUD summary failed (${response.status})`,
      );
    const text = (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join(' ')
      .trim();
    return toFiveWordHudSummary(text);
  }

  async chat({ message, context, tools = [] }, env = process.env) {
    const apiKey = this.getApiKey(env);
    if (!apiKey) throw new Error(`${this.envKeyName} is not set`);
    const model = env.GEMINI_MODEL || this.defaultModel;
    const functionDeclarations = (tools || []).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    const bodyObj = {
      system_instruction: { parts: [{ text: VOICE_CHAT_INSTRUCTIONS }] },
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: context
                ? `Context: ${JSON.stringify(context)}\n\nUser: ${message}`
                : message,
            },
          ],
        },
      ],
    };
    if (functionDeclarations.length) {
      bodyObj.tools = [{ function_declarations: functionDeclarations }];
    }
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        data.error?.message || `Gemini chat failed (${response.status})`,
      );
    const parts = data.candidates?.[0]?.content?.parts || [];
    const toolCalls = parts
      .filter((p) => p.functionCall)
      .map((p) => ({
        name: p.functionCall.name,
        args: p.functionCall.args || {},
      }));
    const text = parts
      .filter((p) => p.text)
      .map((p) => p.text)
      .join(' ')
      .trim();
    return { text, toolCalls };
  }
}

/**
 * Ollama (Local) Provider Adapter
 */
export class OllamaProvider extends BaseAiProvider {
  constructor() {
    super({
      id: 'ollama',
      name: 'Ollama',
      envKeyName: 'OLLAMA_BASE_URL',
      defaultModel: 'llama3.2',
    });
  }

  getApiKey(env = process.env) {
    return env.OLLAMA_BASE_URL || 'http://localhost:11434';
  }

  async generateSummary(context, env = process.env) {
    const baseUrl = this.getApiKey(env);
    const model = env.OLLAMA_MODEL || this.defaultModel;
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: HUD_SUMMARY_INSTRUCTIONS },
          { role: 'user', content: JSON.stringify(context) },
        ],
        stream: false,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        data.error || `Ollama HUD summary failed (${response.status})`,
      );
    return toFiveWordHudSummary(data.message?.content || '');
  }

  async chat({ message, context, tools = [] }, env = process.env) {
    const baseUrl = this.getApiKey(env);
    const model = env.OLLAMA_MODEL || this.defaultModel;
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: VOICE_CHAT_INSTRUCTIONS },
          {
            role: 'user',
            content: context
              ? `Context: ${JSON.stringify(context)}\n\nUser: ${message}`
              : message,
          },
        ],
        tools: tools.length ? tools : undefined,
        stream: false,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(data.error || `Ollama chat failed (${response.status})`);
    const toolCalls = (data.message?.tool_calls || []).map((t) => ({
      name: t.function?.name,
      args:
        typeof t.function?.arguments === 'string'
          ? JSON.parse(t.function.arguments || '{}')
          : t.function?.arguments || {},
    }));
    const text = data.message?.content || '';
    return { text, toolCalls };
  }
}

/**
 * Provider Registry
 */
export class AiProviderRegistry {
  constructor() {
    this.providers = new Map();
  }

  register(provider) {
    this.providers.set(provider.id.toLowerCase(), provider);
    return this;
  }

  get(id = 'openai') {
    const key = String(id || 'openai')
      .toLowerCase()
      .trim();
    return this.providers.get(key) || this.providers.get('openai') || null;
  }

  list() {
    return Array.from(this.providers.values());
  }
}

/** Global default registry instance */
export const aiRegistry = new AiProviderRegistry()
  .register(new OpenAiProvider())
  .register(new AnthropicProvider())
  .register(new GeminiProvider())
  .register(new OllamaProvider());

/** Resolves the active key for the selected AI Provider */
export function activeAiKey(env = process.env) {
  const provider = aiRegistry.get(env.AI_PROVIDER);
  return provider ? provider.getApiKey(env) : env.OPENAI_API_KEY;
}

/** Dispatches HUD summary generation to the active AI Provider */
export async function generateMultiProviderHudSummary(
  context,
  env = process.env,
) {
  const provider = aiRegistry.get(env.AI_PROVIDER);
  if (!provider) throw new Error(`Unknown AI provider: ${env.AI_PROVIDER}`);
  return provider.generateSummary(context, env);
}

/** Dispatches Chat / Tool-calling to the active AI Provider */
export async function generateMultiProviderChat(payload, env = process.env) {
  const provider = aiRegistry.get(env.AI_PROVIDER);
  if (!provider) throw new Error(`Unknown AI provider: ${env.AI_PROVIDER}`);
  return provider.chat(payload, env);
}
