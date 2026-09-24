import { readRequestBody } from './common/request.js';
import { GEV_REALTIME_TOOLS } from './openai/tools.js';
import { realtimeInstructions } from './openai/instructions.js';
import {
  handleNvidiaAssistant,
  handleNvidiaResearch,
} from './nvidia-assistant.js';
import { handleNvidiaGenAiImage } from './nvidia-genai.js';
import { handleNvidiaVisionAnalyze } from './nvidia-vision.js';
import { jarvisToolsProxy } from './jarvis-tools.js';
import {
  FREE_LLM_PROVIDERS,
  findFreeLlmProvider,
  detectProviderFromKey,
  getFirstKeyForProvider,
} from '../../src/ai/freeLlmCatalog.js';

const NVIDIA_DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_DEFAULT_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const NVIDIA_DEFAULT_HUD_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';

/** Models that support NVIDIA's reasoning / thinking extension. */
const REASONING_MODELS = new Set([
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'deepseek-ai/deepseek-r1',
  'moonshotai/kimi-k3',
]);

/**
 * Format GEV action tools into OpenAI/NVIDIA Chat Completions tool specification.
 */
export function formatNvidiaTools(tools = GEV_REALTIME_TOOLS) {
  const formatted = tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));

  return formatted;
}

/**
 * Resolve the appropriate API key based on the active base URL and configured
 * provider keys. Uses the FreeLLM catalog as the single source of truth for
 * provider definitions and env-var names. Supports dedicated keys
 * (REQUESTY_API_KEY, GROQ_API_KEY, GEMINI_API_KEY, etc.) while falling back
 * to NVIDIA_API_KEY.
 */
export function resolveEffectiveAiKey(bodyKey = null) {
  if (bodyKey) return String(bodyKey).split(',')[0].trim();
  const env = process.env;
  const baseUrl = (env.NVIDIA_BASE_URL || '').toLowerCase();

  // Check NVIDIA_API_KEY for third-party keys by prefix FIRST — a key
  // prefix (gsk_, rqsty-, etc.) takes precedence over the base URL.
  const nvidiaKey = env.NVIDIA_API_KEY || '';
  if (nvidiaKey) {
    const keyPrefix = nvidiaKey.trim().split(',')[0];
    const provider = detectProviderFromKey(keyPrefix);
    if (provider && provider.id !== 'nvidia') {
      return keyPrefix;
    }
  }

  // Walk the catalog providers in declaration order and return the first
  // key whose base URL matches the configured NVIDIA_BASE_URL.
  for (const provider of FREE_LLM_PROVIDERS) {
    if (provider.baseUrl && baseUrl.includes(provider.baseUrl.toLowerCase())) {
      // Keyless providers (e.g. local FreeLLM) don't need a key.
      if (provider.keyless) return '';
      const key = getFirstKeyForProvider(provider.id, env);
      if (key) return key;
    }
  }

  // Fall back to the native NVIDIA key.
  const defaultKey = env.NVIDIA_API_KEY;
  return defaultKey ? defaultKey.split(',')[0].trim() : null;
}

function normalizeModelForProvider(providerName, requestedModel) {
  let req = String(requestedModel || '').trim();
  if (req.includes('/')) {
    const slash = req.indexOf('/');
    const prefix = req.slice(0, slash).toLowerCase();
    if (
      [
        'groq',
        'gemini',
        'mistral',
        'cerebras',
        'cohere',
        'sambanova',
        'together',
        'openrouter',
        'aion',
        'zhipu',
        'cloudflare',
      ].includes(prefix)
    ) {
      req = req.slice(slash + 1);
    }
  }
  const isMeta =
    !req ||
    req === 'auto' ||
    req === 'router' ||
    req === 'council' ||
    req === 'ensemble' ||
    req === 'swarm';

  switch (providerName) {
    case 'Google Gemini':
      if (
        !isMeta &&
        req.toLowerCase().includes('gemini') &&
        !req.includes('2.5') &&
        !req.includes('2.0')
      )
        return req;
      return 'gemini-3.6-flash';

    case 'Groq Cloud':
      if (
        !isMeta &&
        (req.includes('qwen') ||
          req.includes('gpt-oss') ||
          req.includes('llama') ||
          req.includes('compound') ||
          req.includes('deepseek'))
      )
        return req;
      return 'openai/gpt-oss-120b';

    case 'Cerebras':
      if (
        !isMeta &&
        (req.includes('gpt-oss') ||
          req.includes('qwen') ||
          req.includes('llama') ||
          req.includes('deepseek'))
      )
        return req;
      return 'gpt-oss-120b';

    case 'Cohere':
      if (
        !isMeta &&
        (req.includes('command-r') ||
          req.includes('cohere') ||
          req.includes('aya'))
      )
        return req;
      return 'command-r-plus-08-2024';

    case 'Mistral AI':
      if (
        !isMeta &&
        (req.includes('mistral') ||
          req.includes('codestral') ||
          req.includes('pixtral') ||
          req.includes('ministral'))
      )
        return req;
      return 'mistral-small-latest';

    case 'NVIDIA NIM':
      if (
        !isMeta &&
        (req.startsWith('nvidia/') ||
          req.startsWith('meta/') ||
          req.startsWith('deepseek-ai/') ||
          req.startsWith('mistralai/') ||
          req.startsWith('qwen/') ||
          req.startsWith('moonshotai/') ||
          req.startsWith('openai/'))
      ) {
        return req;
      }
      return 'nvidia/nemotron-3.5-lightning-30b-a3b';

    case 'SambaNova':
      if (
        !isMeta &&
        (req.includes('Llama') ||
          req.includes('Qwen') ||
          req.includes('DeepSeek'))
      )
        return req;
      return 'Meta-Llama-3.3-70B-Instruct';

    case 'OpenRouter':
      if (!isMeta && (req.includes('/') || req.includes(':free'))) return req;
      return 'openrouter/auto';

    case 'Together AI':
      if (
        !isMeta &&
        (req.includes('Llama') ||
          req.includes('together') ||
          req.includes('Qwen') ||
          req.includes('DeepSeek'))
      )
        return req;
      return 'meta-llama/Llama-3.3-70B-Instruct-Turbo';

    case 'AionLabs':
      if (!isMeta && req.includes('aion')) return req;
      return 'aion-3.0';

    case 'Zhipu (GLM)':
      if (!isMeta && (req.includes('glm') || req.includes('zhipu'))) return req;
      return 'glm-4-flash';

    case 'Cloudflare':
      if (!isMeta && req.startsWith('@cf/')) return req;
      return '@cf/meta/llama-3.3-70b-instruct';

    default:
      if (!isMeta) return req;
      return 'nvidia/nemotron-3.5-lightning-30b-a3b';
  }
}

/**
 * Return ordered candidate providers for inference execution with automatic failover.
 * Allows diff providers to work independently (when targeted by model/provider) or simultaneously (in swarm).
 */
export function getProviderCandidates(
  requestedModel = null,
  preferredProvider = null,
) {
  const candidates = [];
  const env = process.env;
  let reqClean = String(requestedModel || '').trim();
  let explicitProvider = preferredProvider
    ? String(preferredProvider).toLowerCase()
    : null;

  // Detect provider prefix e.g. "groq/openai/gpt-oss-20b"
  if (reqClean.includes('/')) {
    const slash = reqClean.indexOf('/');
    const prefix = reqClean.slice(0, slash).toLowerCase();
    if (
      [
        'groq',
        'gemini',
        'mistral',
        'cerebras',
        'cohere',
        'sambanova',
        'together',
        'openrouter',
        'aion',
        'zhipu',
        'cloudflare',
        'nvidia',
      ].includes(prefix)
    ) {
      if (!explicitProvider) explicitProvider = prefix;
      reqClean = reqClean.slice(slash + 1);
    }
  }

  const reqLower = reqClean.toLowerCase();
  const isMeta =
    !reqClean ||
    reqClean === 'auto' ||
    reqClean === 'router' ||
    reqClean === 'council' ||
    reqClean === 'ensemble' ||
    reqClean === 'swarm';

  const addCandidate = (name, baseUrl, key, model, isNvidia = false) => {
    if (!key || candidates.some((c) => c.name === name)) return;
    candidates.push({
      name,
      baseUrl,
      key: String(key).split(',')[0].trim(),
      model: normalizeModelForProvider(name, model),
      isNvidia,
    });
  };

  // 1. Explicit Preferred Provider (if specified)
  if (explicitProvider) {
    if (explicitProvider.includes('gemini') && env.GEMINI_API_KEY) {
      addCandidate(
        'Google Gemini',
        'https://generativelanguage.googleapis.com/v1beta/openai',
        env.GEMINI_API_KEY,
        reqClean,
      );
    } else if (explicitProvider.includes('groq') && env.GROQ_API_KEY) {
      addCandidate(
        'Groq Cloud',
        'https://api.groq.com/openai/v1',
        env.GROQ_API_KEY,
        reqClean,
      );
    } else if (explicitProvider.includes('cerebras') && env.CEREBRAS_API_KEY) {
      addCandidate(
        'Cerebras',
        'https://api.cerebras.ai/v1',
        env.CEREBRAS_API_KEY,
        reqClean,
      );
    } else if (explicitProvider.includes('mistral') && env.MISTRAL_API_KEY) {
      addCandidate(
        'Mistral AI',
        'https://api.mistral.ai/v1',
        env.MISTRAL_API_KEY,
        reqClean,
      );
    } else if (explicitProvider.includes('cohere') && env.COHERE_API_KEY) {
      addCandidate(
        'Cohere',
        'https://api.cohere.com/v2',
        env.COHERE_API_KEY,
        reqClean,
      );
    } else if (
      explicitProvider.includes('sambanova') &&
      env.SAMBANOVA_API_KEY
    ) {
      addCandidate(
        'SambaNova',
        'https://api.sambanova.ai/v1',
        env.SAMBANOVA_API_KEY,
        reqClean,
      );
    } else if (explicitProvider.includes('together') && env.TOGETHER_API_KEY) {
      addCandidate(
        'Together AI',
        'https://api.together.xyz/v1',
        env.TOGETHER_API_KEY,
        reqClean,
      );
    } else if (
      explicitProvider.includes('openrouter') &&
      env.OPENROUTER_API_KEY
    ) {
      addCandidate(
        'OpenRouter',
        'https://openrouter.ai/api/v1',
        env.OPENROUTER_API_KEY,
        reqClean,
      );
    } else if (explicitProvider.includes('aion') && env.AION_API_KEY) {
      addCandidate(
        'AionLabs',
        'https://api.aionlabs.ai/v1',
        env.AION_API_KEY,
        reqClean,
      );
    } else if (explicitProvider.includes('zhipu') && env.ZHIPU_API_KEY) {
      addCandidate(
        'Zhipu (GLM)',
        'https://open.bigmodel.cn/api/paas/v4',
        env.ZHIPU_API_KEY,
        reqClean,
      );
    } else if (
      explicitProvider.includes('cloudflare') &&
      env.CLOUDFLARE_API_KEY
    ) {
      addCandidate(
        'Cloudflare',
        'https://api.cloudflare.com/client/v4/accounts/ai/v1',
        env.CLOUDFLARE_API_KEY,
        reqClean,
      );
    } else if (explicitProvider.includes('nvidia') && env.NVIDIA_API_KEY) {
      addCandidate(
        'NVIDIA NIM',
        'https://integrate.api.nvidia.com/v1',
        env.NVIDIA_API_KEY,
        reqClean,
        true,
      );
    }
  }

  // 2. Exact Model Matching to Destination Provider
  if (!isMeta) {
    if (reqLower.includes('gemini') && env.GEMINI_API_KEY) {
      addCandidate(
        'Google Gemini',
        'https://generativelanguage.googleapis.com/v1beta/openai',
        env.GEMINI_API_KEY,
        reqClean,
      );
    } else if (
      (reqLower.includes('groq') ||
        reqLower.includes('qwen3.8') ||
        reqLower.includes('compound') ||
        (reqLower.includes('gpt-oss-20b') && env.GROQ_API_KEY)) &&
      env.GROQ_API_KEY
    ) {
      addCandidate(
        'Groq Cloud',
        'https://api.groq.com/openai/v1',
        env.GROQ_API_KEY,
        reqClean,
      );
    } else if (
      (reqLower.includes('cerebras') ||
        (reqLower.includes('120b') && env.CEREBRAS_API_KEY)) &&
      env.CEREBRAS_API_KEY
    ) {
      addCandidate(
        'Cerebras',
        'https://api.cerebras.ai/v1',
        env.CEREBRAS_API_KEY,
        reqClean,
      );
    } else if (
      (reqLower.includes('codestral') ||
        reqLower.includes('mistral') ||
        reqLower.includes('pixtral') ||
        reqLower.includes('ministral')) &&
      env.MISTRAL_API_KEY
    ) {
      addCandidate(
        'Mistral AI',
        'https://api.mistral.ai/v1',
        env.MISTRAL_API_KEY,
        reqClean,
      );
    } else if (
      (reqLower.includes('command-r') ||
        reqLower.includes('cohere') ||
        reqLower.includes('aya')) &&
      env.COHERE_API_KEY
    ) {
      addCandidate(
        'Cohere',
        'https://api.cohere.com/v2',
        env.COHERE_API_KEY,
        reqClean,
      );
    } else if (
      (reqLower.includes('sambanova') ||
        (reqClean.includes('Meta-Llama') && env.SAMBANOVA_API_KEY)) &&
      env.SAMBANOVA_API_KEY
    ) {
      addCandidate(
        'SambaNova',
        'https://api.sambanova.ai/v1',
        env.SAMBANOVA_API_KEY,
        reqClean,
      );
    } else if (reqLower.includes('together') && env.TOGETHER_API_KEY) {
      addCandidate(
        'Together AI',
        'https://api.together.xyz/v1',
        env.TOGETHER_API_KEY,
        reqClean,
      );
    } else if (
      (reqLower.includes(':free') || reqLower.includes('openrouter')) &&
      env.OPENROUTER_API_KEY
    ) {
      addCandidate(
        'OpenRouter',
        'https://openrouter.ai/api/v1',
        env.OPENROUTER_API_KEY,
        reqClean,
      );
    } else if (reqLower.includes('aion') && env.AION_API_KEY) {
      addCandidate(
        'AionLabs',
        'https://api.aionlabs.ai/v1',
        env.AION_API_KEY,
        reqClean,
      );
    } else if (
      (reqLower.includes('glm') || reqLower.includes('zhipu')) &&
      env.ZHIPU_API_KEY
    ) {
      addCandidate(
        'Zhipu (GLM)',
        'https://open.bigmodel.cn/api/paas/v4',
        env.ZHIPU_API_KEY,
        reqClean,
      );
    } else if (reqLower.startsWith('@cf/') && env.CLOUDFLARE_API_KEY) {
      addCandidate(
        'Cloudflare',
        'https://api.cloudflare.com/client/v4/accounts/ai/v1',
        env.CLOUDFLARE_API_KEY,
        reqClean,
      );
    } else if (
      (reqLower.includes('nemotron') || reqLower.startsWith('nvidia/')) &&
      env.NVIDIA_API_KEY
    ) {
      addCandidate(
        'NVIDIA NIM',
        'https://integrate.api.nvidia.com/v1',
        env.NVIDIA_API_KEY,
        reqClean,
        true,
      );
    }
  }

  // 3. Active configured provider from .env as next priority
  const currentBaseUrl =
    env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
  const effectiveKey = resolveEffectiveAiKey();
  if (effectiveKey) {
    const isNvidia = currentBaseUrl.includes('nvidia.com');
    const providerName = isNvidia ? 'NVIDIA NIM' : 'Active Provider';
    addCandidate(
      providerName,
      currentBaseUrl,
      effectiveKey,
      reqClean || env.NVIDIA_MODEL,
      isNvidia,
    );
  }

  // 4. All other configured providers added as verified resilient fallbacks (Groq and Gemini prioritized for sub-second tool execution)
  if (env.GROQ_API_KEY)
    addCandidate(
      'Groq Cloud',
      'https://api.groq.com/openai/v1',
      env.GROQ_API_KEY,
      reqClean,
    );
  if (env.GEMINI_API_KEY)
    addCandidate(
      'Google Gemini',
      'https://generativelanguage.googleapis.com/v1beta/openai',
      env.GEMINI_API_KEY,
      reqClean,
    );
  if (env.OPENROUTER_API_KEY)
    addCandidate(
      'OpenRouter',
      'https://openrouter.ai/api/v1',
      env.OPENROUTER_API_KEY,
      reqClean,
    );
  if (env.CEREBRAS_API_KEY)
    addCandidate(
      'Cerebras',
      'https://api.cerebras.ai/v1',
      env.CEREBRAS_API_KEY,
      reqClean,
    );
  if (env.MISTRAL_API_KEY)
    addCandidate(
      'Mistral AI',
      'https://api.mistral.ai/v1',
      env.MISTRAL_API_KEY,
      reqClean,
    );
  if (env.COHERE_API_KEY)
    addCandidate(
      'Cohere',
      'https://api.cohere.com/v2',
      env.COHERE_API_KEY,
      reqClean,
    );
  if (env.NVIDIA_API_KEY)
    addCandidate(
      'NVIDIA NIM',
      'https://integrate.api.nvidia.com/v1',
      env.NVIDIA_API_KEY,
      reqClean,
      true,
    );
  if (env.SAMBANOVA_API_KEY)
    addCandidate(
      'SambaNova',
      'https://api.sambanova.ai/v1',
      env.SAMBANOVA_API_KEY,
      reqClean,
    );
  if (env.TOGETHER_API_KEY)
    addCandidate(
      'Together AI',
      'https://api.together.xyz/v1',
      env.TOGETHER_API_KEY,
      reqClean,
    );
  if (env.AION_API_KEY)
    addCandidate(
      'AionLabs',
      'https://api.aionlabs.ai/v1',
      env.AION_API_KEY,
      reqClean,
    );
  if (env.ZHIPU_API_KEY)
    addCandidate(
      'Zhipu (GLM)',
      'https://open.bigmodel.cn/api/paas/v4',
      env.ZHIPU_API_KEY,
      reqClean,
    );
  if (env.REQUESTY_API_KEY)
    addCandidate(
      'Requesty',
      'https://router.requesty.ai/v1',
      env.REQUESTY_API_KEY,
      reqClean,
    );
  if (env.MANIFEST_API_KEY)
    addCandidate(
      'Manifest Gateway',
      'https://app.manifest.build/v1',
      env.MANIFEST_API_KEY,
      reqClean,
    );

  return candidates;
}

/**
 * Returns swarm member definitions for all configured providers in .env to run simultaneously.
 */
export function getAllActiveSwarmCandidates() {
  const env = process.env;
  const list = [];
  if (env.GROQ_API_KEY) {
    list.push({
      id: 'qwen/qwen3.8-27b',
      name: 'Qwen 27B / Compound',
      provider: 'Groq Cloud',
      emblem: '🚀',
      role: 'Sub-Second LPU Logic & Coding',
      baseUrl: 'https://api.groq.com/openai/v1',
      key: env.GROQ_API_KEY.split(',')[0].trim(),
      model: 'qwen/qwen3.8-27b',
      isNvidia: false,
    });
  }
  if (env.OPENROUTER_API_KEY) {
    list.push({
      id: 'meta-llama/llama-3.3-70b-instruct',
      name: 'Llama 3.3 70B',
      provider: 'OpenRouter',
      emblem: '🌐',
      role: 'Decentralized Open Weights Swarm',
      baseUrl: 'https://openrouter.ai/api/v1',
      key: env.OPENROUTER_API_KEY.split(',')[0].trim(),
      model: 'meta-llama/llama-3.3-70b-instruct',
      isNvidia: false,
    });
  }
  if (env.MISTRAL_API_KEY) {
    list.push({
      id: 'open-mistral-7b',
      name: 'Mistral 7B',
      provider: 'Mistral AI',
      emblem: '🌪️',
      role: 'Sovereign Multilingual Synthesis',
      baseUrl: 'https://api.mistral.ai/v1',
      key: env.MISTRAL_API_KEY.split(',')[0].trim(),
      model: 'open-mistral-7b',
      isNvidia: false,
    });
  }
  if (env.COHERE_API_KEY) {
    list.push({
      id: 'command-r-plus-08-2024',
      name: 'Command R+',
      provider: 'Cohere',
      emblem: '🧠',
      role: 'Enterprise Precision & RAG Citations',
      baseUrl: 'https://api.cohere.com/v2',
      key: env.COHERE_API_KEY.split(',')[0].trim(),
      model: 'command-r-plus-08-2024',
      isNvidia: false,
    });
  }
  if (env.NVIDIA_API_KEY) {
    list.push({
      id: 'meta/llama-3.2-11b-vision-instruct',
      name: 'Llama 3.2 Vision',
      provider: 'NVIDIA NIM',
      emblem: '⚡',
      role: 'Tactical Multimodal Perception',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      key: env.NVIDIA_API_KEY.split(',')[0].trim(),
      model: 'meta/llama-3.2-11b-vision-instruct',
      isNvidia: true,
    });
  }
  if (env.GEMINI_API_KEY) {
    list.push({
      id: 'gemini-3.6-flash',
      name: 'Gemini 3.6 Flash',
      provider: 'Google Gemini',
      emblem: '🟢',
      role: 'Multimodal & 1M+ Context Intelligence',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      key: env.GEMINI_API_KEY.split(',')[0].trim(),
      model: 'gemini-3.6-flash',
      isNvidia: false,
    });
  }
  if (env.CEREBRAS_API_KEY) {
    list.push({
      id: 'gpt-oss-120b',
      name: 'GPT-OSS 120B',
      provider: 'Cerebras',
      emblem: '⚡',
      role: 'Wafer-Scale Ultra Low-Latency Inference',
      baseUrl: 'https://api.cerebras.ai/v1',
      key: env.CEREBRAS_API_KEY.split(',')[0].trim(),
      model: 'gpt-oss-120b',
      isNvidia: false,
    });
  }
  if (env.SAMBANOVA_API_KEY) {
    list.push({
      id: 'Meta-Llama-3.3-70B-Instruct',
      name: 'Llama 3.3 70B',
      provider: 'SambaNova',
      emblem: '⚡',
      role: 'SN40L Dataflow Acceleration',
      baseUrl: 'https://api.sambanova.ai/v1',
      key: env.SAMBANOVA_API_KEY.split(',')[0].trim(),
      model: 'Meta-Llama-3.3-70B-Instruct',
      isNvidia: false,
    });
  }
  if (env.AION_API_KEY) {
    list.push({
      id: 'aion-3.0',
      name: 'Aion 3.0',
      provider: 'AionLabs',
      emblem: '🔮',
      role: '128K Deep Deductive Reasoning',
      baseUrl: 'https://api.aionlabs.ai/v1',
      key: env.AION_API_KEY.split(',')[0].trim(),
      model: 'aion-3.0',
      isNvidia: false,
    });
  }
  if (env.REQUESTY_API_KEY) {
    list.push({
      id: 'openai/gpt-4o-mini',
      name: 'GPT-4o Mini',
      provider: 'Requesty',
      emblem: '⚡',
      role: 'Multi-Router Smart Balancing',
      baseUrl: 'https://router.requesty.ai/v1',
      key: env.REQUESTY_API_KEY.split(',')[0].trim(),
      model: 'openai/gpt-4o-mini',
      isNvidia: false,
    });
  }
  if (env.MANIFEST_API_KEY) {
    list.push({
      id: 'manifest/auto',
      name: 'Manifest Auto Router',
      provider: 'Manifest Gateway',
      emblem: '🦚',
      role: 'Unified Gateway & Multi-Model Router',
      baseUrl: 'https://app.manifest.build/v1',
      key: env.MANIFEST_API_KEY.split(',')[0].trim(),
      model: 'auto',
      isNvidia: false,
    });
  }
  if (env.TOGETHER_API_KEY) {
    list.push({
      id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      name: 'Llama 3.3 70B Turbo',
      provider: 'Together AI',
      emblem: '🤝',
      role: 'High-Throughput Open Source Cluster',
      baseUrl: 'https://api.together.xyz/v1',
      key: env.TOGETHER_API_KEY.split(',')[0].trim(),
      model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      isNvidia: false,
    });
  }
  if (env.ZHIPU_API_KEY) {
    list.push({
      id: 'glm-4-flash',
      name: 'GLM-4 Flash',
      provider: 'Zhipu (GLM)',
      emblem: '🇨🇳',
      role: 'High-Throughput Multilingual Logic',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      key: env.ZHIPU_API_KEY.split(',')[0].trim(),
      model: 'glm-4-flash',
      isNvidia: false,
    });
  }
  if (env.CLOUDFLARE_API_KEY) {
    list.push({
      id: '@cf/meta/llama-3.3-70b-instruct',
      name: 'Llama 3.3 70B (Edge)',
      provider: 'Cloudflare Workers AI',
      emblem: '☁️',
      role: 'Serverless Global Edge Inference',
      baseUrl: 'https://api.cloudflare.com/client/v4/accounts/ai/v1',
      key: env.CLOUDFLARE_API_KEY.split(',')[0].trim(),
      model: '@cf/meta/llama-3.3-70b-instruct',
      isNvidia: false,
    });
  }

  // If only 1 provider is configured, build a diverse 3-specialist council using models available on that provider
  if (list.length === 1) {
    const single = list[0];
    if (single.provider === 'NVIDIA NIM') {
      return [
        {
          id: 'nvidia/nemotron-3.5-lightning-30b-a3b',
          name: 'Nemotron 3.5',
          provider: 'NVIDIA NIM',
          emblem: '⚡',
          role: 'Tactical Fast Reasoning',
          baseUrl: single.baseUrl,
          key: single.key,
          model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
          isNvidia: true,
        },
        {
          id: 'meta/llama-3.3-70b-instruct',
          name: 'Llama 3.3 70B',
          provider: 'NVIDIA NIM',
          emblem: '🧠',
          role: 'Deep Knowledge & Code',
          baseUrl: single.baseUrl,
          key: single.key,
          model: 'meta/llama-3.3-70b-instruct',
          isNvidia: true,
        },
        {
          id: 'deepseek-ai/deepseek-r1',
          name: 'DeepSeek R1',
          provider: 'NVIDIA NIM',
          emblem: '🔮',
          role: 'Chain-of-Thought Logic',
          baseUrl: single.baseUrl,
          key: single.key,
          model: 'deepseek-ai/deepseek-r1',
          isNvidia: true,
        },
      ];
    }
    if (single.provider === 'Google Gemini') {
      return [
        {
          id: 'gemini-2.5-flash',
          name: 'Gemini 2.5 Flash',
          provider: 'Google Gemini',
          emblem: '⚡',
          role: 'Fast Multimodal Reasoning',
          baseUrl: single.baseUrl,
          key: single.key,
          model: 'gemini-2.5-flash',
          isNvidia: false,
        },
        {
          id: 'gemini-1.5-pro',
          name: 'Gemini 1.5 Pro',
          provider: 'Google Gemini',
          emblem: '🧠',
          role: 'Deep Analysis & 1M Context',
          baseUrl: single.baseUrl,
          key: single.key,
          model: 'gemini-1.5-pro',
          isNvidia: false,
        },
        {
          id: 'gemini-1.5-flash',
          name: 'Gemini 1.5 Flash',
          provider: 'Google Gemini',
          emblem: '🚀',
          role: 'Rapid Verification',
          baseUrl: single.baseUrl,
          key: single.key,
          model: 'gemini-1.5-flash',
          isNvidia: false,
        },
      ];
    }
    if (single.provider === 'Groq Cloud') {
      return [
        {
          id: 'qwen/qwen3.8-27b',
          name: 'Qwen 3.8 27B',
          provider: 'Groq Cloud',
          emblem: '⚡',
          role: 'Ultra-Fast Logic',
          baseUrl: single.baseUrl,
          key: single.key,
          model: 'qwen/qwen3.8-27b',
          isNvidia: false,
        },
        {
          id: 'llama-3.3-70b-versatile',
          name: 'Llama 3.3 70B',
          provider: 'Groq Cloud',
          emblem: '🧠',
          role: 'Deep Knowledge & Code',
          baseUrl: single.baseUrl,
          key: single.key,
          model: 'llama-3.3-70b-versatile',
          isNvidia: false,
        },
        {
          id: 'openai/gpt-oss-20b',
          name: 'GPT-OSS 20B',
          provider: 'Groq Cloud',
          emblem: '🚀',
          role: 'High-Throughput Reasoning',
          baseUrl: single.baseUrl,
          key: single.key,
          model: 'openai/gpt-oss-20b',
          isNvidia: false,
        },
      ];
    }
  }

  // If no specific provider matched but an active key exists, create a default council
  if (list.length === 0) {
    const activeKey = resolveEffectiveAiKey();
    if (activeKey) {
      const baseUrl =
        env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
      const isNvidia = baseUrl.includes('nvidia.com');
      return [
        {
          id: 'primary',
          name: isNvidia ? 'Nemotron 3.5' : 'Active Model',
          provider: isNvidia ? 'NVIDIA NIM' : 'Active Provider',
          emblem: '⚡',
          role: 'Primary Tactical Reasoning',
          baseUrl,
          key: activeKey,
          model: isNvidia
            ? 'nvidia/nemotron-3.5-lightning-30b-a3b'
            : env.NVIDIA_MODEL || 'auto',
          isNvidia,
        },
      ];
    }
  }

  return list;
}

/**
 * Query AI provider for the 5-word intelligence HUD summary with multi-provider failover.
 */
export async function queryNvidiaHudSummary(context, apiKey = null) {
  const candidates = getProviderCandidates(process.env.NVIDIA_HUD_MODEL);
  if (candidates.length === 0) return null;

  for (const candidate of candidates) {
    try {
      const body = {
        model: candidate.model,
        messages: [
          {
            role: 'system',
            content: [
              "Write one concise intelligence-HUD summary for God's Eye View.",
              'Use only the supplied place, street, nearby-place, and enabled-layer text labels.',
              'Prefer the clearest named place and include a relevant enabled layer only when useful.',
              'Do not infer from coordinates or invent a place.',
              'Output exactly five words with no title, punctuation, markdown, or introductory phrase.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify(context),
          },
        ],
        temperature: 0.2,
        max_tokens: 30,
      };
      if (candidate.isNvidia) {
        body.chat_template_kwargs = { enable_thinking: false };
      }

      const response = await fetch(`${candidate.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${candidate.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) continue;

      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content || '';
      if (text) return text.trim();
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Handle chat completion and tool-calling requests with multi-provider failover.
 */
export async function handleNvidiaChat(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    const rawBody = await readRequestBody(req, 128 * 1024);
    const body = JSON.parse(rawBody || '{}');
    const { messages = [], context = null } = body;

    const candidates = getProviderCandidates(body.model);
    if (candidates.length === 0) {
      res.statusCode = 503;
      res.end(
        JSON.stringify({ error: 'No AI key is configured for any provider' }),
      );
      return;
    }

    const systemPrompt = [
      "You are JARVIS Tactical AI for God's Eye View (GEV), an interactive 3D Cesium geospatial intelligence globe.",
      'You have direct control over the 3D globe camera, geospatial layers, and sensors via function tools.',
      "When the operator gives navigation, camera, visual, or layer commands (e.g. 'Fly to Tokyo Tower', 'Zoom in', 'Tilt camera', 'Show satellites', 'Turn on borders', 'Orbit target'), ALWAYS call the corresponding function tool immediately.",
      'For camera flights to named landmarks, cities, or targets, call `fly_to_location` with `query` or `locationId`.',
      ...(context
        ? [
            `Current Globe & Scene Context:\n${JSON.stringify(context, null, 2)}`,
          ]
        : []),
    ].join('\n\n');

    const fullMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const chatTools = formatNvidiaTools();
    let lastError = null;

    const isSimultaneous =
      body.model === 'council' ||
      body.model === 'swarm' ||
      body.model === 'ensemble' ||
      body.simultaneous === true;

    if (isSimultaneous) {
      const activeSwarm = getAllActiveSwarmCandidates();
      if (activeSwarm.length > 0) {
        const settled = await Promise.allSettled(
          activeSwarm.map(async (member) => {
            const isCohere = (member.baseUrl || '').includes('cohere.com');
            const url = isCohere
              ? `${member.baseUrl.replace(/\/chat\/?$/, '')}/chat`
              : `${member.baseUrl.replace(/\/chat\/completions\/?$/, '')}/chat/completions`;
            const reqBody = {
              model: member.model,
              messages: fullMessages,
              ...(!isCohere ? { tools: chatTools, tool_choice: 'auto' } : {}),
              temperature: 0.2,
              max_tokens: 512,
            };
            if (member.isNvidia) {
              reqBody.chat_template_kwargs = { enable_thinking: false };
            }
            const res = await fetch(url, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${member.key}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://github.com/bilawalsidhu/gods-eye-view',
                'X-Title': "God's Eye View",
              },
              body: JSON.stringify(reqBody),
              signal: AbortSignal.timeout(8000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return {
              ...member,
              data,
            };
          }),
        );
        const fulfilled = settled
          .filter((s) => s.status === 'fulfilled')
          .map((s) => s.value);
        if (fulfilled.length > 0) {
          const allToolCalls = [];
          const seenCalls = new Set();
          for (const item of fulfilled) {
            let calls = item.data?.choices?.[0]?.message?.tool_calls || [];
            if (
              (!calls || calls.length === 0) &&
              item.data?.choices?.[0]?.message?.content
            ) {
              const raw = String(item.data.choices[0].message.content).trim();
              if (raw.startsWith('{') && raw.endsWith('}')) {
                try {
                  const p = JSON.parse(raw);
                  if (Array.isArray(p.tool_calls)) calls = p.tool_calls;
                  else if (p.name && (p.arguments || p.parameters)) {
                    calls = [
                      {
                        function: {
                          name: p.name,
                          arguments:
                            typeof p.arguments === 'string'
                              ? p.arguments
                              : JSON.stringify(
                                  p.arguments || p.parameters || {},
                                ),
                        },
                      },
                    ];
                  }
                } catch {}
              }
            }
            for (const call of calls) {
              const sig = `${call.function?.name}:${typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments || {})}`;
              if (!seenCalls.has(sig)) {
                seenCalls.add(sig);
                allToolCalls.push(call);
              }
            }
          }
          const primaryContent =
            fulfilled.find((f) => f.data?.choices?.[0]?.message?.content)?.data
              ?.choices?.[0]?.message?.content ||
            (allToolCalls.length > 0
              ? `Executed simultaneous swarm globe actions: ${allToolCalls.map((t) => t.function?.name).join(', ')}`
              : 'Swarm evaluation completed.');

          res.end(
            JSON.stringify({
              ok: true,
              collaborationMode: 'swarm',
              simultaneousCount: fulfilled.length,
              candidates: fulfilled.map((f) => ({
                provider: f.provider,
                model: f.model,
                emblem: f.emblem,
                content: f.data?.choices?.[0]?.message?.content || null,
                tool_calls: f.data?.choices?.[0]?.message?.tool_calls || [],
              })),
              message: {
                role: 'assistant',
                content: primaryContent,
                tool_calls: allToolCalls,
              },
            }),
          );
          return;
        }
      }
    }

    for (const candidate of candidates) {
      try {
        const isCohere = (candidate.baseUrl || '').includes('cohere.com');
        const url = isCohere
          ? `${candidate.baseUrl.replace(/\/chat\/?$/, '')}/chat`
          : `${candidate.baseUrl.replace(/\/chat\/completions\/?$/, '')}/chat/completions`;

        const reqBody = {
          model: candidate.model,
          messages: fullMessages,
          ...(!isCohere ? { tools: chatTools, tool_choice: 'auto' } : {}),
          temperature: 0.1,
          max_tokens: 512,
        };
        if (candidate.isNvidia) {
          reqBody.chat_template_kwargs = { enable_thinking: false };
        }

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${candidate.key}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/bilawalsidhu/gods-eye-view',
            'X-Title': "God's Eye View",
          },
          body: JSON.stringify(reqBody),
          signal: AbortSignal.timeout(4000),
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          lastError = `${candidate.name} error (${response.status}): ${errText}`;
          continue;
        }

        const data = await response.json();
        let content = isCohere
          ? data?.message?.content?.[0]?.text || ''
          : data?.choices?.[0]?.message?.content || '';
        let tool_calls = !isCohere
          ? data?.choices?.[0]?.message?.tool_calls || []
          : [];

        if (
          (!tool_calls || tool_calls.length === 0) &&
          content &&
          typeof content === 'string'
        ) {
          const trimmed = content.trim();
          if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
              const parsed = JSON.parse(trimmed);
              if (Array.isArray(parsed.tool_calls)) {
                tool_calls = parsed.tool_calls;
                content = '';
              } else if (
                parsed.name &&
                (parsed.arguments || parsed.parameters)
              ) {
                tool_calls = [
                  {
                    id: `call_${Date.now()}`,
                    type: 'function',
                    function: {
                      name: parsed.name,
                      arguments:
                        typeof parsed.arguments === 'string'
                          ? parsed.arguments
                          : JSON.stringify(
                              parsed.arguments || parsed.parameters || {},
                            ),
                    },
                  },
                ];
                content = '';
              } else if (parsed.function?.name) {
                tool_calls = [parsed];
                content = '';
              }
            } catch {}
          } else {
            const flyMatch = trimmed.match(
              /\bfly_to_location\b(?:.*?query[:=\s]+["']?([^"',.\n]+)["']?)?/i,
            );
            if (flyMatch) {
              const q = flyMatch[1]?.trim() || 'Tokyo Tower';
              tool_calls = [
                {
                  id: `call_${Date.now()}`,
                  type: 'function',
                  function: {
                    name: 'fly_to_location',
                    arguments: JSON.stringify({ query: q }),
                  },
                },
              ];
            }
          }
        }

        res.statusCode = 200;
        res.end(
          JSON.stringify({
            ok: true,
            model: candidate.model,
            provider: candidate.name,
            message: {
              role: 'assistant',
              content,
              tool_calls,
            },
          }),
        );
        return;
      } catch (err) {
        lastError = err.message;
        continue;
      }
    }

    res.statusCode = 502;
    res.end(
      JSON.stringify({
        error: lastError || 'All AI inference providers failed',
      }),
    );
  } catch (error) {
    res.statusCode = 500;
    res.end(
      JSON.stringify({ error: error.message || 'Internal server error' }),
    );
  }
}

/**
 * Return provider status and configuration details for the frontend.
 */
export function handleNvidiaStatus(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const apiKey = resolveEffectiveAiKey();
  const baseUrl = process.env.NVIDIA_BASE_URL || NVIDIA_DEFAULT_BASE_URL;
  const env = process.env;
  const activeProviders = [];
  if (env.NVIDIA_API_KEY) activeProviders.push('NVIDIA NIM');
  if (env.GEMINI_API_KEY) activeProviders.push('Google Gemini');
  if (env.GROQ_API_KEY) activeProviders.push('Groq Cloud');
  if (env.CEREBRAS_API_KEY) activeProviders.push('Cerebras');
  if (env.MISTRAL_API_KEY) activeProviders.push('Mistral AI');
  if (env.COHERE_API_KEY) activeProviders.push('Cohere');
  if (env.SAMBANOVA_API_KEY) activeProviders.push('SambaNova');
  if (env.TOGETHER_API_KEY) activeProviders.push('Together AI');
  if (env.OPENROUTER_API_KEY) activeProviders.push('OpenRouter');
  if (env.AION_API_KEY) activeProviders.push('AionLabs');
  if (env.ZHIPU_API_KEY) activeProviders.push('Zhipu (GLM)');
  if (env.CLOUDFLARE_API_KEY) activeProviders.push('Cloudflare');
  if (env.REQUESTY_API_KEY) activeProviders.push('Requesty');
  if (env.MANIFEST_API_KEY) activeProviders.push('Manifest Gateway');

  res.statusCode = 200;
  res.end(
    JSON.stringify({
      configured: Boolean(
        (apiKey && apiKey.trim().length > 0) || activeProviders.length > 0,
      ),
      baseUrl,
      model: process.env.NVIDIA_MODEL || NVIDIA_DEFAULT_MODEL,
      hudModel: process.env.NVIDIA_HUD_MODEL || NVIDIA_DEFAULT_HUD_MODEL,
      activeProviders,
      multiProviderReady: activeProviders.length > 1,
      swarmCount: activeProviders.length,
    }),
  );
}

/**
 * Return list of popular supported models across categories.
 */
export function handleNvidiaModels(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  res.statusCode = 200;
  res.end(
    JSON.stringify({
      ok: true,
      models: [
        {
          id: 'auto',
          label: '🎯 Auto-MoE (Intelligent Dynamic Router)',
          category: 'auto',
        },
        {
          id: 'ensemble',
          label: '👥 Council of Models (Multi-Model Swarm)',
          category: 'ensemble',
        },
        {
          id: 'nvidia/nemotron-3.5-lightning-30b-a3b',
          label: 'Nemotron 3.5 Lightning (Fast)',
          category: 'tactical',
        },
        {
          id: 'nvidia/nemotron-3-ultra-550b-a55b',
          label: 'Nemotron 550B Ultra (Deep Reasoning)',
          category: 'reasoning',
        },
        {
          id: 'deepseek-ai/deepseek-r1',
          label: 'DeepSeek R1 (Thinking Trace)',
          category: 'reasoning',
        },
        {
          id: 'meta/llama-3.3-70b-instruct',
          label: 'Llama 3.3 70B Instruct',
          category: 'tactical',
        },
        {
          id: 'meta/llama-3.2-11b-vision-instruct',
          label: 'Llama 3.2 Vision (11B Multimodal)',
          category: 'vision',
        },
        {
          id: 'openai/gpt-oss-20b',
          label: 'GPT-OSS 20B (Code & Math)',
          category: 'code',
        },
        {
          id: 'mistralai/mistral-nemotron',
          label: 'Mistral-Nemotron (Multilingual)',
          category: 'global',
        },
        {
          id: 'moonshotai/kimi-k3',
          label: 'Kimi K3 (200K Long Context)',
          category: 'global',
        },
        {
          id: 'stabilityai/stable-diffusion-3-medium',
          label: 'Stable Diffusion 3 Medium',
          category: 'genai',
        },
        {
          id: 'black-forest-labs/flux-1-schnell',
          label: 'Flux.1 Schnell',
          category: 'genai',
        },
      ],
    }),
  );
}

/**
 * Vite plugin for NVIDIA NIM proxy.
 */
export function nvidiaProxy() {
  function install(middlewares) {
    middlewares.use('/api/nvidia/chat', handleNvidiaChat);
    middlewares.use('/api/nvidia/status', handleNvidiaStatus);
    middlewares.use('/api/nvidia/models', handleNvidiaModels);
    middlewares.use('/api/nvidia/assistant', handleNvidiaAssistant);
    middlewares.use('/api/nvidia/research', handleNvidiaResearch);
    middlewares.use('/api/nvidia/genai/image', handleNvidiaGenAiImage);
    middlewares.use('/api/nvidia/vision/analyze', handleNvidiaVisionAnalyze);
  }

  return {
    name: 'nvidia-nim-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { jarvisToolsProxy };
