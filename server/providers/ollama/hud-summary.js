import { readRequestBody } from '../common/request.js';
import { toFiveWordHudSummary } from '../openai/hud-summary.js';
import {
  ollamaBaseUrl,
  ollamaRequestDefaults,
  modelSupportsThinking,
} from './chat.js';

const SYSTEM_PROMPT = [
  "Write one concise intelligence-HUD summary for God's Eye View.",
  'Use only the supplied place, street, nearby-place, and enabled-layer text labels.',
  'Prefer the clearest named place and include a relevant enabled layer only when useful.',
  'Do not infer from coordinates or invent a place.',
  'Output exactly five words with no title, punctuation, markdown, or introductory phrase.',
].join(' ');

function hudModel() {
  return (
    process.env.OLLAMA_HUD_MODEL || process.env.OLLAMA_VOICE_MODEL || 'qwen3:8b'
  );
}

/**
 * Five-word HUD summary through the local model. The upstream request is
 * aborted when the browser gives up, so an abandoned summary never queues
 * ahead of a voice turn on the shared GPU.
 */
export async function handleHudSummary(req, res, { fetchImpl = fetch } = {}) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }
  const abort = new AbortController();
  // IncomingMessage 'close' fires once the body is consumed on modern Node, so
  // watch the response: it closes early only when the client went away.
  const onClose = () => {
    if (!res.writableEnded) abort.abort();
  };
  res.on?.('close', onClose);
  const timer = setTimeout(() => abort.abort(), 30_000);
  try {
    const context = JSON.parse((await readRequestBody(req, 64 * 1024)) || '{}');
    const model = hudModel();
    const baseUrl = ollamaBaseUrl();
    const thinking = await modelSupportsThinking(model, { fetchImpl, baseUrl });
    const response = await fetchImpl(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: ollamaRequestDefaults().keep_alive,
        // Same num_ctx as voice turns: a different context size makes Ollama
        // reload the model, which cost a warm voice turn ~10 s.
        options: {
          num_predict: 32,
          num_ctx: ollamaRequestDefaults().num_ctx,
          temperature: 0.2,
        },
        ...(thinking ? { think: false } : {}),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(context) },
        ],
      }),
      signal: abort.signal,
    });
    const data = await response.json().catch(() => ({}));
    const summary = toFiveWordHudSummary(data?.message?.content);
    res.statusCode = response.ok && summary ? 200 : response.status || 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify({
        summary: summary || null,
        error: response.ok ? null : 'Ollama HUD summary request failed',
      }),
    );
  } catch (error) {
    if (res.writableEnded) return;
    res.statusCode = abort.signal.aborted ? 499 : 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: abort.signal.aborted
          ? 'HUD summary cancelled'
          : error?.message || 'Ollama HUD summary request failed',
      }),
    );
  } finally {
    clearTimeout(timer);
    res.off?.('close', onClose);
  }
}

export { ollamaBaseUrl };
