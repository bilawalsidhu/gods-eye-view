import { readRequestBody } from './common/request.js';
import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getNextApiKey } from './nvidia-assistant.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const GENERATED_DIR = resolve(__dirname, '../../public/generated');

const DEFAULT_GENAI_MODEL = 'stabilityai/stable-diffusion-3-medium';
const NVIDIA_DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';

/** Ensure output directory exists */
async function ensureDir() {
  await fs.mkdir(GENERATED_DIR, { recursive: true });
}

/**
 * Generate image via NVIDIA NIM / OpenAI-compatible image generation API.
 */
export async function generateImage({
  prompt,
  model = DEFAULT_GENAI_MODEL,
  aspectRatio = '1:1',
  negativePrompt = '',
  apiKey = null,
  baseUrl = NVIDIA_DEFAULT_BASE_URL,
} = {}) {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('Prompt is required for image generation');
  }

  await ensureDir();
  const resolvedKey = getNextApiKey(apiKey);
  if (!resolvedKey) {
    throw new Error('NVIDIA_API_KEY is not configured');
  }

  const endpoint = `${baseUrl}/images/generations`;

  let response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resolvedKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      response_format: 'b64_json',
      aspect_ratio: aspectRatio,
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
    }),
  });

  // If standard endpoint returns 404 or unsupported, try genai route
  if (!response.ok && (response.status === 404 || response.status === 400)) {
    const genaiEndpoint = `${baseUrl}/genai/${model}`;
    response = await fetch(genaiEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resolvedKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        mode: 'text-to-image',
        aspect_ratio: aspectRatio,
      }),
    });
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Image generation failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const b64 =
    data?.data?.[0]?.b64_json ||
    data?.artifacts?.[0]?.base64 ||
    data?.image ||
    null;

  if (!b64) {
    // Might have returned a URL directly
    const directUrl = data?.data?.[0]?.url || data?.image_url;
    if (directUrl) {
      return {
        ok: true,
        imageUrl: directUrl,
        prompt,
        model,
      };
    }
    throw new Error('No image payload received from generation provider');
  }

  const hash = createHash('md5')
    .update(prompt + Date.now())
    .digest('hex')
    .slice(0, 10);
  const filename = `gen_${hash}.png`;
  const filepath = join(GENERATED_DIR, filename);

  const cleanB64 = b64.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(cleanB64, 'base64');
  await fs.writeFile(filepath, buffer);

  const imageUrl = `/generated/${filename}`;
  return {
    ok: true,
    imageUrl,
    filename,
    prompt,
    model,
    aspectRatio,
  };
}

/**
 * HTTP handler for /api/nvidia/genai/image.
 */
export async function handleNvidiaGenAiImage(req, res) {
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
    const {
      prompt,
      model = DEFAULT_GENAI_MODEL,
      aspect_ratio = '1:1',
      aspectRatio = '1:1',
      negative_prompt = '',
      negativePrompt = '',
      apiKey = null,
    } = body;

    const result = await generateImage({
      prompt,
      model,
      aspectRatio: aspect_ratio || aspectRatio,
      negativePrompt: negative_prompt || negativePrompt,
      apiKey,
      baseUrl: process.env.NVIDIA_BASE_URL || NVIDIA_DEFAULT_BASE_URL,
    });

    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (error) {
    res.statusCode = 500;
    res.end(
      JSON.stringify({
        ok: false,
        error: error.message || 'Image generation failed',
      }),
    );
  }
}
