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
 * @param {{ pluginIds?: string[], reuse?: boolean }} [opts]
 * @returns {Promise<{ sessionId: string, externalUserId: string, reused: boolean, createdAt: string }>}
 */
export async function ensureSession(userId, opts = {}) {
  const { pluginIds, reuse = true } = opts;
  const store = getStore();

  if (reuse) {
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

  // Default pluginIds from ONDEMAND_SPATIAL_AGENT_ID when the caller omits
  // the field entirely (not merely empty-array, which is a deliberate
  // "no plugins" choice per §2.1: "pluginIds string[] optional").
  const effectivePluginIds =
    Array.isArray(pluginIds) && pluginIds.length > 0
      ? pluginIds
      : config.spatialAgentId
        ? [config.spatialAgentId]
        : [];

  // §2.1: POST /chat/v1/sessions body { externalUserId, pluginIds }.
  // Naming drift (§2.1 callout, §13): the OpenAPI schema and this response
  // object use `pluginIds`; several guide code samples instead show the same
  // array as `agentIds`. We send the OpenAPI schema name, `pluginIds`.
  const upstream = await ondemandFetch(`${baseUrls().chat}/sessions`, {
    method: 'POST',
    body: { externalUserId: userId, pluginIds: effectivePluginIds },
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
  store.set(userId, {
    sessionId,
    createdAt,
    lastUsedAt: new Date().toISOString(),
  });
  return { sessionId, externalUserId: userId, reused: false, createdAt };
}
