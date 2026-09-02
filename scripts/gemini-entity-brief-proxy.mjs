const DEFAULT_MODEL = 'gemini-3.6-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function makeOptInRateLimiter(envValue) {
  const max = Number(envValue);
  if (!Number.isFinite(max) || max <= 0) return null;
  const hits = new Map();
  const windowMs = 60_000;
  const globalMax = Math.floor(max) * 20;
  const globalTimes = [];
  return (key) => {
    const now = Date.now();
    globalTimes.splice(0, globalTimes.findIndex((t) => now - t < windowMs));
    const recentGlobal = globalTimes.filter((t) => now - t < windowMs);
    if (globalMax && recentGlobal.length >= globalMax) return false;
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= Math.floor(max)) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    globalTimes.push(now);
    return true;
  };
}

let _geminiRateLimiter;

function geminiRateLimiter() {
  if (_geminiRateLimiter === undefined) {
    _geminiRateLimiter = makeOptInRateLimiter(process.env.GEV_RATELIMIT_GEMINI_PER_MIN);
  }
  return _geminiRateLimiter;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

function enforceRateLimit(req, res) {
  const limiter = geminiRateLimiter();
  if (!limiter) return true;
  if (limiter(clientIp(req))) return true;
  res.statusCode = 429;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
  return false;
}

function readRequestBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const ENTITY_BRIEF_MAX_BYTES = 2 * 1024 * 1024;

function keylessGeminiBriefResponse(apiKey) {
  if (String(apiKey ?? '').trim()) return null;
  return {
    statusCode: 200,
    payload: {
      configured: false,
      code: 'GEMINI_NOT_CONFIGURED',
      error: null,
      stream: false,
    },
  };
}

function entityBriefInstructions({ hasViewport = false } = {}) {
  if (hasViewport) {
    return [
      "You are God's Eye View live monitoring analyst.",
      'The user highlighted a region on a live geospatial globe and wants to know what they are looking at.',
      'PRIMARY SOURCE: the attached screenshot — describe terrain, coastlines, cities, buildings, ports, infrastructure, labels, icons, aircraft/vessel markers, and anything else visible.',
      'SUPPORTING DATA: JSON metadata lists live tracks, CCTV feeds, weather, and place names for the same box — use it to name and enrich what you see; never invent objects absent from the image and metadata.',
      'Write ONE flowing brief in natural spoken English, like briefing an operator aloud.',
      'Open with what/where this appears to be, then describe notable visible features and any live contacts you can tie to icons in the frame.',
      'Weave weather, accessible CCTV, and headlines naturally when provided.',
      'Do NOT use markdown headers, bullet lists, or field labels like "Type:" or "ICAO:".',
      'If they zoomed tightly on one building or facility, focus on that structure and its surroundings.',
      'Keep under 260 words unless the scene is dense.',
    ].join(' ');
  }

  return [
    "You are God's Eye View live monitoring analyst.",
    'Write ONE flowing brief in natural spoken English — like briefing an operator aloud.',
    'Cover in order when data exists: WHERE, WHAT aircraft/vessels/assets, WEATHER, CCTV/radio feeds, optional headlines.',
    'Use contacts[] fields only. Soft mission context ONLY when type/operator support it.',
    'Do NOT use markdown headers, bullet lists, or field labels like "Type:" or "ICAO:".',
    'Keep under 220 words unless contacts[] is large.',
  ].join(' ');
}

/** Gemini 3.x spends most of maxOutputTokens on internal thinking unless capped. */
export function buildGeminiGenerationConfig(modelId = DEFAULT_MODEL) {
  const config = {
    temperature: 0.35,
    maxOutputTokens: 1024,
  };
  const id = String(modelId || '').toLowerCase();
  if (/gemini-3/i.test(id)) {
    config.thinkingConfig = { thinkingLevel: 'minimal' };
  } else if (/gemini-2\.5.*flash/i.test(id)) {
    config.thinkingConfig = { thinkingBudget: 0 };
  }
  return config;
}

export function buildGeminiEntityBriefUserParts(context = {}) {
  const viewportCapture = context?.viewportCapture;
  const hasViewport = Boolean(viewportCapture?.dataBase64);
  const { viewportCapture: _omit, ...metadata } = context;

  const intro = hasViewport
    ? 'The image is exactly what the operator highlighted on the globe. Tell them what they are looking at.'
    : 'No viewport image was captured; rely on the JSON metadata below.';

  const parts = [];
  if (hasViewport) {
    parts.push({
      inlineData: {
        mimeType: viewportCapture.mimeType || 'image/jpeg',
        data: viewportCapture.dataBase64,
      },
    });
  }
  parts.push({
    text: `${intro}\n\n${JSON.stringify(metadata)}`,
  });
  return { parts, hasViewport };
}

function textFromGeminiSsePayload(raw) {
  if (!raw || raw === '[DONE]') return '';
  try {
    const payload = JSON.parse(raw);
    const parts = payload?.candidates?.[0]?.content?.parts || [];
    return parts.map((part) => part?.text || '').join('');
  } catch {
    return '';
  }
}

async function geminiErrorMessage(response) {
  const body = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.message || `Gemini HTTP ${response.status}`;
  } catch {
    return body.trim() || `Gemini HTTP ${response.status}`;
  }
}

/** Native Gemini SSE stream — supports AI Studio auth keys (AQ.) and legacy AIza keys. */
export async function streamGeminiEntityBrief({ apiKey, modelId, system, userParts, signal }) {
  const url = new URL(`${GEMINI_API_BASE}/models/${encodeURIComponent(modelId)}:streamGenerateContent`);
  url.searchParams.set('alt', 'sse');
  url.searchParams.set('key', apiKey);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: userParts }],
      generationConfig: buildGeminiGenerationConfig(modelId),
    }),
  });

  if (!response.ok) {
    throw new Error(await geminiErrorMessage(response));
  }
  if (!response.body) {
    throw new Error('Gemini returned an empty stream');
  }
  return response.body;
}

function flushSseBuffer(buffer, res) {
  let wrote = 0;
  const pending = buffer.trim();
  if (!pending) return wrote;
  for (const line of pending.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const text = textFromGeminiSsePayload(trimmed.slice(5).trim());
    if (text) {
      res.write(text);
      wrote += text.length;
    }
  }
  return wrote;
}

async function pipeGeminiStreamToResponse(body, res) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let wrote = 0;

  try {
    while (true) {
      if (res.writableEnded || res.destroyed) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const text = textFromGeminiSsePayload(trimmed.slice(5).trim());
        if (text) {
          res.write(text);
          wrote += text.length;
        }
      }
    }
    buffer += decoder.decode();
    wrote += flushSseBuffer(buffer, res);
  } finally {
    try {
      reader.releaseLock();
    } catch { /* ignore */ }
  }

  return wrote;
}

async function handleEntityBriefRequest(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const keyless = keylessGeminiBriefResponse(apiKey);
  if (keyless) {
    res.statusCode = keyless.statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(keyless.payload));
    return;
  }

  if (!enforceRateLimit(req, res)) return;

  try {
    const body = await readRequestBody(req, ENTITY_BRIEF_MAX_BYTES);
    const context = JSON.parse(body || '{}');
    const modelId = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const { parts, hasViewport } = buildGeminiEntityBriefUserParts(context);
    const streamBody = await streamGeminiEntityBrief({
      apiKey,
      modelId,
      system: entityBriefInstructions({ hasViewport }),
      userParts: parts,
    });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-GEV-Gemini-Model', modelId);

    const wrote = await pipeGeminiStreamToResponse(streamBody, res);
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: error?.message || 'Gemini entity brief failed' }));
      return;
    }
    res.end();
  }
}

export function geminiEntityBriefProxy() {
  return {
    name: 'gemini-entity-brief-proxy',
    configureServer(server) {
      server.middlewares.use('/api/gemini/entity-brief', handleEntityBriefRequest);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/gemini/entity-brief', handleEntityBriefRequest);
    },
  };
}
