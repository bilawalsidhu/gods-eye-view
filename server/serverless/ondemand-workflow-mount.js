/**
 * server/serverless/ondemand-workflow-mount.js — `/api/ondemand/workflow/<sub>`
 *
 * Vercel's filesystem router only maps the literal file
 * `api/ondemand/workflow.js` to `/api/ondemand/workflow`; a sub-path such as
 * `/api/ondemand/workflow/execute` is NOT claimed by that function and falls
 * into the catch-all (api/[...route].js → server/serverless/app.js). This
 * mount closes that gap by rewriting the sub-path onto the query-string
 * `?action=` contract the existing handler already implements and delegating
 * to its default export (a lazy dynamic import — the OnDemand module graph is
 * only loaded when one of these routes is actually hit):
 *
 *   POST /api/ondemand/workflow/execute[?…]           → ?action=execute&…
 *   GET  /api/ondemand/workflow/status?executionId=   → ?action=status&…
 *   GET  /api/ondemand/workflow/logs?executionId=     → ?action=logs&…
 *   GET  /api/ondemand/workflow/outputs?executionId=  → ?action=outputs&…
 *   GET  /api/ondemand/workflow/stream?executionId=   → same-origin SSE (below)
 *
 * `stream` is the documented POLLING surface re-shaped as Server-Sent Events:
 * this server polls `GET /execution/{id}` + `GET /execution/{id}/logs`
 * (through the same workflow handler, every STREAM_POLL_MS) and emits
 * `event: status`, `event: log` and a final `event: done` frame. It is NOT an
 * upstream streaming endpoint — the live OnDemand Agents Flow Builder API
 * documents no log-streaming endpoint (docs/ONDEMAND_API_CURRENT.md §7.1;
 * `?action=stream-logs` on the handler itself answers 501 for that reason).
 *
 * Every frame's `data:` is JSON. The `done` frame carries
 * `{ status, executionId, timeToFirstLogMs, totalMs, logCount, structuredResponse? }`
 * where `structuredResponse` is the parsed `structured_response` node output
 * (the 7-key StructuredResponse — server/ondemand/workflow-definition.js)
 * when the execution ended and its outputs were readable. A `status` of
 * `timeout` means THIS stream's own budget ended (STREAM_MAX_MS, kept under
 * the catch-all's 60 s maxDuration) — the execution may still be running;
 * reopen the stream with the same executionId (+ `&afterLogs=<logCount>`) to
 * continue.
 */

const SUB_ACTIONS = new Set(['execute', 'status', 'logs', 'outputs']);
const STREAM_POLL_MS = 1500;
const STREAM_MAX_MS = 50_000; // vercel.json api/*.js maxDuration = 60 s
const TERMINAL_EXCLUDED = new Set([
  'executing',
  'pending',
  'running',
  'queued',
]);

function loadWorkflowHandler() {
  return import('../../api/ondemand/workflow.js').then((m) => m.default);
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Split a mounted-remainder url (`/execute?x=1`) into sub-path + raw query. */
export function splitSubpath(url) {
  const raw = String(url || '/');
  const q = raw.indexOf('?');
  const pathname = q === -1 ? raw : raw.slice(0, q);
  const query = q === -1 ? '' : raw.slice(q + 1);
  const sub = pathname.split('/').filter(Boolean)[0] || '';
  return { sub: decodeURIComponent(sub).toLowerCase(), query };
}

/** Build the `?action=` url the workflow handler understands. */
export function rewriteToActionUrl(sub, query) {
  const params = new URLSearchParams(query);
  params.delete('action');
  params.set('action', sub);
  return `/api/ondemand/workflow?${params.toString()}`;
}

/**
 * Run the workflow handler against an in-memory response and return the
 * parsed JSON — used by the SSE stream so each poll goes through exactly the
 * same code path (same-origin guard, config, error shaping) as a direct call.
 */
export async function invokeWorkflowJson(handler, sourceReq, actionUrl) {
  const req = {
    method: 'GET',
    url: actionUrl,
    headers: { ...(sourceReq.headers || {}) },
    on() {},
    off() {},
  };
  let text = '';
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    getHeader() {
      return undefined;
    },
    flushHeaders() {},
    write(chunk) {
      text += chunk;
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) text += chunk;
      this.writableEnded = true;
    },
    on() {},
    off() {},
  };
  await handler(req, res);
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.statusCode, json };
}

function logIdentity(entry) {
  return `${entry?.timestamp ?? ''}|${entry?.nodeKey ?? ''}|${entry?.message ?? ''}`;
}

/** Parse a `structured_response` node value (string JSON or object). */
export function parseNodeValue(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export function isTerminalStatus(status, endedAt) {
  if (typeof endedAt === 'number' && endedAt > 0) return true;
  if (typeof status !== 'string' || !status) return false;
  return !TERMINAL_EXCLUDED.has(status.toLowerCase());
}

/**
 * The SSE re-shaping of the polling surface (see the file header).
 * @param {object} req
 * @param {object} res
 * @param {{ handler: Function, executionId: string, afterLogs?: number,
 *           pollMs?: number, maxMs?: number, now?: () => number,
 *           sleep?: (ms: number) => Promise<void> }} options
 */
export async function streamExecution(
  req,
  res,
  {
    handler,
    executionId,
    afterLogs = 0,
    pollMs = STREAM_POLL_MS,
    maxMs = STREAM_MAX_MS,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-OnDemand-Stream', 'polling-reshaped'); // not an upstream stream
  res.flushHeaders?.();

  let closed = false;
  const onClose = () => {
    closed = true;
  };
  req.on?.('close', onClose);
  res.on?.('close', onClose);

  const frame = (event, data) => {
    if (closed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      closed = true;
    }
  };

  const t0 = now();
  const seen = new Set();
  let logCount = 0;
  let skip = Number.isFinite(afterLogs) && afterLogs > 0 ? afterLogs : 0;
  let timeToFirstLogMs = null;
  let finalStatus = 'timeout';
  let lastStatusJson = null;
  frame('open', { executionId, pollMs, maxMs, streaming: 'polling-reshaped' });

  try {
    while (!closed) {
      const statusCall = await invokeWorkflowJson(
        handler,
        req,
        rewriteToActionUrl(
          'status',
          `executionId=${encodeURIComponent(executionId)}`,
        ),
      );
      if (statusCall.status >= 400) {
        finalStatus = 'error';
        frame('error', {
          httpStatus: statusCall.status,
          ...(statusCall.json && typeof statusCall.json === 'object'
            ? statusCall.json
            : {}),
        });
        break;
      }
      lastStatusJson = statusCall.json;
      const record = statusCall.json?.data ?? statusCall.json ?? {};
      const status = record?.status ?? null;
      frame('status', {
        executionId,
        status,
        startedAtInMilliseconds: record?.startedAtInMilliseconds ?? null,
        endedAtInMilliseconds: record?.endedAtInMilliseconds ?? null,
        elapsedMs: now() - t0,
      });

      const logsCall = await invokeWorkflowJson(
        handler,
        req,
        rewriteToActionUrl(
          'logs',
          `executionId=${encodeURIComponent(executionId)}`,
        ),
      );
      const entries = Array.isArray(logsCall.json?.data)
        ? logsCall.json.data
        : [];
      for (const entry of entries) {
        const id = logIdentity(entry);
        if (seen.has(id)) continue;
        seen.add(id);
        logCount += 1;
        if (skip > 0) {
          skip -= 1;
          continue;
        }
        if (timeToFirstLogMs === null) timeToFirstLogMs = now() - t0;
        frame('log', {
          executionId,
          index: logCount,
          timestamp: entry?.timestamp ?? null,
          nodeKey: entry?.nodeKey ?? null,
          task: entry?.task ?? null,
          message: entry?.message ?? null,
        });
      }
      if (entries.length && timeToFirstLogMs === null)
        timeToFirstLogMs = now() - t0;

      if (isTerminalStatus(status, record?.endedAtInMilliseconds)) {
        finalStatus = typeof status === 'string' ? status : 'ended';
        break;
      }
      if (now() - t0 + pollMs > maxMs) {
        finalStatus = 'timeout';
        break;
      }
      await sleep(pollMs);
    }
  } catch (error) {
    finalStatus = 'error';
    frame('error', { message: error?.message || 'stream failed' });
  }

  const done = {
    executionId,
    status: finalStatus,
    timeToFirstLogMs,
    totalMs: now() - t0,
    logCount,
    resume: finalStatus === 'timeout',
  };
  if (finalStatus !== 'timeout' && finalStatus !== 'error' && !closed) {
    try {
      const outputsCall = await invokeWorkflowJson(
        handler,
        req,
        rewriteToActionUrl(
          'outputs',
          `executionId=${encodeURIComponent(executionId)}`,
        ),
      );
      const outputs = outputsCall.json?.data?.outputs || {};
      const finalNode = outputs.structured_response;
      if (finalNode) done.structuredResponse = parseNodeValue(finalNode.value);
      done.nodeKeys = Object.keys(outputs);
    } catch {
      // outputs are best-effort; the done frame still reports the status
    }
  }
  if (lastStatusJson?.data?.timeTakenInMilliseconds !== undefined)
    done.timeTakenInMilliseconds = lastStatusJson.data.timeTakenInMilliseconds;
  frame('done', done);
  req.off?.('close', onClose);
  res.off?.('close', onClose);
  try {
    res.end();
  } catch {
    // client already gone
  }
}

/**
 * Mount `/api/ondemand/workflow/` on a Connect-style router. Registered
 * BEFORE the provider loop in server/serverless/app.js so it owns the
 * sub-paths unconditionally; the bare `/api/ondemand/workflow` (no sub-path)
 * is left alone — on Vercel the literal function answers it, and here it
 * simply falls through to the next layer.
 * @param {{ use: Function }} router
 * @param {{ loadHandler?: () => Promise<Function>, streamOptions?: object }} [options]
 */
export function mountOndemandWorkflowSubpaths(
  router,
  { loadHandler = loadWorkflowHandler, streamOptions = {} } = {},
) {
  let handlerPromise = null;
  const getHandler = () => {
    if (!handlerPromise) {
      handlerPromise = loadHandler().catch((error) => {
        handlerPromise = null;
        throw error;
      });
    }
    return handlerPromise;
  };

  router.use('/api/ondemand/workflow', async (req, res, next) => {
    const { sub, query } = splitSubpath(req.url);
    if (!sub) {
      next();
      return;
    }
    if (sub === 'stream') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        sendJson(res, 405, { error: 'method_not_allowed', allow: ['GET'] });
        return;
      }
      const params = new URLSearchParams(query);
      const executionId = params.get('executionId');
      if (!executionId) {
        sendJson(res, 400, { error: 'executionId_required' });
        return;
      }
      const afterLogs = Number.parseInt(params.get('afterLogs') || '0', 10);
      const handler = await getHandler();
      await streamExecution(req, res, {
        handler,
        executionId,
        afterLogs: Number.isFinite(afterLogs) ? afterLogs : 0,
        ...streamOptions,
      });
      return;
    }
    if (!SUB_ACTIONS.has(sub)) {
      sendJson(res, 404, {
        error: 'unknown_workflow_subpath',
        supported: [...SUB_ACTIONS, 'stream'],
      });
      return;
    }
    const handler = await getHandler();
    // The workflow handler resolves its route from req.url (+ Host); the
    // router has already stripped the mount prefix, so rebuild the exact
    // `?action=<sub>&<original query>` url it expects.
    req.url = rewriteToActionUrl(sub, query);
    await handler(req, res);
  });
}

export { SUB_ACTIONS, STREAM_POLL_MS, STREAM_MAX_MS };
