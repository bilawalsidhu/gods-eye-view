// functions/api/realtime/token.js
/**
 * `/api/realtime/token` — Cloudflare Pages Function.
 *
 * Production counterpart of the dev middleware in `vite.config.js`
 * (openAiRealtimeProxy). Mints a short-lived OpenAI Realtime client secret so
 * OPENAI_API_KEY stays server-side while the browser connects over WebRTC.
 *
 * The session body itself (tools, instructions, truncation, audio) is built by
 * the shared `src/voice/realtimeSession.js` module — the same module the dev
 * middleware uses — so a Pages-minted secret and a dev-minted secret describe
 * byte-identical sessions apart from the resolved env parameters.
 *
 * Contract (identical to dev):
 *   POST ?tier=standard|mini    → passthrough of the upstream client-secret
 *                                 response, plus X-GEV-Voice-Tier /
 *                                 X-GEV-Voice-Model echo headers (and
 *                                 X-GEV-Voice-Tier-Fallback when a bogus
 *                                 tier was downgraded to standard)
 *   missing OPENAI_API_KEY      → 503 { error: 'OPENAI_API_KEY is not set' }
 *   other methods               → 405 { error: 'Method not allowed' }
 *   cross-origin Origin header  → 403 { error: 'cross-origin token requests are rejected' }
 *   fetch failure               → 502 { error }
 *
 * Env: OPENAI_API_KEY (required); optional overrides OPENAI_REALTIME_MODEL,
 *      OPENAI_REALTIME_MODEL_MINI, OPENAI_REALTIME_VOICE,
 *      OPENAI_REALTIME_REASONING_EFFORT, OPENAI_REALTIME_CONTEXT_TOKENS,
 *      OPENAI_REALTIME_CONTEXT_RETENTION, GEV_RATELIMIT_OPENAI_PER_MIN.
 */
import { isKnownVoiceTier, resolveVoiceModel } from '../../../src/voice/voiceCost.js';
import {
  OPENAI_REALTIME_CONTEXT_RETENTION_DEFAULT,
  OPENAI_REALTIME_CONTEXT_TOKENS_DEFAULT,
  OPENAI_REALTIME_MODEL_DEFAULT,
  OPENAI_REALTIME_MODEL_MINI_DEFAULT,
  OPENAI_REALTIME_REASONING_DEFAULT,
  OPENAI_REALTIME_VOICE_DEFAULT,
  buildRealtimeSessionConfig,
} from '../../../src/voice/realtimeSession.js';
import {
  allowRequest,
  createCachedOptInLimiter,
  jsonResponse,
  methodNotAllowed,
  rateLimitedResponse,
} from '../../_lib.js';

/** Built once per isolate and reused, so the per-IP window state persists. */
const openAiLimiter = createCachedOptInLimiter();

/** Host of a URL string, '' when unparseable (an invalid Origin never matches). */
function hostOf(value) {
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
}

export async function onRequest(context) {
  const { env, request } = context;

  // POST-only: a cross-site GET is a CORS "simple request" (no preflight), so
  // any web page could otherwise make a visitor's browser mint a billable
  // Realtime session drive-by. The side effect is the asset; the minted
  // secret itself never crossed origins (no ACAO header) even before this.
  if (request.method !== 'POST') return methodNotAllowed();

  // Same-origin guard. Browsers attach Origin to every POST; absent Origin
  // means a non-browser client (curl, agents) — allowed, throttled by the
  // opt-in limiter below instead.
  const origin = request.headers.get('Origin');
  if (origin && hostOf(origin) !== hostOf(request.url)) {
    return jsonResponse({ error: 'cross-origin token requests are rejected' }, { status: 403 });
  }

  // Opt-in per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN). No-op when unset.
  if (!allowRequest(openAiLimiter(env.GEV_RATELIMIT_OPENAI_PER_MIN), request)) {
    return rateLimitedResponse();
  }

  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: 'OPENAI_API_KEY is not set' }, { status: 503 });
  }

  // Voice model tier, requested by the client as ?tier=standard|mini.
  // resolveVoiceModel is total: an unknown, empty, or hostile value resolves
  // to `standard` instead of reaching OpenAI as a model id, so a bad
  // querystring degrades to a normal session rather than a dead mic.
  const url = new URL(request.url);
  const requestedTier = url.searchParams.get('tier');
  const tier = resolveVoiceModel(requestedTier).tier;
  const model = tier === 'mini'
    ? env.OPENAI_REALTIME_MODEL_MINI || OPENAI_REALTIME_MODEL_MINI_DEFAULT
    : env.OPENAI_REALTIME_MODEL || OPENAI_REALTIME_MODEL_DEFAULT;
  const voice = env.OPENAI_REALTIME_VOICE || OPENAI_REALTIME_VOICE_DEFAULT;
  const effort = env.OPENAI_REALTIME_REASONING_EFFORT || OPENAI_REALTIME_REASONING_DEFAULT;
  const contextTokenLimit = Math.round(Math.max(
    1000,
    Math.min(12000, Number(env.OPENAI_REALTIME_CONTEXT_TOKENS) || OPENAI_REALTIME_CONTEXT_TOKENS_DEFAULT),
  ));
  const contextRetentionRatio = Math.max(
    0.1,
    Math.min(1, Number(env.OPENAI_REALTIME_CONTEXT_RETENTION) || OPENAI_REALTIME_CONTEXT_RETENTION_DEFAULT),
  );
  const sessionConfig = buildRealtimeSessionConfig({
    model,
    voice,
    effort,
    contextTokenLimit,
    contextRetentionRatio,
  });

  try {
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Safety-Identifier': 'gods-eye-view-pages',
      },
      body: JSON.stringify(sessionConfig),
    });
    const body = await response.text();
    const headers = new Headers({
      'Content-Type': response.headers.get('content-type') || 'application/json',
      // Which tier/model this secret was actually minted for. The upstream
      // body is passed through untouched (the client parses it verbatim), so
      // these headers are the authoritative echo — including the case where a
      // bogus ?tier= was silently downgraded to standard.
      'X-GEV-Voice-Tier': tier,
      'X-GEV-Voice-Model': model,
    });
    if (requestedTier && !isKnownVoiceTier(requestedTier)) {
      headers.set('X-GEV-Voice-Tier-Fallback', '1');
    }
    return new Response(body, { status: response.status, headers });
  } catch (error) {
    return jsonResponse(
      { error: error?.message || 'Failed to create Realtime token' },
      { status: 502 },
    );
  }
}
