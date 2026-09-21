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
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/**
 * Resolve the appropriate API key based on the active base URL and configured provider keys.
 * Supports dedicated keys (REQUESTY_API_KEY, GROQ_API_KEY, GEMINI_API_KEY, etc.)
 * while falling back to NVIDIA_API_KEY.
 */
export function resolveEffectiveAiKey(bodyKey = null) {
  if (bodyKey) return String(bodyKey).split(',')[0].trim();
  const baseUrl = (process.env.NVIDIA_BASE_URL || '').toLowerCase();

  if (baseUrl.includes('manifest.build') && process.env.MANIFEST_API_KEY) {
    return process.env.MANIFEST_API_KEY.split(',')[0].trim();
  }
  if (baseUrl.includes('requesty.ai') && process.env.REQUESTY_API_KEY) {
    return process.env.REQUESTY_API_KEY.split(',')[0].trim();
  }
  if (baseUrl.includes('groq.com') && process.env.GROQ_API_KEY) {
    return process.env.GROQ_API_KEY.split(',')[0].trim();
  }
  if (baseUrl.includes('cerebras.ai') && process.env.CEREBRAS_API_KEY) {
    return process.env.CEREBRAS_API_KEY.split(',')[0].trim();
  }
  if (baseUrl.includes('generativelanguage') && process.env.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY.split(',')[0].trim();
  }
  if (baseUrl.includes('mistral.ai') && process.env.MISTRAL_API_KEY) {
    return process.env.MISTRAL_API_KEY.split(',')[0].trim();
  }
  if (baseUrl.includes('cohere.com') && process.env.COHERE_API_KEY) {
    return process.env.COHERE_API_KEY.split(',')[0].trim();
  }
  if (baseUrl.includes('aionlabs.ai') && process.env.AION_API_KEY) {
    return process.env.AION_API_KEY.split(',')[0].trim();
  }
  if (baseUrl.includes('bigmodel.cn') && process.env.ZHIPU_API_KEY) {
    return process.env.ZHIPU_API_KEY.split(',')[0].trim();
  }
  if (baseUrl.includes('sambanova.ai') && process.env.SAMBANOVA_API_KEY) {
    return process.env.SAMBANOVA_API_KEY.split(',')[0].trim();
  }
  if (
    (baseUrl.includes('together.xyz') || baseUrl.includes('together.ai')) &&
    process.env.TOGETHER_API_KEY
  ) {
    return process.env.TOGETHER_API_KEY.split(',')[0].trim();
  }
  if (baseUrl.includes('cloudflare.com') && process.env.CLOUDFLARE_API_KEY) {
    return process.env.CLOUDFLARE_API_KEY.split(',')[0].trim();
  }
  if (baseUrl.includes('openrouter.ai') && process.env.OPENROUTER_API_KEY) {
    return process.env.OPENROUTER_API_KEY.split(',')[0].trim();
  }

  const defaultKey = process.env.NVIDIA_API_KEY;
  return defaultKey ? defaultKey.split(',')[0].trim() : null;
}

/**
 * Return ordered candidate providers for inference execution with automatic failover.
 */
export function getProviderCandidates(requestedModel = null) {
  const candidates = [];
  const env = process.env;
  const reqLower = String(requestedModel || '').toLowerCase();

  // If a specific model was requested, match its provider first
  if (reqLower.includes('gemini') && env.GEMINI_API_KEY) {
    candidates.push({
      name: 'Google Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      key: env.GEMINI_API_KEY.split(',')[0].trim(),
      model: reqLower.includes('3.6')
        ? 'gemini-3.6-flash'
        : requestedModel || 'gemini-3.6-flash',
      isNvidia: false,
    });
  } else if (
    (reqLower.includes('groq') || reqLower.includes('gpt-oss')) &&
    env.GROQ_API_KEY
  ) {
    candidates.push({
      name: 'Groq Cloud',
      baseUrl: 'https://api.groq.com/openai/v1',
      key: env.GROQ_API_KEY.split(',')[0].trim(),
      model: requestedModel || 'openai/gpt-oss-20b',
      isNvidia: false,
    });
  } else if (
    (reqLower.includes('cohere') || reqLower.includes('command-r')) &&
    env.COHERE_API_KEY
  ) {
    candidates.push({
      name: 'Cohere',
      baseUrl: 'https://api.cohere.com/v2',
      key: env.COHERE_API_KEY.split(',')[0].trim(),
      model: requestedModel || 'command-r-plus-08-2024',
      isNvidia: false,
    });
  }

  // Active configured provider from .env
  const currentBaseUrl =
    env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
  const effectiveKey = resolveEffectiveAiKey();
  if (effectiveKey) {
    const isNvidia = currentBaseUrl.includes('nvidia.com');
    candidates.push({
      name: isNvidia ? 'NVIDIA NIM' : 'Active Provider',
      baseUrl: currentBaseUrl,
      key: effectiveKey,
      model:
        requestedModel ||
        env.NVIDIA_MODEL ||
        'nvidia/nemotron-3.5-lightning-30b-a3b',
      isNvidia,
    });
  }

  // Verified Fallback Candidates (Google Gemini -> Groq -> Cohere -> OpenRouter -> NVIDIA)
  if (
    env.GEMINI_API_KEY &&
    !candidates.some((c) => c.name === 'Google Gemini')
  ) {
    candidates.push({
      name: 'Google Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      key: env.GEMINI_API_KEY.split(',')[0].trim(),
      model: 'gemini-3.6-flash',
      isNvidia: false,
    });
  }
  if (env.GROQ_API_KEY && !candidates.some((c) => c.name === 'Groq Cloud')) {
    candidates.push({
      name: 'Groq Cloud',
      baseUrl: 'https://api.groq.com/openai/v1',
      key: env.GROQ_API_KEY.split(',')[0].trim(),
      model: 'qwen/qwen3.8-27b',
      isNvidia: false,
    });
  }
  if (
    env.OPENROUTER_API_KEY &&
    !candidates.some((c) => c.name === 'OpenRouter')
  ) {
    candidates.push({
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      key: env.OPENROUTER_API_KEY.split(',')[0].trim(),
      model: 'meta-llama/llama-3.3-70b-instruct',
      isNvidia: false,
    });
  }
  if (env.MISTRAL_API_KEY && !candidates.some((c) => c.name === 'Mistral AI')) {
    candidates.push({
      name: 'Mistral AI',
      baseUrl: 'https://api.mistral.ai/v1',
      key: env.MISTRAL_API_KEY.split(',')[0].trim(),
      model: 'open-mistral-7b',
      isNvidia: false,
    });
  }
  if (env.COHERE_API_KEY && !candidates.some((c) => c.name === 'Cohere')) {
    candidates.push({
      name: 'Cohere',
      baseUrl: 'https://api.cohere.com/v2',
      key: env.COHERE_API_KEY.split(',')[0].trim(),
      model: 'command-r-plus-08-2024',
      isNvidia: false,
    });
  }
  if (env.NVIDIA_API_KEY && !candidates.some((c) => c.name === 'NVIDIA NIM')) {
    candidates.push({
      name: 'NVIDIA NIM',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      key: env.NVIDIA_API_KEY.split(',')[0].trim(),
      model: 'meta/llama-3.2-11b-vision-instruct',
      isNvidia: true,
    });
  }
  if (env.CEREBRAS_API_KEY && !candidates.some((c) => c.name === 'Cerebras')) {
    candidates.push({
      name: 'Cerebras',
      baseUrl: 'https://api.cerebras.ai/v1',
      key: env.CEREBRAS_API_KEY.split(',')[0].trim(),
      model: 'gpt-oss-120b',
      isNvidia: false,
    });
  }
  if (
    env.SAMBANOVA_API_KEY &&
    !candidates.some((c) => c.name === 'SambaNova')
  ) {
    candidates.push({
      name: 'SambaNova',
      baseUrl: 'https://api.sambanova.ai/v1',
      key: env.SAMBANOVA_API_KEY.split(',')[0].trim(),
      model: 'Meta-Llama-3.3-70B-Instruct',
      isNvidia: false,
    });
  }
  if (env.AION_API_KEY && !candidates.some((c) => c.name === 'AionLabs')) {
    candidates.push({
      name: 'AionLabs',
      baseUrl: 'https://api.aionlabs.ai/v1',
      key: env.AION_API_KEY.split(',')[0].trim(),
      model: 'aion-3.0',
      isNvidia: false,
    });
  }
  if (env.REQUESTY_API_KEY && !candidates.some((c) => c.name === 'Requesty')) {
    candidates.push({
      name: 'Requesty',
      baseUrl: 'https://router.requesty.ai/v1',
      key: env.REQUESTY_API_KEY.split(',')[0].trim(),
      model: 'openai/gpt-4o-mini',
      isNvidia: false,
    });
  }
  if (
    env.TOGETHER_API_KEY &&
    !candidates.some((c) => c.name === 'Together AI')
  ) {
    candidates.push({
      name: 'Together AI',
      baseUrl: 'https://api.together.xyz/v1',
      key: env.TOGETHER_API_KEY.split(',')[0].trim(),
      model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      isNvidia: false,
    });
  }
  if (
    env.MANIFEST_API_KEY &&
    !candidates.some((c) => c.name === 'Manifest Gateway')
  ) {
    candidates.push({
      name: 'Manifest Gateway',
      baseUrl: 'https://app.manifest.build/v1',
      key: env.MANIFEST_API_KEY.split(',')[0].trim(),
      model: 'auto',
      isNvidia: false,
    });
  }

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
      id: 'gemini-2.0-flash',
      name: 'Gemini 2.0 Flash',
      provider: 'Google Gemini',
      emblem: '🟢',
      role: 'Multimodal & 1M+ Context Intelligence',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      key: env.GEMINI_API_KEY.split(',')[0].trim(),
      model: 'gemini-2.0-flash',
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
      ...realtimeInstructions(),
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
          signal: AbortSignal.timeout(7000),
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          lastError = `${candidate.name} error (${response.status}): ${errText}`;
          continue;
        }

        const data = await response.json();
        const content = isCohere
          ? data?.message?.content?.[0]?.text || ''
          : data?.choices?.[0]?.message?.content || '';
        const tool_calls = !isCohere
          ? data?.choices?.[0]?.message?.tool_calls || []
          : [];

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
  res.statusCode = 200;
  res.end(
    JSON.stringify({
      configured: Boolean(apiKey && apiKey.trim().length > 0),
      baseUrl,
      model: process.env.NVIDIA_MODEL || NVIDIA_DEFAULT_MODEL,
      hudModel: process.env.NVIDIA_HUD_MODEL || NVIDIA_DEFAULT_HUD_MODEL,
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
