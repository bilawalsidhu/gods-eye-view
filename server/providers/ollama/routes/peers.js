import { WebSocket } from 'ws';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readRequestBody } from '../../common/request.js';
import { sharedRemoteHub } from '../remote.js';
import { publicPeerUrl } from '../peers.js';
import {
  PEERS_ROUTE,
  createPeerFederation,
  parsePeerList,
  peerName,
} from '../peers.js';

/**
 * /api/voice/peers — peer federation (server/providers/ollama/peers.js).
 *   GET                                  {name, peers:[{name,url,connected,lastSeen}]}
 *   POST {op:'share_place', place:{...}} {ok, place, sent:[peerName], peers}
 * Peers are dialed only when a real HTTP server exists (dev / preview);
 * unit-test installs get the route with an idle federation.
 */
const MAX_BODY_BYTES = 64 * 1024;
const FEDERATION_KEY = '__gevPeerFederation';

let logChain = Promise.resolve();
function logPeers(event, payload = {}) {
  const dir = join(process.cwd(), '.gev-logs');
  const line = `${JSON.stringify({ loggedAt: new Date().toISOString(), event, ...payload })}\n`;
  logChain = logChain
    .then(() => mkdir(dir, { recursive: true }))
    .then(() => appendFile(join(dir, 'local-voice.jsonl'), line))
    .catch(() => {});
}

/** The federation this process dials peers with; replaced on reinstall. */
export function sharedPeerFederation() {
  return globalThis[FEDERATION_KEY] || null;
}

export function createPeersHandler(federation) {
  return async (req, res) => {
    const json = (status, body) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET')
      return json(200, { name: federation.name, peers: federation.status() });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return json(405, { error: 'Method not allowed' });
    }
    let body;
    try {
      body = JSON.parse((await readRequestBody(req, MAX_BODY_BYTES)) || '{}');
    } catch {
      return json(400, { error: 'Invalid JSON body' });
    }
    if (body?.op === 'share_place') {
      const result = federation.sharePlace(body.place);
      return json(result.ok ? 200 : 400, result);
    }
    return json(400, { error: `Unknown op: ${String(body?.op ?? '')}` });
  };
}

export function install(middlewares, server) {
  const federation = createPeerFederation({
    peers: parsePeerList(process.env.GEV_PEERS),
    name: peerName(),
    hub: sharedRemoteHub(),
    WebSocketImpl: WebSocket,
    log: logPeers,
  });
  const httpServer = server?.httpServer;
  if (httpServer) {
    sharedPeerFederation()?.close();
    globalThis[FEDERATION_KEY] = federation;
    federation.start();
    httpServer.once('close', () => {
      federation.close();
      if (globalThis[FEDERATION_KEY] === federation)
        delete globalThis[FEDERATION_KEY];
    });
    logPeers('peer.install', {
      name: federation.name,
      peers: federation.links.map((link) => publicPeerUrl(link.url)),
    });
  }
  middlewares.use(PEERS_ROUTE, createPeersHandler(federation));
  return federation;
}
