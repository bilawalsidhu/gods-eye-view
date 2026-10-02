import { readCappedResponseText } from './common/http.js';
import { makeOptInRateLimiter, clientKey } from './common/rate-limit.js';
import { realtimeInstructions } from './openai/instructions.js';
import { GEV_REALTIME_TOOLS } from './openai/tools.js';
import { toGeminiFunctionDeclarations } from '../../src/voice/geminiTools.js';

export const GEMINI_LIVE_MODEL_DEFAULT = 'gemini-3.8-live';
const GEMINI_API_ORIGIN = 'https://generativelanguage.googleapis.com';
// The token endpoint has moved between API versions; try the current one first.
const GEMINI_TOKEN_API_VERSIONS = Object.freeze(['v1beta', 'v1alpha']);
const TOKEN_SESSION_MS = 30 * 60_000;
const TOKEN_START_MS = 60_000;

let _limiter;
function geminiRateLimiter() {
  if (_limiter === undefined)
    _limiter = makeOptInRateLimiter(process.env.GEV_RATELIMIT_GEMINI_PER_MIN);
  return _limiter;
}

/** The Live setup this server allows: model, voice, instructions and tools. */
export function geminiLiveSetup({
  model = process.env.GEMINI_LIVE_MODEL || GEMINI_LIVE_MODEL_DEFAULT,
  voice = process.env.GEMINI_LIVE_VOICE || '',
  annotationGuidance,
} = {}) {
  return {
    model: model.startsWith('models/') ? model : `models/${model}`,
    generationConfig: {
      responseModalities: ['AUDIO'],
      ...(voice
        ? {
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
            },
          }
        : {}),
    },
    systemInstruction: {
      parts: [{ text: realtimeInstructions(annotationGuidance) }],
    },
    tools: [
      {
        functionDeclarations: toGeminiFunctionDeclarations(GEV_REALTIME_TOOLS),
      },
    ],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** Mint a single-use ephemeral token whose setup is locked server-side. */
export function createGeminiTokenHandler({
  annotationGuidance,
  fetchImpl = (...args) => fetch(...args),
  resolveApiKey = () => process.env.GEMINI_API_KEY,
  now = Date.now,
} = {}) {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const limiter = geminiRateLimiter();
    if (limiter && !limiter(clientKey(req))) {
      res.setHeader('Retry-After', '5');
      sendJson(res, 429, { error: 'Rate limit exceeded' });
      return;
    }
    const apiKey = String(resolveApiKey() || '').trim();
    if (!apiKey) {
      sendJson(res, 503, { error: 'GEMINI_API_KEY is not set' });
      return;
    }
    const setup = geminiLiveSetup({ annotationGuidance });
    const body = JSON.stringify({
      uses: 1,
      expireTime: new Date(now() + TOKEN_SESSION_MS).toISOString(),
      newSessionExpireTime: new Date(now() + TOKEN_START_MS).toISOString(),
      bidiGenerateContentSetup: setup,
    });
    try {
      for (const apiVersion of GEMINI_TOKEN_API_VERSIONS) {
        const response = await fetchImpl(
          `${GEMINI_API_ORIGIN}/${apiVersion}/auth_tokens`,
          {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(20_000),
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey,
            },
            body,
          },
        );
        const { tooLarge, text } = await readCappedResponseText(
          response,
          64_000,
        );
        if (response.status === 404) continue;
        let data = null;
        try {
          data = tooLarge ? null : JSON.parse(text);
        } catch {
          data = null;
        }
        if (!response.ok || typeof data?.name !== 'string' || !data.name) {
          console.warn(`[gemini-token] upstream HTTP ${response.status}`);
          sendJson(res, 502, { error: 'Failed to create Gemini Live token' });
          return;
        }
        res.setHeader('X-GEV-Voice-Provider', 'gemini');
        res.setHeader('X-GEV-Voice-Model', setup.model);
        sendJson(res, 200, {
          token: data.name,
          apiVersion,
          model: setup.model,
          expiresAt: Math.floor((now() + TOKEN_SESSION_MS) / 1000),
          setup,
        });
        return;
      }
      sendJson(res, 502, { error: 'Gemini Live token endpoint not found' });
    } catch {
      console.warn('[gemini-token] mint failed');
      sendJson(res, 502, { error: 'Failed to create Gemini Live token' });
    }
  };
}

/** Vite plugin: Gemini Live ephemeral tokens; GEMINI_API_KEY stays server-side. */
export function geminiLiveProxy({ annotationGuidance, ...options } = {}) {
  function install(middlewares) {
    middlewares.use(
      '/api/gemini/token',
      createGeminiTokenHandler({ annotationGuidance, ...options }),
    );
  }
  return {
    name: 'gemini-live-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
