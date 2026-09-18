/**
 * Shared "create-or-reuse a session for userId" logic, used identically by
 * api/ondemand/sessions.js (POST /api/ondemand/sessions) and
 * api/ondemand/chat.js (the userId convenience path, contract-neutral: chat
 * just needs *a* sessionId and delegates session bookkeeping here instead of
 * duplicating it).
 *
 * Contract reference: docs/ONDEMAND_API_CURRENT.md §2.1 "Create session".
 */

import { config, baseUrls } from './config.js';
import { ondemandFetch } from './client.js';
import { getStore } from './sessions-store.js';
import { shapeUpstreamError } from './errors.js';

/** Thrown when the upstream create-session call itself returns non-2xx. */
export class UpstreamError extends Error {
  constructor(status, envelope) {
    super('upstream_error');
    this.status = status;
    this.envelope = envelope;
  }
}

/**
 * @param {string} userId - becomes `externalUserId` upstream.
 * @param {{ pluginIds?: string[], reuse?: boolean, apiKeyOverride?: string }} [opts]
 *   `apiKeyOverride` (a caller-supplied key resolved by
 *   server/ondemand/client.js#resolveRequestKey) is forwarded to
 *   ondemandFetch for the create call. A session created under someone
 *   else's key belongs to THEIR OnDemand company, so it is never read from
 *   nor written to this proxy's userId→sessionId store: BYO-key sessions are
 *   always freshly created and only the caller keeps the id.
 * @returns {Promise<{ sessionId: string, externalUserId: string, reused: boolean, createdAt: string }>}
 */
export async function ensureSession(userId, opts = {}) {
  const { pluginIds, reuse = true, apiKeyOverride } = opts;
  const store = getStore();
  const usesOverrideKey = Boolean(apiKeyOverride);

  if (reuse && !usesOverrideKey) {
    const existing = store.get(userId);
    if (existing) {
      return {
        sessionId: existing.sessionId,
        externalUserId: userId,
        reused: true,
        createdAt: existing.createdAt,
      };
    }
  }

  // Default pluginIds from config.defaultPluginIds (ONDEMAND_SPATIAL_AGENT_ID,
  // or its alias ONDEMAND_KNOWLEDGE_PLUGIN_IDS — see config.js and
  // docs/ONDEMAND_PROXY_DESIGN.md §5b) when the caller omits the field
  // entirely (not merely empty-array, which is a deliberate "no plugins"
  // choice per §2.1: "pluginIds string[] optional").
  const effectivePluginIds =
    Array.isArray(pluginIds) && pluginIds.length > 0
      ? pluginIds
      : config.defaultPluginIds;

  // §2.1: POST /chat/v1/sessions body { externalUserId, pluginIds }.
  // Naming drift (§2.1 callout, §13): the OpenAPI schema and this response
  // object use `pluginIds`; several guide code samples instead show the same
  // array as `agentIds`. We send the OpenAPI schema name, `pluginIds`.
  const upstream = await ondemandFetch(`${baseUrls().chat}/sessions`, {
    method: 'POST',
    body: { externalUserId: userId, pluginIds: effectivePluginIds },
    apiKeyOverride,
  });

  if (!upstream.ok) {
    throw new UpstreamError(
      upstream.status,
      await shapeUpstreamError(upstream),
    );
  }

  const json = await upstream.json();
  const sessionId = json?.data?.id;
  const createdAt = json?.data?.createdAt || new Date().toISOString();
  if (!usesOverrideKey) {
    store.set(userId, {
      sessionId,
      createdAt,
      lastUsedAt: new Date().toISOString(),
    });
  }
  return { sessionId, externalUserId: userId, reused: false, createdAt };
}
