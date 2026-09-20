import { readRequestBody } from './common/request.js';
import { getNextApiKey } from './nvidia-assistant.js';

const DEFAULT_VISION_MODEL = 'meta/llama-3.2-11b-vision-instruct';
const NVIDIA_DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';

/**
 * Analyze an image using multimodal LLM (Llama 3.2 Vision, NeVA, etc.)
 */
export async function analyzeImage({
  image,
  prompt = 'Describe this image in detail and identify any notable objects, text, or coordinates.',
  model = DEFAULT_VISION_MODEL,
  apiKey = null,
  baseUrl = NVIDIA_DEFAULT_BASE_URL,
} = {}) {
  if (!image) {
    throw new Error('Image data (URL or base64 data URL) is required');
  }

  const resolvedKey = getNextApiKey(apiKey);
  if (!resolvedKey) {
    throw new Error('NVIDIA_API_KEY is not configured');
  }

  const imageUrl = image.startsWith('data:') || image.startsWith('http')
    ? image
    : `data:image/jpeg;base64,${image}`;

  const payload = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: imageUrl },
          },
        ],
      },
    ],
    max_tokens: 1024,
    temperature: 0.2,
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resolvedKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Vision analysis failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || '';

  return {
    ok: true,
    model,
    prompt,
    analysis: content,
  };
}

/**
 * HTTP handler for /api/nvidia/vision/analyze.
 */
export async function handleNvidiaVisionAnalyze(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    const rawBody = await readRequestBody(req, 10 * 1024 * 1024); // 10MB for base64 image
    const body = JSON.parse(rawBody || '{}');
    const {
      image,
      imageUrl,
      prompt,
      model = DEFAULT_VISION_MODEL,
      apiKey = null,
    } = body;

    const result = await analyzeImage({
      image: image || imageUrl,
      prompt,
      model,
      apiKey,
      baseUrl: process.env.NVIDIA_BASE_URL || NVIDIA_DEFAULT_BASE_URL,
    });

    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: error.message || 'Vision analysis failed' }));
  }
}
