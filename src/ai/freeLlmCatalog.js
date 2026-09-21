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
    envVar: 'NVIDIA_API_KEY',
    models: Object.freeze([
      {
        id: 'nvidia/nemotron-3.5-lightning-30b-a3b',
        label: 'Nemotron 3.5 (Fast Tactical)',
      },
      {
        id: 'nvidia/nemotron-3-ultra-550b-a55b',
        label: 'Nemotron 550B (Deep Reasoning)',
      },
      {
        id: 'nvidia/llama-3.1-nemotron-70b-instruct',
        label: 'Nemotron 70B Instruct',
      },
      { id: 'deepseek-ai/deepseek-r1', label: 'DeepSeek R1 (Thinking Trace)' },
      { id: 'deepseek-ai/deepseek-v3', label: 'DeepSeek V3 (671B MoE)' },
      { id: 'meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
      {
        id: 'meta/llama-3.2-11b-vision-instruct',
        label: 'Llama 3.2 Vision (11B)',
      },
      {
        id: 'meta/llama-3.2-90b-vision-instruct',
        label: 'Llama 3.2 Vision (90B Heavy)',
      },
      { id: 'meta/llama-3.1-405b-instruct', label: 'Llama 3.1 405B Frontier' },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B (Code & Logic)' },
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B (Deep Reasoning)' },
      { id: 'qwen/qwen2.5-72b-instruct', label: 'Qwen 2.5 72B Instruct' },
      {
        id: 'mistralai/mistral-nemotron',
        label: 'Mistral-Nemotron (Multilingual)',
      },
      { id: 'moonshotai/kimi-k3', label: 'Kimi K3 (200K Long Context)' },
    ]),
    description:
      '1,000 free requests. Top-tier frontier open weights hosted on NVIDIA DGX Cloud.',
  }),
  Object.freeze({
    id: 'groq',
    name: 'Groq Cloud',
    icon: '🚀',
    badge: '500+ TOKENS/SEC',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-20b',
    keyUrl: 'https://console.groq.com/keys',
    keyPlaceholder: 'paste Groq API Key (gsk_...)',
    keyPrefix: 'gsk_',
    envVar: 'GROQ_API_KEY',
    models: Object.freeze([
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B (Ultra Fast LPU)' },
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B (Deep Reasoning)' },
      { id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B (LPU Speed)' },
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (500+ t/s)' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (1,000+ t/s)' },
      { id: 'deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 Distill 70B' },
      { id: 'groq/compound', label: 'Groq Compound Router' },
      { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo (Voice)' },
    ]),
    description:
      'LPU inference engine with blistering 500+ tokens/sec output speed. Free rate-limited tier.',
  }),
  Object.freeze({
    id: 'cerebras',
    name: 'Cerebras Cloud',
    icon: '⚡',
    badge: '1,800 TOKENS/SEC',
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'gpt-oss-120b',
    keyUrl: 'https://cloud.cerebras.ai/',
    keyPlaceholder: 'paste Cerebras API Key (csk-...)',
    keyPrefix: 'csk-',
    envVar: 'CEREBRAS_API_KEY',
    models: Object.freeze([
      { id: 'gpt-oss-120b', label: 'GPT-OSS 120B (Wafer-Scale 1,800 t/s)' },
      { id: 'llama3.3-70b', label: 'Llama 3.3 70B (1,800 t/s)' },
      { id: 'llama3.1-8b', label: 'Llama 3.1 8B (2,200 t/s Instant)' },
      { id: 'qwen-3.8-27b', label: 'Qwen 3.8 27B' },
      {
        id: 'deepseek-r1-distill-llama-70b',
        label: 'DeepSeek R1 (Wafer Speed)',
      },
    ]),
    description:
      'Wafer-scale engine with record-breaking 1,800 tokens/sec. 1M free tokens per day.',
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
    envVar: 'GEMINI_API_KEY',
    models: Object.freeze([
      {
        id: 'gemini-2.5-flash',
        label: 'Gemini 2.5 Flash (1M Context, Next-Gen Fast)',
      },
      {
        id: 'gemini-2.5-pro',
        label: 'Gemini 2.5 Pro (Deep Multimodal Reasoning)',
      },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (Low Latency)' },
      {
        id: 'gemini-2.0-flash-thinking-exp',
        label: 'Gemini 2.0 Flash Thinking (CoT Reasoning)',
      },
      {
        id: 'gemini-3.6-flash',
        label: 'Gemini 3.6 Flash (High Quota)',
      },
      { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro (2M Context Extreme)' },
      { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash (1M Context)' },
    ]),
    description:
      '1,500 requests/day permanent free tier via Google AI Studio. 1M token context window.',
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
    envVar: 'MISTRAL_API_KEY',
    models: Object.freeze([
      { id: 'mistral-small-latest', label: 'Mistral Small (Fast & Smart)' },
      { id: 'codestral-latest', label: 'Codestral (Code Intelligence)' },
      {
        id: 'mistral-large-latest',
        label: 'Mistral Large (Flagship Sovereign)',
      },
      { id: 'ministral-8b-latest', label: 'Ministral 8B (Edge Speed)' },
      { id: 'ministral-3b-latest', label: 'Ministral 3B (Sub-Second)' },
      { id: 'pixtral-12b-2409', label: 'Pixtral 12B (Vision Specialist)' },
    ]),
    description:
      'Sovereign European AI models with free credit allowance on signup.',
  }),
  Object.freeze({
    id: 'cohere',
    name: 'Cohere',
    icon: '🇨🇦',
    badge: '1,000 CALLS/MO',
    baseUrl: 'https://api.cohere.com/v2',
    defaultModel: 'command-r-plus-08-2024',
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    keyPlaceholder: 'paste Cohere API Key',
    keyPrefix: '',
    envVar: 'COHERE_API_KEY',
    models: Object.freeze([
      {
        id: 'command-r-plus-08-2024',
        label: 'Command R+ (Enterprise Reasoning & Citations)',
      },
      { id: 'command-r-08-2024', label: 'Command R (Fast RAG)' },
      { id: 'command-r7b-12-2024', label: 'Command R 7B (Lightweight)' },
      { id: 'c4ai-aya-expanse-32b', label: 'Aya Expanse 32B (23 Languages)' },
      { id: 'c4ai-aya-vision-32b', label: 'Aya Vision 32B (Multimodal)' },
    ]),
    description:
      '1,000 calls/month trial. Enterprise RAG, vision, and multilingual models.',
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
    envVar: 'AION_API_KEY',
    models: Object.freeze([
      { id: 'aion-3.0', label: 'Aion 3.0 (128K Reasoning)' },
      { id: 'aion-3.0-mini', label: 'Aion 3.0 Mini (Fast)' },
      { id: 'aion-2.0', label: 'Aion 2.0 (Balanced)' },
      { id: 'aion-rp-llama-3.1-8b', label: 'Aion RP Llama 3.1 8B' },
    ]),
    description:
      '15 RPM, 20K tokens/day free tier. Deep reasoning specialist with 128K context.',
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
    envVar: 'ZHIPU_API_KEY',
    models: Object.freeze([
      { id: 'glm-4-flash', label: 'GLM-4 Flash (200K Context Free)' },
      { id: 'glm-4v-flash', label: 'GLM-4V Flash (Multimodal Free)' },
      { id: 'glm-4-plus', label: 'GLM-4 Plus (Frontier Intelligence)' },
    ]),
    description:
      'Permanent free tier. Highly efficient Chinese/English bilingual and vision models.',
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
    envVar: 'SAMBANOVA_API_KEY',
    models: Object.freeze([
      {
        id: 'Meta-Llama-3.3-70B-Instruct',
        label: 'Llama 3.3 70B (SN40L 400 t/s)',
      },
      {
        id: 'Meta-Llama-3.1-405B-Instruct',
        label: 'Llama 3.1 405B (Flagship Dataflow)',
      },
      { id: 'Meta-Llama-3.1-8B-Instruct', label: 'Llama 3.1 8B (Instant)' },
      { id: 'DeepSeek-R1-Distill-Llama-70B', label: 'DeepSeek R1 Distill 70B' },
      { id: 'Qwen2.5-Coder-32B-Instruct', label: 'Qwen 2.5 Coder 32B' },
      { id: 'Qwen2.5-72B-Instruct', label: 'Qwen 2.5 72B Instruct' },
    ]),
    description:
      'Reconfigurable dataflow SN40L architecture delivering ultra-fast throughput.',
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
    envVar: 'TOGETHER_API_KEY',
    models: Object.freeze([
      {
        id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        label: 'Llama 3.3 70B Turbo',
      },
      {
        id: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
        label: 'Llama 3.1 8B Turbo',
      },
      {
        id: 'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo',
        label: 'Llama 3.1 405B Turbo',
      },
      {
        id: 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B',
        label: 'DeepSeek R1 Distill 70B',
      },
      { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek V3 (671B MoE)' },
      { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', label: 'Qwen 2.5 72B Turbo' },
      { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', label: 'Qwen 2.5 Coder 32B' },
    ]),
    description:
      'Broad open model catalog with low-latency dedicated inference infrastructure.',
  }),
  Object.freeze({
    id: 'requesty',
    name: 'Requesty',
    icon: '🇫🇷',
    badge: 'SMART ROUTER',
    baseUrl: 'https://router.requesty.ai/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
    keyUrl: 'https://requesty.ai',
    keyPlaceholder: 'paste Requesty API Key (rqsty-sk-...)',
    keyPrefix: 'rqsty-',
    envVar: 'REQUESTY_API_KEY',
    models: Object.freeze([
      {
        id: 'meta-llama/llama-3.3-70b-instruct',
        label: 'Llama 3.3 70B (Auto-Routed)',
      },
      { id: 'deepseek/deepseek-r1', label: 'DeepSeek R1' },
      { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o Mini (Requesty)' },
    ]),
    description:
      'Smart AI router that automatically discovers and connects the fastest free endpoints.',
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
    envVar: 'CLOUDFLARE_API_KEY',
    models: Object.freeze([
      {
        id: '@cf/meta/llama-3.3-70b-instruct',
        label: 'Llama 3.3 70B (CF Edge)',
      },
      { id: '@cf/meta/llama-3.1-8b-instruct', label: 'Llama 3.1 8B (CF Edge)' },
      {
        id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
        label: 'DeepSeek R1 Distill 32B',
      },
      {
        id: '@cf/qwen/qwen2.5-coder-32b-instruct',
        label: 'Qwen 2.5 Coder 32B',
      },
    ]),
    description:
      '10,000 neurons/day permanent free allocation running on global edge network.',
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
    envVar: 'OPENROUTER_API_KEY',
    models: Object.freeze([
      {
        id: 'meta-llama/llama-3.3-70b-instruct:free',
        label: 'Llama 3.3 70B (Free)',
      },
      { id: 'deepseek/deepseek-r1:free', label: 'DeepSeek R1 (Free)' },
      { id: 'deepseek/deepseek-chat:free', label: 'DeepSeek V3 (Free)' },
      {
        id: 'google/gemini-2.0-flash-exp:free',
        label: 'Gemini 2.0 Flash (Free)',
      },
      {
        id: 'google/gemini-2.0-flash-thinking-exp:free',
        label: 'Gemini Thinking (Free)',
      },
      {
        id: 'qwen/qwen-2.5-coder-32b-instruct:free',
        label: 'Qwen 2.5 Coder (Free)',
      },
      {
        id: 'qwen/qwen-2.5-72b-instruct:free',
        label: 'Qwen 2.5 72B (Free)',
      },
      { id: 'mistralai/mistral-7b-instruct:free', label: 'Mistral 7B (Free)' },
      {
        id: 'sophosympatheia/rogue-rose-103b-v0.2:free',
        label: 'Rogue Rose 103B (Uncensored)',
      },
    ]),
    description:
      'Unified gateway aggregating free community models with standard OpenAI compatibility.',
  }),
  Object.freeze({
    id: 'manifest',
    name: 'Manifest Gateway',
    icon: '🦚',
    badge: 'LLM ROUTER',
    baseUrl: 'https://app.manifest.build/v1',
    defaultModel: 'auto',
    keyUrl: 'https://app.manifest.build',
    keyPlaceholder: 'paste Manifest Harness Key (mnfst_...)',
    keyPrefix: 'mnfst_',
    envVar: 'MANIFEST_API_KEY',
    models: Object.freeze([
      { id: 'auto', label: 'Auto Router (Manifest Dynamic)' },
    ]),
    description:
      'Unified LLM gateway & router dynamically dispatching queries with smart fallbacks.',
  }),
]);

/**
 * Categorized NVIDIA & Free Models for Command Center Drawer.
 */
export const NVIDIA_MODEL_REGISTRY = Object.freeze({
  tactical: Object.freeze([
    {
      id: 'nvidia/nemotron-3.5-lightning-30b-a3b',
      label: 'Nemotron 3.5 Lightning (Fast)',
      speed: 'Ultra',
      provider: 'NVIDIA NIM',
    },
    {
      id: 'nvidia/nemotron-3-ultra-550b-a55b',
      label: 'Nemotron 550B Ultra',
      speed: 'Deep',
      provider: 'NVIDIA NIM',
    },
    {
      id: 'meta/llama-3.3-70b-instruct',
      label: 'Llama 3.3 70B Instruct',
      speed: 'Fast',
      provider: 'Meta / NVIDIA',
    },
    {
      id: 'deepseek-ai/deepseek-v3',
      label: 'DeepSeek V3 (671B Frontier)',
      speed: 'Fast',
      provider: 'DeepSeek',
    },
    {
      id: 'qwen/qwen2.5-72b-instruct',
      label: 'Qwen 2.5 72B Frontier',
      speed: 'Fast',
      provider: 'Alibaba',
    },
  ]),
  vision: Object.freeze([
    {
      id: 'meta/llama-3.2-11b-vision-instruct',
      label: 'Llama 3.2 Vision (11B)',
      speed: 'Fast',
      provider: 'Meta / NVIDIA',
    },
    {
      id: 'meta/llama-3.2-90b-vision-instruct',
      label: 'Llama 3.2 Vision (90B Heavy)',
      speed: 'Deep',
      provider: 'Meta / NVIDIA',
    },
    {
      id: 'gemini-2.5-flash',
      label: 'Gemini 2.5 Flash Vision',
      speed: 'Fast',
      provider: 'Google',
    },
    {
      id: 'pixtral-12b-2409',
      label: 'Pixtral 12B Vision',
      speed: 'Fast',
      provider: 'Mistral',
    },
    {
      id: 'c4ai-aya-vision-32b',
      label: 'Aya Vision 32B',
      speed: 'Medium',
      provider: 'Cohere',
    },
    {
      id: 'glm-4v-flash',
      label: 'GLM-4V Flash',
      speed: 'Ultra',
      provider: 'Zhipu',
    },
  ]),
  genai: Object.freeze([
    {
      id: 'stabilityai/stable-diffusion-3-medium',
      label: 'Stable Diffusion 3 Medium',
      speed: 'Image',
      provider: 'Stability / NVIDIA',
    },
    {
      id: 'black-forest-labs/flux-1-schnell',
      label: 'Flux.1 Schnell',
      speed: 'Image',
      provider: 'BFL / NVIDIA',
    },
  ]),
  code: Object.freeze([
    {
      id: 'codestral-latest',
      label: 'Codestral (Code Intelligence)',
      speed: 'Fast',
      provider: 'Mistral',
    },
    {
      id: 'openai/gpt-oss-20b',
      label: 'GPT-OSS 20B (Code Specialist)',
      speed: 'Ultra',
      provider: 'Groq / LPU',
    },
    {
      id: 'Qwen2.5-Coder-32B-Instruct',
      label: 'Qwen 2.5 Coder (SambaNova)',
      speed: 'Blazing',
      provider: 'SambaNova',
    },
    {
      id: 'qwen/qwen-2.5-coder-32b-instruct:free',
      label: 'Qwen 2.5 Coder 32B (OpenRouter)',
      speed: 'Fast',
      provider: 'OpenRouter',
    },
    {
      id: 'openai/gpt-oss-120b',
      label: 'GPT-OSS 120B (Deep Logic)',
      speed: 'Deep',
      provider: 'Groq / Cerebras',
    },
  ]),
  reasoning: Object.freeze([
    {
      id: 'deepseek-ai/deepseek-r1',
      label: 'DeepSeek R1 (Thinking Trace)',
      speed: 'Deep',
      provider: 'DeepSeek / NVIDIA',
    },
    {
      id: 'nvidia/nemotron-3-ultra-550b-a55b',
      label: 'Nemotron 550B Ultra',
      speed: 'Deep',
      provider: 'NVIDIA NIM',
    },
    {
      id: 'gemini-2.5-pro',
      label: 'Gemini 2.5 Pro (Complex Reasoning)',
      speed: 'Deep',
      provider: 'Google',
    },
    {
      id: 'gemini-2.0-flash-thinking-exp',
      label: 'Gemini Flash Thinking (CoT)',
      speed: 'Fast',
      provider: 'Google',
    },
    {
      id: 'aion-3.0',
      label: 'Aion 3.0 (128K Reasoning)',
      speed: 'Deep',
      provider: 'Aion Labs',
    },
    {
      id: 'DeepSeek-R1-Distill-Llama-70B',
      label: 'DeepSeek R1 Distill 70B',
      speed: 'Fast',
      provider: 'SambaNova / Groq',
    },
  ]),
  global: Object.freeze([
    {
      id: 'mistralai/mistral-nemotron',
      label: 'Mistral-Nemotron Multilingual',
      speed: 'Fast',
      provider: 'NVIDIA / Mistral',
    },
    {
      id: 'c4ai-aya-expanse-32b',
      label: 'Aya Expanse 32B (23 Languages)',
      speed: 'Fast',
      provider: 'Cohere',
    },
    {
      id: 'moonshotai/kimi-k3',
      label: 'Kimi K3 (200K Long Context)',
      speed: 'Medium',
      provider: 'Moonshot / NVIDIA',
    },
    {
      id: 'glm-4-flash',
      label: 'GLM-4 Flash (200K Free)',
      speed: 'Ultra',
      provider: 'Zhipu',
    },
  ]),
  speed: Object.freeze([
    {
      id: 'llama3.3-70b',
      label: 'Cerebras Llama 3.3 (1,800 t/s)',
      speed: '1800 t/s',
      provider: 'Cerebras',
    },
    {
      id: 'llama3.1-8b',
      label: 'Cerebras Llama 3.1 (2,200 t/s)',
      speed: '2200 t/s',
      provider: 'Cerebras',
    },
    {
      id: 'llama-3.3-70b-versatile',
      label: 'Groq Llama 3.3 (500+ t/s)',
      speed: '500 t/s',
      provider: 'Groq',
    },
    {
      id: 'openai/gpt-oss-20b',
      label: 'Groq GPT-OSS 20B (750+ t/s)',
      speed: '750 t/s',
      provider: 'Groq',
    },
    {
      id: 'Meta-Llama-3.3-70B-Instruct',
      label: 'SambaNova Llama 3.3 (400+ t/s)',
      speed: '400 t/s',
      provider: 'SambaNova',
    },
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
  const isVision =
    id.includes('vision') || id.includes('4v') || id.includes('image');
  const isReasoning =
    id.includes('r1') ||
    id.includes('550b') ||
    id.includes('qwq') ||
    id.includes('pro') ||
    id.includes('aion');
  const isCode =
    id.includes('code') || id.includes('coder') || id.includes('gpt-oss');
  const isSpeed =
    id.includes('cerebras') ||
    id.includes('groq') ||
    id.includes('sambanova') ||
    id.includes('lightning');

  return {
    modality: isVision ? 'multimodal' : 'text',
    isReasoning,
    isCode,
    isSpeed,
    context: id.includes('gemini')
      ? '1M'
      : id.includes('kimi') || id.includes('glm')
        ? '200K'
        : id.includes('aion')
          ? '128K'
          : '32K-128K',
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
      (p) =>
        p.id.toLowerCase() === query || p.baseUrl.toLowerCase().includes(query),
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
  if (key.startsWith('rqsty-')) return findFreeLlmProvider('requesty');
  if (key.startsWith('mnfst_')) return findFreeLlmProvider('manifest');
  return FREE_LLM_PROVIDERS[0];
}

/**
 * Check if a given key or baseUrl belongs to a specific provider.
 * @param {string} providerId
 * @param {string} key
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function isKeyForProvider(providerId, key = '', baseUrl = '') {
  const k = String(key || '').trim();
  const url = String(baseUrl || '').toLowerCase();
  switch (providerId) {
    case 'nvidia':
      return (
        k.startsWith('nvapi-') ||
        (k.length > 0 &&
          !k.startsWith('rqsty-') &&
          !k.startsWith('gsk_') &&
          !k.startsWith('csk-') &&
          !k.startsWith('AIzaSy') &&
          !k.startsWith('sk-or-') &&
          !k.startsWith('aion-') &&
          !k.startsWith('mnfst_') &&
          url.includes('nvidia.com'))
      );
    case 'manifest':
      return k.startsWith('mnfst_') || url.includes('manifest.build');
    case 'requesty':
      return k.startsWith('rqsty-') || url.includes('requesty.ai');
    case 'groq':
      return k.startsWith('gsk_') || url.includes('groq.com');
    case 'cerebras':
      return k.startsWith('csk-') || url.includes('cerebras.ai');
    case 'gemini':
      return k.startsWith('AIzaSy') || url.includes('generativelanguage');
    case 'openrouter':
      return k.startsWith('sk-or-') || url.includes('openrouter.ai');
    case 'aion':
      return k.startsWith('aion-') || url.includes('aionlabs.ai');
    case 'mistral':
      return url.includes('mistral.ai');
    case 'cohere':
      return url.includes('cohere.com');
    case 'zhipu':
      return url.includes('bigmodel.cn');
    case 'sambanova':
      return url.includes('sambanova.ai');
    case 'together':
      return url.includes('together.xyz') || url.includes('together.ai');
    case 'cloudflare':
      return url.includes('cloudflare.com');
    default:
      return false;
  }
}

/**
 * Determine which provider hosts or is best suited for a given model ID.
 * @param {string} modelId
 * @param {string} [preferredProvider]
 * @returns {object|null}
 */
export function findProviderForModel(modelId, preferredProvider = null) {
  if (!modelId) return null;
  const m = String(modelId).trim().toLowerCase();

  if (preferredProvider) {
    const p = findFreeLlmProvider(preferredProvider);
    if (p) return p;
  }

  // Check if modelId contains a provider prefix e.g. "groq/...", "gemini/...", "cerebras/..."
  const slashIdx = m.indexOf('/');
  if (slashIdx > 0) {
    const prefix = m.slice(0, slashIdx);
    const p = findFreeLlmProvider(prefix);
    if (
      p &&
      prefix !== 'openai' &&
      prefix !== 'meta' &&
      prefix !== 'deepseek-ai'
    ) {
      return p;
    }
  }

  // Exact model match within provider catalogs
  for (const provider of FREE_LLM_PROVIDERS) {
    if (provider.models.some((item) => item.id.toLowerCase() === m)) {
      return provider;
    }
  }

  // Heuristic matching
  if (m.includes('gemini')) return findFreeLlmProvider('gemini');
  if (m.includes('groq') || m.includes('qwen3.8') || m.includes('compound'))
    return findFreeLlmProvider('groq');
  if (m.includes('cerebras') || m.includes('120b'))
    return findFreeLlmProvider('cerebras');
  if (
    m.includes('mistral') ||
    m.includes('codestral') ||
    m.includes('pixtral') ||
    m.includes('ministral')
  )
    return findFreeLlmProvider('mistral');
  if (m.includes('cohere') || m.includes('command-r') || m.includes('aya-'))
    return findFreeLlmProvider('cohere');
  if (m.includes('sambanova')) return findFreeLlmProvider('sambanova');
  if (m.includes('together')) return findFreeLlmProvider('together');
  if (m.endsWith(':free') || m.includes('openrouter'))
    return findFreeLlmProvider('openrouter');
  if (m.includes('aion')) return findFreeLlmProvider('aion');
  if (m.includes('glm')) return findFreeLlmProvider('zhipu');
  if (m.startsWith('@cf/')) return findFreeLlmProvider('cloudflare');
  if (
    m.includes('nemotron') ||
    m.startsWith('nvidia/') ||
    m.includes('deepseek') ||
    m.includes('llama-3')
  )
    return findFreeLlmProvider('nvidia');
  return null;
}
