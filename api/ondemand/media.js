/**
 * api/ondemand/media.js
 *
 * Contract reference: docs/ONDEMAND_API_CURRENT.md
 *   §5.1 Create media from URL — POST {media}
 *   §5.2 Upload raw file       — POST {media}/raw (multipart/form-data)
 *   §5.3 Fetch media           — GET {media}
 *   §5.4 Delete media          — DELETE {media}/{fileId}
 */

import { baseUrls, isConfigured } from './_config.js';
import { ondemandFetch } from '../../server/ondemand/client.js';
import { shapeUpstreamError } from '../../server/ondemand/errors.js';
import {
  sendJson,
  assertMethod,
  rejectCrossOrigin,
  readJsonBody,
  readRawBody,
  BodyError,
  getRequestUrl,
} from '../../server/ondemand/http.js';

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_RAW_BYTES = 8 * 1024 * 1024;
const ALLOWED_LIST_PARAMS = [
  'page',
  'limit',
  'sort',
  'plugins',
  'externalUserId',
  'source',
]; // §5.3

export default async function handler(req, res) {
  if (rejectCrossOrigin(req, res)) return;
  if (!assertMethod(req, res, ['GET', 'POST', 'DELETE'])) return;
  if (!isConfigured()) {
    sendJson(res, 503, {
      error: 'not_configured',
      message: 'ONDEMAND_API_KEY is not set on the server.',
    });
    return;
  }

  const media = baseUrls().media;

  try {
    if (req.method === 'GET') {
      const reqUrl = getRequestUrl(req);
      const upstreamUrl = new URL(media);
      for (const key of ALLOWED_LIST_PARAMS) {
        const value = reqUrl.searchParams.get(key);
        if (value !== null) upstreamUrl.searchParams.set(key, value);
      }
      const upstream = await ondemandFetch(upstreamUrl.toString(), {
        method: 'GET',
      });
      await forwardJson(res, upstream);
      return;
    }

    if (req.method === 'DELETE') {
      const fileId = getRequestUrl(req).searchParams.get('fileId');
      if (!fileId) {
        sendJson(res, 400, { error: 'fileId_required' });
        return;
      }
      const upstream = await ondemandFetch(
        `${media}/${encodeURIComponent(fileId)}`,
        { method: 'DELETE' },
      );
      await forwardJson(res, upstream);
      return;
    }

    // POST — two documented shapes.
    const contentType = req.headers['content-type'] || '';
    if (contentType.toLowerCase().startsWith('multipart/form-data')) {
      let raw;
      try {
        raw = await readRawBody(req, { maxBytes: MAX_RAW_BYTES });
      } catch (err) {
        if (err instanceof BodyError) {
          sendJson(res, err.status, err.payload);
          return;
        }
        throw err;
      }
      // Forward verbatim (§5.2) — never re-encode; the boundary embedded in
      // Content-Type must reach OnDemand unchanged for multipart parsing.
      const upstream = await ondemandFetch(`${media}/raw`, {
        method: 'POST',
        body: raw,
        headers: { 'Content-Type': contentType },
      });
      await forwardJson(res, upstream);
      return;
    }

    let body;
    try {
      body = await readJsonBody(req, { maxBytes: MAX_JSON_BYTES });
    } catch (err) {
      if (err instanceof BodyError) {
        sendJson(res, err.status, err.payload);
        return;
      }
      throw err;
    }

    if (typeof body?.url !== 'string' || !/^https?:\/\//i.test(body.url)) {
      sendJson(res, 400, {
        error: 'url_required',
        message: 'url must be an http(s) URI',
      });
      return;
    }
    if (
      !Array.isArray(body?.plugins) ||
      body.plugins.length === 0 ||
      body.plugins.some((p) => typeof p !== 'string')
    ) {
      sendJson(res, 400, {
        error: 'plugins_required',
        message: 'plugins must be a non-empty string[]',
      });
      return;
    }
    // §5.1 schema marks responseMode required with no documented default;
    // this proxy defaults to 'sync' ONLY when the field is omitted, and
    // records that divergence in docs/ONDEMAND_PROXY_DESIGN.md.
    const responseMode =
      body.responseMode === undefined ? 'sync' : body.responseMode;
    if (!['sync', 'webhook'].includes(responseMode)) {
      sendJson(res, 400, {
        error: 'invalid_responseMode',
        allowed: ['sync', 'webhook'],
      });
      return;
    }

    const upstreamBody = {
      url: body.url,
      plugins: body.plugins,
      responseMode,
      sessionId: body.sessionId,
      externalUserId: body.externalUserId,
      name: body.name,
      sizeBytes: body.sizeBytes,
      pluginInputs: body.pluginInputs,
    };
    for (const key of Object.keys(upstreamBody)) {
      if (upstreamBody[key] === undefined) delete upstreamBody[key];
    }

    const upstream = await ondemandFetch(media, {
      method: 'POST',
      body: upstreamBody,
    });
    await forwardJson(res, upstream);
  } catch {
    sendJson(res, 502, {
      error: 'proxy_error',
      message: 'Unexpected error contacting OnDemand.',
    });
  }
}

/** Forward an upstream JSON response verbatim, or shape its error envelope. */
async function forwardJson(res, upstream) {
  if (!upstream.ok) {
    sendJson(res, upstream.status, await shapeUpstreamError(upstream));
    return;
  }
  let json = {};
  try {
    json = await upstream.json();
  } catch {
    json = {};
  }
  sendJson(res, upstream.status, json);
}
