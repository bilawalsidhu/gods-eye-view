/**
 * api/ondemand/chat.js — POST /api/ondemand/chat.
 *
 * Contract reference: docs/ONDEMAND_API_CURRENT.md
 *   §3.1 Every body field — the allow-list below is a literal transcription;
 *        any body key NOT in that table is rejected with 400 unknown_field,
 *        which is how this proxy enforces "never invent fields" at the wire.
 *   §3.2 Sync request/response
 *   §3.3 Webhook mode — payload schema/signature NOT FOUND -> 501.
 *   §3.4 / §4 Stream request/response + SSE event schema — piped verbatim.
 *   §12  endpointId is required; the predefined id list is volatile, so a
 *        missing id (body + env) is a 400, never a silent hardcoded default.
 */

import {
  config,
  baseUrls,
  isConfigured,
  tierDefaults,
  TIER_DEFAULTS,
  applyCameraProfile,
  CAMERA_PROFILE,
} from './_config.js';
import {
  ondemandFetch,
  bindOndemandFetch,
  resolveRequestKey,
  setKeySourceHeader,
  KEY_OVERRIDE_MAX_LEN,
} from '../../server/ondemand/client.js';
import {
  ensureSession,
  UpstreamError,
} from '../../server/ondemand/session-service.js';
import {
  shapeUpstreamError,
  notDocumented,
} from '../../server/ondemand/errors.js';
import { pipeSseBody, wireAbortOnClose } from '../../server/ondemand/sse.js';
import {
  sendJson,
  assertMethod,
  rejectCrossOrigin,
  readJsonBody,
  BodyError,
} from '../../server/ondemand/http.js';

const MAX_QUERY_BYTES = 32 * 1024;
const MAX_BODY_BYTES = 64 * 1024; // headroom above MAX_QUERY_BYTES for the rest of the envelope
const MAX_PLUGIN_IDS = 20;
const MAX_STOP_SEQUENCES = 4;

// §3.1 "Every body field" — the complete documented set, plus sessionId/
// userId (this proxy's own session-resolution convenience, not upstream
// fields themselves; sessionId IS a path param upstream, userId never
// leaves this proxy).
const TOP_LEVEL_FIELDS = new Set([
  'sessionId',
  'userId',
  'query',
  'endpointId',
  'responseMode',
  'pluginIds',
  'fulfillmentOnly',
  'modelConfigs',
  'reasoningMode',
  // Gate 3 capability loop (server/ondemand/capability-loop.js) — proxy-side
  // fields, never forwarded upstream: `mode: 'capability-loop'`, the fresh
  // spatial context and the tier whose TIER_DEFAULTS pick the endpoint.
  'mode',
  'spatialContext',
  'tier',
  // Camera chat (docs/ONDEMAND_CAMERA_CHAT_ADDENDUM_2026-09-21.md) — proxy-side
  // fields, never forwarded upstream: `profile: 'camera'` applies the
  // server-side camera defaults (endpointId, pluginIds, reasoningMode) to
  // whatever the body omitted; `attachment` names the Media API file the
  // browser attached to this session for THIS turn, so the proxy can pick
  // the vision endpoint (the media itself is already linked upstream by its
  // `sessionId` — the query body has no documented attachment field).
  'profile',
  'attachment',
]);
const PROFILES = new Set([CAMERA_PROFILE]);
const MAX_ATTACHMENT_ID_LEN = 128;
const MODES = new Set(['chat', 'capability-loop']);
const MAX_SPATIAL_CONTEXT_BYTES = 64 * 1024;
const MODEL_CONFIG_FIELDS = new Set([
  'fulfillmentPrompt',
  'stopSequences',
  'temperature',
  'topP',
  'presencePenalty',
  'frequencyPenalty',
]);

export default async function handler(req, res) {
  if (rejectCrossOrigin(req, res)) return;
  if (!assertMethod(req, res, ['POST'])) return;
  // Optional per-request key override (`x-ondemand-key`, docs/ENTITY_CHAT.md).
  // Resolved once here, threaded into every upstream call below through
  // `apiKeyOverride` / the bound fetch; only its SOURCE is ever echoed.
  const keyOverride = resolveRequestKey(req);
  if (keyOverride.rejected) {
    setKeySourceHeader(res, 'server');
    sendJson(res, 400, {
      error: 'invalid_key_override',
      message: `x-ondemand-key must be a non-empty printable-ASCII string of at most ${KEY_OVERRIDE_MAX_LEN} characters`,
    });
    return;
  }
  setKeySourceHeader(res, keyOverride.source);
  const { apiKeyOverride } = keyOverride;
  if (!isConfigured() && !apiKeyOverride) {
    sendJson(res, 503, {
      error: 'not_configured',
      message: 'ONDEMAND_API_KEY is not set on the server.',
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
  } catch (err) {
    if (err instanceof BodyError) {
      sendJson(res, err.status, err.payload);
      return;
    }
    throw err;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: 'invalid_body' });
    return;
  }

  for (const key of Object.keys(body)) {
    if (!TOP_LEVEL_FIELDS.has(key)) {
      sendJson(res, 400, { error: 'unknown_field', field: key });
      return;
    }
  }

  const {
    sessionId,
    userId,
    query,
    pluginIds,
    fulfillmentOnly,
    modelConfigs,
    reasoningMode,
    mode,
    spatialContext,
    tier,
    profile,
    attachment,
  } = body;
  let { endpointId, responseMode } = body;
  let { pluginIds: effectivePluginIds, reasoningMode: effectiveReasoningMode } =
    body;

  if (!sessionId && !userId) {
    sendJson(res, 400, { error: 'sessionId_or_userId_required' });
    return;
  }
  if (typeof query !== 'string' || query.length === 0) {
    sendJson(res, 400, { error: 'query_required' });
    return;
  }
  if (Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES) {
    sendJson(res, 400, { error: 'query_too_large', maxBytes: MAX_QUERY_BYTES });
    return;
  }
  if (mode !== undefined && !MODES.has(mode)) {
    sendJson(res, 400, { error: 'invalid_mode', allowed: [...MODES] });
    return;
  }
  if (mode === 'capability-loop') {
    await runCapabilityLoopRequest(res, {
      sessionId,
      userId,
      query,
      spatialContext,
      tier,
      pluginIds,
      endpointId,
      responseMode,
      apiKeyOverride,
    });
    return;
  }
  if (spatialContext !== undefined || tier !== undefined) {
    sendJson(res, 400, {
      error: 'unknown_field',
      field: spatialContext !== undefined ? 'spatialContext' : 'tier',
      message:
        'spatialContext/tier are only accepted with mode "capability-loop"',
    });
    return;
  }

  responseMode = responseMode === undefined ? 'stream' : responseMode;
  if (!['sync', 'stream', 'webhook'].includes(responseMode)) {
    sendJson(res, 400, {
      error: 'invalid_responseMode',
      allowed: ['sync', 'stream', 'webhook'],
    });
    return;
  }
  if (responseMode === 'webhook') {
    sendJson(res, 501, notDocumented('webhook payload schema', '§3.3'));
    return;
  }

  if (profile !== undefined && !PROFILES.has(profile)) {
    sendJson(res, 400, { error: 'invalid_profile', allowed: [...PROFILES] });
    return;
  }
  if (attachment !== undefined) {
    const mediaId = attachment && typeof attachment === 'object' ? attachment.mediaId : attachment;
    if (
      typeof mediaId !== 'string' ||
      mediaId.length === 0 ||
      mediaId.length > MAX_ATTACHMENT_ID_LEN
    ) {
      sendJson(res, 400, {
        error: 'invalid_attachment',
        message: `attachment must be a Media API file id (string ≤ ${MAX_ATTACHMENT_ID_LEN} chars) or { mediaId }`,
      });
      return;
    }
  }
  let profileApplied = [];
  if (profile === CAMERA_PROFILE) {
    const resolved = applyCameraProfile(
      { endpointId, pluginIds, reasoningMode, responseMode },
      { hasAttachment: attachment !== undefined },
    );
    endpointId = resolved.endpointId;
    effectivePluginIds = resolved.pluginIds;
    effectiveReasoningMode = resolved.reasoningMode;
    profileApplied = resolved.applied;
    res.setHeader('X-OnDemand-Profile', CAMERA_PROFILE);
    if (profileApplied.length)
      res.setHeader('X-OnDemand-Profile-Applied', profileApplied.join(','));
  }

  endpointId =
    endpointId === undefined ? config.fulfillmentEndpointId : endpointId;
  if (!endpointId) {
    sendJson(res, 400, {
      error: 'endpointId_required',
      message:
        'No endpointId in the request body and ONDEMAND_FULFILLMENT_ENDPOINT_ID is not set. The predefined endpointId list is documented as volatile (contract §12), so this proxy never hardcodes one.',
    });
    return;
  }

  if (
    effectivePluginIds !== undefined &&
    (!Array.isArray(effectivePluginIds) ||
      effectivePluginIds.length > MAX_PLUGIN_IDS ||
      effectivePluginIds.some((p) => typeof p !== 'string'))
  ) {
    sendJson(res, 400, {
      error: 'invalid_pluginIds',
      message: `pluginIds must be a string[] of at most ${MAX_PLUGIN_IDS} entries`,
    });
    return;
  }
  if (fulfillmentOnly !== undefined && typeof fulfillmentOnly !== 'boolean') {
    sendJson(res, 400, { error: 'invalid_fulfillmentOnly' });
    return;
  }

  let cleanModelConfigs;
  if (modelConfigs !== undefined) {
    if (
      modelConfigs === null ||
      typeof modelConfigs !== 'object' ||
      Array.isArray(modelConfigs)
    ) {
      sendJson(res, 400, { error: 'invalid_modelConfigs' });
      return;
    }
    for (const key of Object.keys(modelConfigs)) {
      if (!MODEL_CONFIG_FIELDS.has(key)) {
        sendJson(res, 400, {
          error: 'unknown_field',
          field: `modelConfigs.${key}`,
        });
        return;
      }
    }
    const rangeError = validateModelConfigs(modelConfigs);
    if (rangeError) {
      sendJson(res, 400, rangeError);
      return;
    }
    cleanModelConfigs = modelConfigs;
  }

  if (
    effectiveReasoningMode !== undefined &&
    typeof effectiveReasoningMode !== 'string'
  ) {
    sendJson(res, 400, { error: 'invalid_reasoningMode' });
    return;
  }

  let resolvedSessionId = sessionId;
  if (!resolvedSessionId) {
    try {
      const ensured = await ensureSession(userId, { apiKeyOverride });
      resolvedSessionId = ensured.sessionId;
    } catch (err) {
      if (err instanceof UpstreamError) {
        sendJson(res, err.status, err.envelope);
        return;
      }
      sendJson(res, 502, {
        error: 'proxy_error',
        message: 'Unable to establish a session.',
      });
      return;
    }
  }

  const upstreamBody = {
    query,
    endpointId,
    responseMode,
    pluginIds: effectivePluginIds,
    fulfillmentOnly,
    modelConfigs: cleanModelConfigs,
  };
  // reasoningMode is guide-only and documented as relevant only in stream
  // mode (§3.1 / §12) — never sent on a sync query.
  if (responseMode === 'stream' && effectiveReasoningMode !== undefined) {
    upstreamBody.reasoningMode = effectiveReasoningMode;
  }
  for (const key of Object.keys(upstreamBody)) {
    if (upstreamBody[key] === undefined) delete upstreamBody[key];
  }

  const url = `${baseUrls().chat}/sessions/${encodeURIComponent(resolvedSessionId)}/query`; // §3

  if (responseMode === 'sync') {
    let upstream;
    try {
      upstream = await ondemandFetch(url, {
        method: 'POST',
        body: upstreamBody,
        apiKeyOverride,
      });
    } catch {
      sendJson(res, 502, {
        error: 'proxy_error',
        message: 'Failed to reach OnDemand.',
      });
      return;
    }
    if (!upstream.ok) {
      sendJson(res, upstream.status, await shapeUpstreamError(upstream));
      return;
    }
    let json;
    try {
      json = await upstream.json();
    } catch {
      sendJson(res, 502, {
        error: 'proxy_error',
        message: 'OnDemand returned a non-JSON sync response.',
      });
      return;
    }
    sendJson(res, upstream.status, json); // {message, data:{sessionId, messageId, answer, status}}
    return;
  }

  // responseMode === 'stream'
  const controller = new AbortController();
  const unwireEarly = wireAbortOnClose(req, res, controller);

  let upstream;
  try {
    upstream = await ondemandFetch(url, {
      method: 'POST',
      body: upstreamBody,
      signal: controller.signal,
      apiKeyOverride,
    });
  } catch {
    unwireEarly();
    if (controller.signal.aborted) {
      try {
        res.end();
      } catch {
        // client already gone
      }
      return;
    }
    sendJson(res, 502, {
      error: 'proxy_error',
      message: 'Failed to reach OnDemand.',
    });
    return;
  }

  if (!upstream.ok) {
    unwireEarly();
    sendJson(res, upstream.status, await shapeUpstreamError(upstream));
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  try {
    await pipeSseBody(upstream.body, res, { keepaliveMs: 15000 });
  } finally {
    unwireEarly();
    try {
      res.end();
    } catch {
      // already ended by pipeSseBody
    }
  }
}

function validateModelConfigs(mc) {
  const checks = [
    [
      'stopSequences',
      (v) =>
        Array.isArray(v) &&
        v.length <= MAX_STOP_SEQUENCES &&
        v.every((s) => typeof s === 'string'),
      `stopSequences must be a string[] of at most ${MAX_STOP_SEQUENCES} entries`,
    ],
    [
      'temperature',
      (v) => typeof v === 'number' && v >= 0 && v <= 2,
      'temperature must be a number in [0, 2]',
    ],
    [
      'topP',
      (v) => typeof v === 'number' && v >= 0 && v <= 1,
      'topP must be a number in [0, 1]',
    ],
    [
      'presencePenalty',
      (v) => typeof v === 'number' && v >= 0 && v <= 2,
      'presencePenalty must be a number in [0, 2]',
    ],
    [
      'frequencyPenalty',
      (v) => typeof v === 'number' && v >= 0 && v <= 2,
      'frequencyPenalty must be a number in [0, 2]',
    ],
    [
      'fulfillmentPrompt',
      (v) => typeof v === 'string',
      'fulfillmentPrompt must be a string',
    ],
  ];
  for (const [field, ok, message] of checks) {
    if (mc[field] !== undefined && !ok(mc[field])) {
      return { error: 'invalid_modelConfigs_field', field, message };
    }
  }
  return null;
}

/**
 * mode: 'capability-loop' — the interim decide→execute→answer loop
 * (server/ondemand/capability-loop.js; docs/ONDEMAND_PROXY_DESIGN.md
 * "Capability loop (interim pending dashboard tool IDs)"). Sync only. The
 * endpoint comes from the tier's TIER_DEFAULTS (or an explicit endpointId);
 * the tier's reasoningMode is recorded in the result, not sent (§3.1:
 * stream-only field). Nothing is pre-fetched: only the capabilities OnDemand
 * selected are executed, through server/sources/index.js.
 */
async function runCapabilityLoopRequest(
  res,
  {
    sessionId,
    userId,
    query,
    spatialContext,
    tier,
    pluginIds,
    endpointId,
    responseMode,
    apiKeyOverride,
  },
) {
  if (responseMode !== undefined && responseMode !== 'sync') {
    sendJson(res, 400, {
      error: 'invalid_responseMode',
      message: 'mode "capability-loop" runs sync turns only',
    });
    return;
  }
  if (
    spatialContext !== undefined &&
    (spatialContext === null ||
      typeof spatialContext !== 'object' ||
      Array.isArray(spatialContext))
  ) {
    sendJson(res, 400, { error: 'invalid_spatialContext' });
    return;
  }
  if (
    spatialContext !== undefined &&
    Buffer.byteLength(JSON.stringify(spatialContext), 'utf8') >
      MAX_SPATIAL_CONTEXT_BYTES
  ) {
    sendJson(res, 400, {
      error: 'spatialContext_too_large',
      maxBytes: MAX_SPATIAL_CONTEXT_BYTES,
    });
    return;
  }
  if (tier !== undefined && typeof tier !== 'string') {
    sendJson(res, 400, { error: 'invalid_tier' });
    return;
  }
  const tierRow = tierDefaults(tier);
  const resolvedTier = Object.keys(TIER_DEFAULTS).find(
    (k) => TIER_DEFAULTS[k] === tierRow,
  );
  const [{ runCapabilityLoop, loadRegistry }, { SOURCE_ADAPTERS }] =
    await Promise.all([
      import('../../server/ondemand/capability-loop.js'),
      import('../../server/sources/index.js'),
    ]);
  let registry;
  try {
    registry = await loadRegistry();
  } catch {
    sendJson(res, 500, {
      error: 'registry_unavailable',
      message: 'src/registry/capabilities.json could not be read',
    });
    return;
  }
  let result;
  try {
    result = await runCapabilityLoop({
      query,
      spatialContext: spatialContext ?? {},
      tier: resolvedTier,
      userId,
      sessionId,
      registry,
      adapters: SOURCE_ADAPTERS,
      ondemand: {
        fetch: bindOndemandFetch(apiKeyOverride),
        chatBase: baseUrls().chat,
      },
      endpointId: endpointId ?? tierRow.fulfillmentEndpointId,
      reasoningMode: tierRow.reasoningMode,
      pluginIds: Array.isArray(pluginIds) ? pluginIds : [],
    });
  } catch (err) {
    console.error('[capability-loop] failed:', err?.message || err);
    sendJson(res, 502, {
      error: 'proxy_error',
      message: 'capability loop failed before an answer was produced',
    });
    return;
  }
  const status = result.ok ? 200 : result.error?.status === 422 ? 422 : 502;
  sendJson(res, status, { mode: 'capability-loop', ...result });
}
