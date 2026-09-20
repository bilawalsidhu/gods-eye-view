import { readRequestBody } from '../common/request.js';

/**
 * Handle TTS (text-to-speech) speech synthesis requests.
 * Uses TTS_BASE_URL or OPENAI_BASE_URL or defaults to official OpenAI.
 */
export async function handleTts(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  const ttsBaseUrl = (
    process.env.TTS_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    'https://api.openai.com/v1'
  ).replace(/\/+$/, '');
  const model = process.env.TTS_MODEL || 'tts-1';
  const voice = process.env.TTS_VOICE || 'alloy';

  try {
    const body = await readRequestBody(req, 64 * 1024);
    const parsed = JSON.parse(body || '{}');
    const input = String(parsed.text || parsed.input || '').trim();

    if (!input) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Missing text input' }));
      return;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(`${ttsBaseUrl}/audio/speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: parsed.model || model,
        input,
        voice: parsed.voice || voice,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      res.statusCode = response.status || 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `TTS failed: ${err}` }));
      return;
    }

    res.statusCode = 200;
    res.setHeader(
      'Content-Type',
      response.headers.get('content-type') || 'audio/mpeg',
    );
    res.setHeader('Cache-Control', 'no-store');
    const arrayBuffer = await response.arrayBuffer();
    res.end(Buffer.from(arrayBuffer));
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err?.message || 'TTS request failed' }));
  }
}
