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
 * Query NVIDIA NIM chat completions API for the 5-word intelligence HUD summary.
 */
export async function queryNvidiaHudSummary(
  context,
  apiKey = process.env.NVIDIA_API_KEY,
) {
  const resolvedKey = apiKey ? apiKey.split(',')[0].trim() : null;
  if (!resolvedKey) return null;
  const baseUrl = process.env.NVIDIA_BASE_URL || NVIDIA_DEFAULT_BASE_URL;
  const model = process.env.NVIDIA_HUD_MODEL || NVIDIA_DEFAULT_HUD_MODEL;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resolvedKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
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
      chat_template_kwargs: { enable_thinking: false },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(
      `NVIDIA HUD summary failed (${response.status}): ${errText}`,
    );
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return text;
}

/**
 * Handle chat completion and tool-calling requests directed to NVIDIA NIM.
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

    const rawKey = body.apiKey || process.env.NVIDIA_API_KEY;
    const apiKey = rawKey ? rawKey.split(',')[0].trim() : null;
    if (!apiKey) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: 'NVIDIA_API_KEY is not configured' }));
      return;
    }

    const baseUrl = process.env.NVIDIA_BASE_URL || NVIDIA_DEFAULT_BASE_URL;
    const model =
      body.model || process.env.NVIDIA_MODEL || NVIDIA_DEFAULT_MODEL;

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

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: fullMessages,
        tools: chatTools,
        tool_choice: 'auto',
        temperature: 0.1,
        max_tokens: 512,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      res.statusCode = response.status || 502;
      res.end(JSON.stringify({ error: `NVIDIA NIM API error: ${errText}` }));
      return;
    }

    const data = await response.json();
    const choice = data?.choices?.[0];
    const message = choice?.message || {};

    res.statusCode = 200;
    res.end(
      JSON.stringify({
        ok: true,
        model,
        message: {
          role: message.role || 'assistant',
          content: message.content || '',
          tool_calls: message.tool_calls || [],
        },
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

  const apiKey = process.env.NVIDIA_API_KEY;
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
        { id: 'auto', label: '🎯 Auto-MoE (Intelligent Dynamic Router)', category: 'auto' },
        { id: 'ensemble', label: '👥 Council of Models (Multi-Model Swarm)', category: 'ensemble' },
        { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', label: 'Nemotron 3.5 Lightning (Fast)', category: 'tactical' },
        { id: 'nvidia/nemotron-3-ultra-550b-a55b', label: 'Nemotron 550B Ultra (Deep Reasoning)', category: 'reasoning' },
        { id: 'deepseek-ai/deepseek-r1', label: 'DeepSeek R1 (Thinking Trace)', category: 'reasoning' },
        { id: 'meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B Instruct', category: 'tactical' },
        { id: 'meta/llama-3.2-11b-vision-instruct', label: 'Llama 3.2 Vision (11B Multimodal)', category: 'vision' },
        { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B (Code & Math)', category: 'code' },
        { id: 'mistralai/mistral-nemotron', label: 'Mistral-Nemotron (Multilingual)', category: 'global' },
        { id: 'moonshotai/kimi-k3', label: 'Kimi K3 (200K Long Context)', category: 'global' },
        { id: 'stabilityai/stable-diffusion-3-medium', label: 'Stable Diffusion 3 Medium', category: 'genai' },
        { id: 'black-forest-labs/flux-1-schnell', label: 'Flux.1 Schnell', category: 'genai' },
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
