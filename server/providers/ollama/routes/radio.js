import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readRequestBody } from '../../common/request.js';
import { sharedAudioWorker } from '../worker.js';
import { sharedRadioListenManager } from '../radio.js';

/**
 * POST /api/voice/radio with a JSON body {op, ...}:
 *   start      {url, label}         begin transcribing a public stream
 *   stop       {id?}                stop one listener (or all)
 *   status     {}                   live and recent listeners (GET works too)
 *   transcript {id?, minutes=5}     timestamped lines from the last N minutes
 *   search     {id?, query, minutes=30}  lines containing the query
 * The browser tool pack (src/voice/tools/radio.js) is the only caller.
 */
export const RADIO_ROUTE = '/api/voice/radio';
const MAX_BODY_BYTES = 64 * 1024;
const OPS = new Set(['start', 'stop', 'status', 'transcript', 'search']);

let logChain = Promise.resolve();
function logRadio(event, payload = {}) {
  const dir = join(process.cwd(), '.gev-logs');
  const line = `${JSON.stringify({ loggedAt: new Date().toISOString(), event, ...payload })}\n`;
  logChain = logChain
    .then(() => mkdir(dir, { recursive: true }))
    .then(() => appendFile(join(dir, 'local-voice.jsonl'), line))
    .catch(() => {});
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/** Build the Connect handler; `getManager` is lazy so tests inject fakes. */
export function createRadioRouteHandler({
  getManager = defaultManager,
  readBody = readRequestBody,
} = {}) {
  return async function radioRouteHandler(req, res) {
    let body = {};
    if (req.method === 'GET') body = { op: 'status' };
    else if (req.method === 'POST') {
      try {
        const raw = await readBody(req, MAX_BODY_BYTES);
        body = raw ? JSON.parse(raw) : {};
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: `Invalid JSON body: ${error?.message || error}`,
        });
        return;
      }
    } else {
      res.writeHead(405, { Allow: 'GET, POST', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const op = String(body?.op || '').toLowerCase();
    if (!OPS.has(op)) {
      sendJson(res, 400, {
        ok: false,
        error: `Unknown op "${op}"; expected ${[...OPS].join(', ')}`,
      });
      return;
    }
    let manager;
    try {
      manager = getManager();
    } catch (error) {
      sendJson(res, 503, { ok: false, error: error?.message || String(error) });
      return;
    }
    try {
      const result = await manager[op](body);
      sendJson(res, 200, result);
    } catch (error) {
      const status = Number(error?.status) || 500;
      if (status >= 500)
        logRadio('radio.route_error', { op, error: error?.message });
      sendJson(res, status, {
        ok: false,
        error: error?.message || String(error),
      });
    }
  };
}

function defaultManager() {
  // Created on first use so the voice socket, which starts first, owns the
  // shared audio worker's logger options.
  return sharedRadioListenManager({
    worker: sharedAudioWorker({ log: logRadio }),
    log: logRadio,
  });
}

export function install(middlewares) {
  middlewares.use(RADIO_ROUTE, createRadioRouteHandler());
}
