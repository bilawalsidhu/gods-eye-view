/**
 * Free LLM API Catalog from awesome-free-llm-apis.
 * Curated list of OpenAI-compatible permanent free-tier LLM inference providers.
 * Includes all 13 providers (1st-party + 3rd-party inference engines).
 */

export const FREE_LLM_PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'nvidia',
    name: 'NVIDIA NIM',
    icon: '⚡',
    badge: '1,000 FREE REQS',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    keyUrl: 'https://build.nvidia.com',
    keyPlaceholder: 'paste NVIDIA NIM Key (nvapi-...)',
    keyPrefix: 'nvapi-',
    models: Object.freeze([
      { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', label: 'Nemotron 3.5 (Fast Tactical)' },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b', label: 'Nemotron 550B (Deep Reasoning)' },
      { id: 'deepseek-ai/deepseek-r1', label: 'DeepSeek R1 (Thinking Trace)' },
      { id: 'meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
      { id: 'meta/llama-3.2-11b-vision-instruct', label: 'Llama 3.2 Vision (11B)' },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B (Code & Logic)' },
      { id: 'mistralai/mistral-nemotron', label: 'Mistral-Nemotron (Multilingual)' },
      { id: 'moonshotai/kimi-k3', label: 'Kimi K3 (200K Long Context)' },
    ]),
    description: '1,000 free requests. Top-tier frontier open weights hosted on NVIDIA DGX Cloud.',
  }),
  Object.freeze({
    id: 'groq',
    name: 'Groq Cloud',
    icon: '🚀',
    badge: '500+ TOKENS/SEC',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    keyPlaceholder: 'paste Groq API Key (gsk_...)',
    keyPrefix: 'gsk_',
    models: Object.freeze([
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Versatile)' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (Instant)' },
      { id: 'deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 Distill 70B' },
      { id: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B (32K)' },
      { id: 'gemma2-9b-it', label: 'Gemma 2 9B' },
    ]),
    description: 'LPU inference engine with blistering 500+ tokens/sec output speed. Free rate-limited tier.',
  }),
  Object.freeze({
    id: 'cerebras',
    name: 'Cerebras Cloud',
    icon: '⚡',
    badge: '1,800 TOKENS/SEC',
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'llama3.3-70b',
    keyUrl: 'https://cloud.cerebras.ai/',
    keyPlaceholder: 'paste Cerebras API Key (csk-...)',
    keyPrefix: 'csk-',
    models: Object.freeze([
      { id: 'llama3.3-70b', label: 'Llama 3.3 70B (Wafer-Scale)' },
      { id: 'llama3.1-8b', label: 'Llama 3.1 8B (Ultra Fast)' },
      { id: 'deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 Distill 70B' },
      { id: 'qwq-32b', label: 'QwQ 32B (Reasoning)' },
    ]),
    description: 'Wafer-scale engine with record-breaking 1,800 tokens/sec. 1M free tokens per day.',
  }),
  Object.freeze({
    id: 'gemini',
    name: 'Google Gemini',
    icon: '🟢',
    badge: '1,500 REQ/DAY FREE',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    keyPlaceholder: 'paste Gemini API Key (AIzaSy...)',
    keyPrefix: 'AIzaSy',
    models: Object.freeze([
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (1M Context)' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite (High Speed)' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Complex Reasoning)' },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
      { id: 'gemma-2-27b-it', label: 'Gemma 2 27B' },
    ]),
    description: '1,500 requests/day permanent free tier via Google AI Studio. 1M token context window.',
  }),
  Object.freeze({
    id: 'mistral',
    name: 'Mistral AI',
    icon: '🌪️',
    badge: 'FREE CREDITS',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    keyUrl: 'https://console.mistral.ai/api-keys',
    keyPlaceholder: 'paste Mistral API Key',
    keyPrefix: '',
    models: Object.freeze([
      { id: 'mistral-small-latest', label: 'Mistral Small (Fast & Smart)' },
      { id: 'codestral-latest', label: 'Codestral (Code Specialist)' },
      { id: 'mistral-large-latest', label: 'Mistral Large' },
      { id: 'ministral-8b-latest', label: 'Ministral 8B' },
      { id: 'ministral-3b-latest', label: 'Ministral 3B' },
    ]),
    description: 'Sovereign European AI models with free credit allowance on signup.',
  }),
  Object.freeze({
    id: 'cohere',
    name: 'Cohere',
    icon: '🇨🇦',
    badge: '1,000 CALLS/MO',
    baseUrl: 'https://api.cohere.com/v2',
    defaultModel: 'command-r-plus',
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    keyPlaceholder: 'paste Cohere API Key',
    keyPrefix: '',
    models: Object.freeze([
      { id: 'command-r-plus', label: 'Command R+ (Frontier)' },
      { id: 'command-r', label: 'Command R (Fast)' },
      { id: 'command-r7b-12-2024', label: 'Command R7B (Lightweight)' },
      { id: 'aya-expanse-32b', label: 'Aya Expanse 32B (Multilingual)' },
      { id: 'aya-vision-32b', label: 'Aya Vision 32B (Multimodal)' },
    ]),
    description: '1,000 calls/month trial. Enterprise RAG, vision, and multilingual models.',
  }),
  Object.freeze({
    id: 'aion',
    name: 'Aion Labs',
    icon: '🇮🇱',
    badge: '15 RPM / 20K TPD',
    baseUrl: 'https://api.aionlabs.ai/v1',
    defaultModel: 'aion-3.0',
    keyUrl: 'https://aionlabs.ai',
    keyPlaceholder: 'paste Aion Labs Key',
    keyPrefix: 'aion-',
    models: Object.freeze([
      { id: 'aion-3.0', label: 'Aion 3.0 (128K Reasoning)' },
      { id: 'aion-3.0-mini', label: 'Aion 3.0 Mini' },
      { id: 'aion-2.0', label: 'Aion 2.0' },
      { id: 'aion-rp-llama-3.1-8b', label: 'Aion RP Llama 3.1 8B' },
    ]),
    description: '15 RPM, 20K tokens/day free tier. Deep reasoning specialist with 128K context.',
  }),
  Object.freeze({
    id: 'zhipu',
    name: 'Z AI (Zhipu)',
    icon: '🇨🇳',
    badge: 'PERMANENT FREE',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    keyUrl: 'https://open.bigmodel.cn/',
    keyPlaceholder: 'paste Zhipu API Key',
    keyPrefix: '',
    models: Object.freeze([
      { id: 'glm-4-flash', label: 'GLM-4 Flash (200K Context)' },
      { id: 'glm-4v-flash', label: 'GLM-4V Flash (Multimodal)' },
    ]),
    description: 'Permanent free tier. Highly efficient Chinese/English bilingual and vision models.',
  }),
  Object.freeze({
    id: 'sambanova',
    name: 'SambaNova',
    icon: '⚡',
    badge: 'SN40L ACCEL',
    baseUrl: 'https://api.sambanova.ai/v1',
    defaultModel: 'Meta-Llama-3.3-70B-Instruct',
    keyUrl: 'https://cloud.sambanova.ai/',
    keyPlaceholder: 'paste SambaNova API Key',
    keyPrefix: '',
    models: Object.freeze([
      { id: 'Meta-Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B (SambaNova)' },
      { id: 'Meta-Llama-3.1-8B-Instruct', label: 'Llama 3.1 8B (Instant)' },
      { id: 'DeepSeek-R1-Distill-Llama-70B', label: 'DeepSeek R1 Distill 70B' },
      { id: 'Qwen2.5-Coder-32B-Instruct', label: 'Qwen 2.5 Coder 32B' },
    ]),
    description: 'Reconfigurable dataflow SN40L architecture delivering ultra-fast throughput.',
  }),
  Object.freeze({
    id: 'together',
    name: 'Together AI',
    icon: '🤝',
    badge: '$1 FREE CREDIT',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    keyUrl: 'https://api.together.ai',
    keyPlaceholder: 'paste Together AI Key',
    keyPrefix: '',
    models: Object.freeze([
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo' },
      { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', label: 'Llama 3.1 8B Turbo' },
      { id: 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B', label: 'DeepSeek R1 Distill 70B' },
      { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', label: 'Qwen 2.5 72B Turbo' },
    ]),
    description: 'Broad open model catalog with low-latency dedicated inference infrastructure.',
  }),
  Object.freeze({
    id: 'requesty',
    name: 'Requesty',
    icon: '🇫🇷',
    badge: 'SMART ROUTER',
    baseUrl: 'https://router.requesty.ai/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
    keyUrl: 'https://requesty.ai',
    keyPlaceholder: 'paste Requesty API Key',
    keyPrefix: '',
    models: Object.freeze([
      { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B (Auto-Routed)' },
      { id: 'deepseek/deepseek-r1', label: 'DeepSeek R1' },
      { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ]),
    description: 'Smart AI router that automatically discovers and connects the fastest free endpoints.',
  }),
  Object.freeze({
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    icon: '☁️',
    badge: '10K NEURONS/DAY',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/ai/v1',
    defaultModel: '@cf/meta/llama-3.3-70b-instruct',
    keyUrl: 'https://dash.cloudflare.com',
    keyPlaceholder: 'paste Cloudflare AI Token',
    keyPrefix: '',
    models: Object.freeze([
      { id: '@cf/meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B (CF Edge)' },
      { id: '@cf/meta/llama-3.1-8b-instruct', label: 'Llama 3.1 8B' },
      { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', label: 'DeepSeek R1 Distill 32B' },
      { id: '@cf/qwen/qwen2.5-coder-32b-instruct', label: 'Qwen 2.5 Coder 32B' },
    ]),
    description: '10,000 neurons/day permanent free allocation running on global edge network.',
  }),
  Object.freeze({
    id: 'openrouter',
    name: 'OpenRouter Free',
    icon: '🌐',
    badge: '20+ FREE MODELS',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    keyUrl: 'https://openrouter.ai/keys',
    keyPlaceholder: 'paste OpenRouter Key (sk-or-v1-...)',
    keyPrefix: 'sk-or-',
    models: Object.freeze([
      { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (Free)' },
      { id: 'deepseek/deepseek-r1:free', label: 'DeepSeek R1 (Free)' },
      { id: 'google/gemini-2.0-flash-exp:free', label: 'Gemini 2.0 Flash (Free)' },
      { id: 'qwen/qwen-2.5-coder-32b-instruct:free', label: 'Qwen 2.5 Coder (Free)' },
      { id: 'mistralai/mistral-7b-instruct:free', label: 'Mistral 7B (Free)' },
    ]),
    description: 'Unified gateway aggregating free community models with standard OpenAI compatibility.',
  }),
]);

/**
 * Categorized NVIDIA & Free Models for Command Center Drawer.
 */
export const NVIDIA_MODEL_REGISTRY = Object.freeze({
  tactical: Object.freeze([
    { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', label: 'Nemotron 3.5 Lightning (Fast)', speed: 'Ultra', provider: 'NVIDIA' },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b', label: 'Nemotron 550B Ultra', speed: 'Deep', provider: 'NVIDIA' },
    { id: 'meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B Instruct', speed: 'Fast', provider: 'NVIDIA / Meta' },
  ]),
  vision: Object.freeze([
    { id: 'meta/llama-3.2-11b-vision-instruct', label: 'Llama 3.2 Vision (11B)', speed: 'Fast', provider: 'NVIDIA' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash Vision', speed: 'Fast', provider: 'Google' },
    { id: 'aya-vision-32b', label: 'Aya Vision 32B', speed: 'Medium', provider: 'Cohere' },
    { id: 'glm-4v-flash', label: 'GLM-4V Flash', speed: 'Ultra', provider: 'Zhipu' },
  ]),
  genai: Object.freeze([
    { id: 'stabilityai/stable-diffusion-3-medium', label: 'Stable Diffusion 3 Medium', speed: 'Image', provider: 'NVIDIA' },
    { id: 'black-forest-labs/flux-1-schnell', label: 'Flux.1 Schnell', speed: 'Image', provider: 'NVIDIA' },
  ]),
  code: Object.freeze([
    { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B (Code Specialist)', speed: 'Ultra', provider: 'OpenAI/NVIDIA' },
    { id: 'codestral-latest', label: 'Codestral Latest', speed: 'Fast', provider: 'Mistral' },
    { id: 'qwen/qwen-2.5-coder-32b-instruct:free', label: 'Qwen 2.5 Coder 32B', speed: 'Fast', provider: 'OpenRouter' },
    { id: 'Qwen2.5-Coder-32B-Instruct', label: 'Qwen 2.5 Coder (SambaNova)', speed: 'Blazing', provider: 'SambaNova' },
  ]),
  reasoning: Object.freeze([
    { id: 'nvidia/nemotron-3-ultra-550b-a55b', label: 'Nemotron 550B Ultra', speed: 'Deep', provider: 'NVIDIA' },
    { id: 'deepseek-ai/deepseek-r1', label: 'DeepSeek R1 (Thinking Trace)', speed: 'Deep', provider: 'NVIDIA' },
    { id: 'aion-3.0', label: 'Aion 3.0 (128K Reasoning)', speed: 'Deep', provider: 'Aion Labs' },
    { id: 'qwq-32b', label: 'QwQ 32B Reasoning', speed: 'Fast', provider: 'Cerebras' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', speed: 'Deep', provider: 'Google' },
  ]),
  global: Object.freeze([
    { id: 'mistralai/mistral-nemotron', label: 'Mistral-Nemotron Multilingual', speed: 'Fast', provider: 'NVIDIA / Mistral' },
    { id: 'aya-expanse-32b', label: 'Aya Expanse 32B', speed: 'Fast', provider: 'Cohere' },
    { id: 'moonshotai/kimi-k3', label: 'Kimi K3 (200K Long Context)', speed: 'Medium', provider: 'NVIDIA' },
    { id: 'glm-4-flash', label: 'GLM-4 Flash (200K)', speed: 'Ultra', provider: 'Zhipu' },
  ]),
  speed: Object.freeze([
    { id: 'llama3.3-70b', label: 'Cerebras Llama 3.3 (1,800 t/s)', speed: '1800 t/s', provider: 'Cerebras' },
    { id: 'llama-3.3-70b-versatile', label: 'Groq Llama 3.3 (500+ t/s)', speed: '500 t/s', provider: 'Groq' },
    { id: 'Meta-Llama-3.3-70B-Instruct', label: 'SambaNova Llama 3.3', speed: '400 t/s', provider: 'SambaNova' },
  ]),
});

/**
 * Returns all 13 providers.
 */
export function getAllProviders() {
  return FREE_LLM_PROVIDERS;
}

/**
 * Returns capabilities for a given model ID.
 */
export function getModelCapabilities(modelId) {
  if (!modelId) return { modality: 'text', context: '32k', speed: 'normal' };
  const id = String(modelId).toLowerCase();
  const isVision = id.includes('vision') || id.includes('4v') || id.includes('image');
  const isReasoning = id.includes('r1') || id.includes('550b') || id.includes('qwq') || id.includes('pro') || id.includes('aion');
  const isCode = id.includes('code') || id.includes('coder') || id.includes('gpt-oss');
  const isSpeed = id.includes('cerebras') || id.includes('groq') || id.includes('sambanova') || id.includes('lightning');

  return {
    modality: isVision ? 'multimodal' : 'text',
    isReasoning,
    isCode,
    isSpeed,
    context: id.includes('gemini') ? '1M' : id.includes('kimi') || id.includes('glm') ? '200K' : id.includes('aion') ? '128K' : '32K-128K',
  };
}

/**
 * Returns models for a specific UI category tab.
 */
export function getModelsForCategory(category) {
  return NVIDIA_MODEL_REGISTRY[category] || [];
}

/**
 * Find provider configuration by ID or base URL.
 * @param {string} idOrUrl
 * @returns {object|null}
 */
export function findFreeLlmProvider(idOrUrl) {
  if (!idOrUrl) return FREE_LLM_PROVIDERS[0];
  const query = String(idOrUrl).trim().toLowerCase();
  return (
    FREE_LLM_PROVIDERS.find(
      (p) => p.id.toLowerCase() === query || p.baseUrl.toLowerCase().includes(query)
    ) || null
  );
}

/**
 * Resolve provider from an API key prefix or string.
 * @param {string} apiKey
 * @returns {object}
 */
export function detectProviderFromKey(apiKey) {
  if (!apiKey) return FREE_LLM_PROVIDERS[0];
  const key = String(apiKey).trim();
  if (key.startsWith('nvapi-')) return findFreeLlmProvider('nvidia');
  if (key.startsWith('AIzaSy')) return findFreeLlmProvider('gemini');
  if (key.startsWith('gsk_')) return findFreeLlmProvider('groq');
  if (key.startsWith('csk-')) return findFreeLlmProvider('cerebras');
  if (key.startsWith('sk-or-')) return findFreeLlmProvider('openrouter');
  if (key.startsWith('aion-')) return findFreeLlmProvider('aion');
  return FREE_LLM_PROVIDERS[0];
}
