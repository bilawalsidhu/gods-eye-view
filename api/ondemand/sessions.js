/**
 * api/ondemand/sessions.js — local session-mapping proxy.
 *
 * Contract reference: docs/ONDEMAND_API_CURRENT.md
 *   §2.1 Create session   — POST /chat/v1/sessions (via session-service.js)
 *   §2.4 Delete session   — NOT FOUND IN LIVE DOCS (local mapping only)
 *
 * POST   /api/ondemand/sessions            -> create-or-reuse (§2.1)
 * GET    /api/ondemand/sessions?userId=    -> local lookup only
 * GET    /api/ondemand/sessions?sessionId=&cursor=&limit=&sort=
 *                                          -> cursor-paginated message history
 *                                             (GET {chat}/sessions/{id}/messages,
 *                                             docs reference getchatmessages:
 *                                             cursor omitted on the first page,
 *                                             then `pagination.next`; limit
 *                                             1..50 default 10; sort asc|desc)
 * DELETE /api/ondemand/sessions?userId=    -> local mapping removal only
 */

import { isConfigured, baseUrls } from './_config.js';
import { ondemandFetch } from '../../server/ondemand/client.js';
import { shapeUpstreamError } from '../../server/ondemand/errors.js';
import { getStore } from '../../server/ondemand/sessions-store.js';
import {
  ensureSession,
  UpstreamError,
} from '../../server/ondemand/session-service.js';
import {
  resolveRequestKey,
  setKeySourceHeader,
  KEY_OVERRIDE_MAX_LEN,
} from '../../server/ondemand/client.js';
import {
  sendJson,
  assertMethod,
  rejectCrossOrigin,
  readJsonBody,
  BodyError,
  getRequestUrl,
} from '../../server/ondemand/http.js';

const MAX_USER_ID_LEN = 128;
const MAX_PLUGIN_IDS = 20;
const MAX_SESSION_ID_LEN = 128;
const MAX_CURSOR_LEN = 512;
const HISTORY_LIMIT_MIN = 1;
const HISTORY_LIMIT_MAX = 50;
const HISTORY_SORTS = new Set(['asc', 'desc']);

export default async function handler(req, res) {
  if (rejectCrossOrigin(req, res)) return;
  if (!assertMethod(req, res, ['GET', 'POST', 'DELETE'])) return;

  // Optional per-request key override (`x-ondemand-key`, docs/ENTITY_CHAT.md).
  // The value goes nowhere but ondemandFetch; only its SOURCE is echoed.
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

  if (!isConfigured() && !keyOverride.apiKeyOverride) {
    sendJson(res, 503, {
      error: 'not_configured',
      message: 'ONDEMAND_API_KEY is not set on the server.',
    });
    return;
  }

  try {
    if (req.method === 'GET') {
      const params = getRequestUrl(req).searchParams;
      if (params.has('sessionId')) {
        await listMessages(res, params, keyOverride.apiKeyOverride);
        return;
      }
      const userId = params.get('userId');
      if (!userId) {
        sendJson(res, 400, { error: 'userId_required' });
        return;
      }
      const rec = getStore().get(userId);
      if (!rec) {
        sendJson(res, 404, { error: 'no_session' });
        return;
      }
      sendJson(res, 200, { sessionId: rec.sessionId });
      return;
    }

    if (req.method === 'DELETE') {
      const userId = getRequestUrl(req).searchParams.get('userId');
      if (!userId) {
        sendJson(res, 400, { error: 'userId_required' });
        return;
      }
      getStore().delete(userId);
      sendJson(res, 200, {
        deleted: true,
        note: 'Upstream delete-session is NOT FOUND IN LIVE DOCS (§2.4); only the local mapping was removed',
      });
      return;
    }

    // POST — create-or-reuse
    let body;
    try {
      body = await readJsonBody(req, { maxBytes: 1024 * 1024 });
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

    const { userId, pluginIds } = body;
    if (
      typeof userId !== 'string' ||
      userId.length === 0 ||
      userId.length > MAX_USER_ID_LEN
    ) {
      sendJson(res, 400, {
        error: 'userId_required',
        message: `userId is required and must be \u2264 ${MAX_USER_ID_LEN} chars`,
      });
      return;
    }
    if (
      pluginIds !== undefined &&
      (!Array.isArray(pluginIds) ||
        pluginIds.length > MAX_PLUGIN_IDS ||
        pluginIds.some((p) => typeof p !== 'string'))
    ) {
      sendJson(res, 400, {
        error: 'invalid_pluginIds',
        message: `pluginIds must be a string[] of at most ${MAX_PLUGIN_IDS} entries`,
      });
      return;
    }
    const reuse = body.reuse === undefined ? true : Boolean(body.reuse);

    const result = await ensureSession(userId, {
      pluginIds,
      reuse,
      apiKeyOverride: keyOverride.apiKeyOverride,
    });
    if (result.reused) {
      sendJson(res, 200, {
        sessionId: result.sessionId,
        externalUserId: userId,
        reused: true,
      });
    } else {
      sendJson(res, 201, {
        sessionId: result.sessionId,
        externalUserId: userId,
        reused: false,
        createdAt: result.createdAt,
      });
    }
  } catch (err) {
    if (err instanceof UpstreamError) {
      sendJson(res, err.status, err.envelope);
      return;
    }
    sendJson(res, 502, {
      error: 'proxy_error',
      message: 'Unexpected error contacting OnDemand.',
    });
  }
}

/**
 * GET {chat}/sessions/{sessionId}/messages — forwarded verbatim (message
 * objects and `pagination.next` untouched) so the browser can page through a
 * camera's history on panel open. Only the documented query params travel.
 */
async function listMessages(res, params, apiKeyOverride) {
  const sessionId = params.get('sessionId') || '';
  if (
    sessionId.length === 0 ||
    sessionId.length > MAX_SESSION_ID_LEN ||
    !/^[A-Za-z0-9_-]+$/.test(sessionId)
  ) {
    sendJson(res, 400, { error: 'invalid_sessionId' });
    return;
  }
  const upstream = new URL(
    `${baseUrls().chat}/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
  const cursor = params.get('cursor');
  if (cursor) {
    if (cursor.length > MAX_CURSOR_LEN) {
      sendJson(res, 400, { error: 'invalid_cursor' });
      return;
    }
    upstream.searchParams.set('cursor', cursor);
  }
  const limitRaw = params.get('limit');
  if (limitRaw !== null) {
    const limit = Number.parseInt(limitRaw, 10);
    if (
      !Number.isInteger(limit) ||
      limit < HISTORY_LIMIT_MIN ||
      limit > HISTORY_LIMIT_MAX
    ) {
      sendJson(res, 400, {
        error: 'invalid_limit',
        min: HISTORY_LIMIT_MIN,
        max: HISTORY_LIMIT_MAX,
      });
      return;
    }
    upstream.searchParams.set('limit', String(limit));
  }
  const sort = params.get('sort');
  if (sort !== null) {
    if (!HISTORY_SORTS.has(sort)) {
      sendJson(res, 400, { error: 'invalid_sort', allowed: [...HISTORY_SORTS] });
      return;
    }
    upstream.searchParams.set('sort', sort);
  }
  const externalUserId = params.get('externalUserId');
  if (externalUserId) {
    if (externalUserId.length > MAX_USER_ID_LEN) {
      sendJson(res, 400, { error: 'invalid_externalUserId' });
      return;
    }
    upstream.searchParams.set('externalUserId', externalUserId);
  }
  const response = await ondemandFetch(upstream.toString(), {
    method: 'GET',
    apiKeyOverride,
  });
  if (!response.ok) {
    sendJson(res, response.status, await shapeUpstreamError(response));
    return;
  }
  let json;
  try {
    json = await response.json();
  } catch {
    sendJson(res, 502, {
      error: 'proxy_error',
      message: 'OnDemand returned a non-JSON messages response.',
    });
    return;
  }
  sendJson(res, 200, json);
}
