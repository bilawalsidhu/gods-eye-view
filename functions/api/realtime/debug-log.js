// functions/api/realtime/debug-log.js
/**
 * `/api/realtime/debug-log` — Cloudflare Pages Function.
 *
 * Production counterpart of the dev middleware in `vite.config.js`
 * (openAiRealtimeProxy). The voice client POSTs one Realtime-conversation
 * debug record; without this Function the static deployment answered 405 on
 * every such POST and the browser console showed the error repeatedly.
 *
 * The dev middleware appends the record to `.gev-logs/realtime-conversations.jsonl`.
 * Workers have no writable filesystem, so the production sink is the Workers
 * structured log stream: the record is re-emitted as a single JSON line via
 * `console.log` and is visible with
 *   npx wrangler pages deployment tail --project-name globe
 * Anyone tailing the deployment sees exactly the same JSONL content the dev
 * file would have captured, stamped with `loggedAt`. If persistence is ever
 * needed, a KV/Durable Object binding slots in here — the record shape will
 * not change.
 *
 * Contract (identical to dev):
 *   POST { ...record }   → 204 (empty)
 *   non-POST             → 405 { error: 'Method not allowed' }
 *   cross-site request   → 403 { error: 'cross-origin requests are rejected' }
 *   oversized/invalid    → 400 { error }
 */
import { REALTIME_DEBUG_LOG_MAX_BYTES } from '../../../src/voice/realtimeSession.js';
import {
  PAGES_RATELIMIT_OPENAI_PER_MIN,
  allowRequest,
  createDefaultOnRateLimiter,
  jsonResponse,
  methodNotAllowed,
  readJsonBody,
  sameSiteRejection,
  sameSiteViolation,
} from '../../_lib.js';

/** Built once per isolate and reused, so the per-IP window state persists.
 *  Default-ON on Pages — without a throttle this is a free unauthenticated
 *  log-write primitive. GEV_RATELIMIT_OPENAI_PER_MIN overrides; `0` disables. */
const logLimiter = createDefaultOnRateLimiter(PAGES_RATELIMIT_OPENAI_PER_MIN);

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method !== 'POST') return methodNotAllowed();

  // Same-site guard (contract shared with /api/realtime/token).
  if (sameSiteViolation(request)) return sameSiteRejection();

  // Per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN — the voice endpoints share
  // one knob), default-ON on Pages. `0` disables.
  if (!allowRequest(logLimiter(env?.GEV_RATELIMIT_OPENAI_PER_MIN), request)) {
    return new Response(null, { status: 429, headers: { 'Retry-After': '5' } });
  }

  const body = await readJsonBody(request, REALTIME_DEBUG_LOG_MAX_BYTES);
  if (!body.ok) return jsonResponse({ error: body.error }, { status: body.status });

  // One JSON line per record — the same line the dev middleware appends to
  // .gev-logs/realtime-conversations.jsonl. The record is NESTED under
  // `record`, never spread: a spread would let a client-supplied `loggedAt`
  // key override the server timestamp and corrupt the tail ordering.
  console.log(JSON.stringify({ loggedAt: new Date().toISOString(), record: body.value }));

  return new Response(null, { status: 204 });
}
