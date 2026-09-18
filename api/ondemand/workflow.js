/**
 * api/ondemand/workflow.js — routes by `action` (query param `?action=`, or
 * `body.action` on POST).
 *
 * Contract reference: docs/ONDEMAND_API_CURRENT.md §7 "Agents Flow Builder /
 * Workflows", specifically the §7.1 endpoint table.
 *
 * ONDEMAND_SPATIAL_FLOW_VERSION (alias GODS_EYE_FLOW_VERSION) is
 * intentionally never read anywhere in this file: workflow versioning is
 * NOT FOUND IN LIVE DOCS (§7.3) — see docs/ONDEMAND_PROXY_DESIGN.md
 * "Dropped env vars".
 */

import { config, baseUrls, isConfigured } from './_config.js';
import { ondemandFetch } from '../../server/ondemand/client.js';
import {
  shapeUpstreamError,
  notDocumented,
} from '../../server/ondemand/errors.js';
import {
  sendJson,
  assertMethod,
  rejectCrossOrigin,
  readJsonBody,
  BodyError,
  getRequestUrl,
} from '../../server/ondemand/http.js';

const SUPPORTED_ACTIONS = [
  'execute',
  'status',
  'logs',
  'outputs',
  'list',
  'activate',
  'deactivate',
  'stream-logs',
];

export default async function handler(req, res) {
  if (rejectCrossOrigin(req, res)) return;
  if (!assertMethod(req, res, ['GET', 'POST'])) return;
  if (!isConfigured()) {
    sendJson(res, 503, {
      error: 'not_configured',
      message: 'ONDEMAND_API_KEY is not set on the server.',
    });
    return;
  }

  const automation = baseUrls().automation;
  const url = getRequestUrl(req);

  if (req.method === 'GET') {
    const action = url.searchParams.get('action');
    switch (action) {
      case 'status': {
        const executionId = url.searchParams.get('executionId');
        if (!executionId)
          return sendJson(res, 400, { error: 'executionId_required' });
        return forwardGet(
          res,
          `${automation}/execution/${encodeURIComponent(executionId)}`,
        ); // §7.1
      }
      case 'logs': {
        const executionId = url.searchParams.get('executionId');
        if (!executionId)
          return sendJson(res, 400, { error: 'executionId_required' });
        return forwardGet(
          res,
          `${automation}/execution/${encodeURIComponent(executionId)}/logs`,
        ); // §7.1 (polling only)
      }
      case 'outputs': {
        const executionId = url.searchParams.get('executionId');
        if (!executionId)
          return sendJson(res, 400, { error: 'executionId_required' });
        return forwardGet(
          res,
          `${automation}/execution/${encodeURIComponent(executionId)}/node/outputs`,
        ); // §7.1
      }
      case 'list': {
        const workflowId = url.searchParams.get('workflowId');
        if (!workflowId)
          return sendJson(res, 400, { error: 'workflowId_required' });
        const listUrl = new URL(`${automation}/execution/list`);
        listUrl.searchParams.set('workflowID', workflowId); // §7.1: GET /execution/list?workflowID=&afterID=
        const afterId = url.searchParams.get('afterId');
        if (afterId) listUrl.searchParams.set('afterID', afterId);
        return forwardGet(res, listUrl.toString());
      }
      case 'stream-logs':
        return sendJson(
          res,
          501,
          notDocumented('stream workflow logs', '§7.1'),
        );
      default:
        return sendJson(res, 400, {
          error: 'unknown_action',
          supported: SUPPORTED_ACTIONS,
        });
    }
  }

  // POST
  let body = {};
  try {
    body = await readJsonBody(req, { maxBytes: 8 * 1024 });
  } catch (err) {
    if (err instanceof BodyError) {
      sendJson(res, err.status, err.payload);
      return;
    }
    throw err;
  }
  const action = url.searchParams.get('action') || body?.action;

  switch (action) {
    case 'execute': {
      // §7.1: "no request body is defined in the spec" for execute.
      if (body && (body.input !== undefined || body.payload !== undefined)) {
        return sendJson(
          res,
          501,
          notDocumented('execute request body', '§7.1'),
        );
      }
      const workflowId = body?.workflowId || config.spatialFlowId;
      if (!workflowId)
        return sendJson(res, 400, { error: 'workflowId_required' });
      return forwardPostNoBody(
        res,
        `${automation}/workflow/${encodeURIComponent(workflowId)}/execute`,
      );
    }
    case 'activate':
    case 'deactivate': {
      const workflowId = body?.workflowId || config.spatialFlowId;
      if (!workflowId)
        return sendJson(res, 400, { error: 'workflowId_required' });
      return forwardPostNoBody(
        res,
        `${automation}/workflow/${encodeURIComponent(workflowId)}/${action}`,
      );
    }
    case 'stream-logs':
      return sendJson(res, 501, notDocumented('stream workflow logs', '§7.1'));
    default:
      return sendJson(res, 400, {
        error: 'unknown_action',
        supported: SUPPORTED_ACTIONS,
      });
  }
}

async function forwardGet(res, url) {
  try {
    const upstream = await ondemandFetch(url, { method: 'GET' });
    if (!upstream.ok) {
      sendJson(res, upstream.status, await shapeUpstreamError(upstream));
      return;
    }
    const json = await safeJson(upstream);
    sendJson(res, upstream.status, json);
  } catch {
    sendJson(res, 502, {
      error: 'proxy_error',
      message: 'Unexpected error contacting OnDemand.',
    });
  }
}

async function forwardPostNoBody(res, url) {
  try {
    const upstream = await ondemandFetch(url, { method: 'POST' }); // §7.1: no request body defined
    if (!upstream.ok) {
      sendJson(res, upstream.status, await shapeUpstreamError(upstream));
      return;
    }
    const json = await safeJson(upstream);
    sendJson(res, upstream.status, json);
  } catch {
    sendJson(res, 502, {
      error: 'proxy_error',
      message: 'Unexpected error contacting OnDemand.',
    });
  }
}

async function safeJson(upstream) {
  try {
    return await upstream.json();
  } catch {
    return {};
  }
}
