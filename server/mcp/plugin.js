/**
 * Serves the local MCP server at /mcp on the development and preview servers.
 *
 * This is local transport safety, not authentication: requests must come from
 * this machine, name a loopback host (blocking DNS rebinding) and, when a
 * browser sends an Origin, come from a loopback origin.
 */

import { createMcpHttpHandler } from '../../src/tools/mcp/index.js';
import { createLocalMcpServer } from './server.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_BODY_BYTES = 1024 * 1024;

/** Whether a request may reach the local MCP server. */
export function isLocalMcpRequest({ remoteAddress, host, origin }) {
  if (!LOOPBACK_ADDRESSES.has(remoteAddress)) return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(hostUrl.hostname)) return false;
  if (origin == null) return true;
  try {
    const originUrl = new URL(origin);
    return (
      ['http:', 'https:'].includes(originUrl.protocol) &&
      LOOPBACK_HOSTS.has(originUrl.hostname)
    );
  } catch {
    return false;
  }
}

/** Vite plugin that mounts the local MCP server at /mcp. */
export function localMcpPlugin({ createServer = createLocalMcpServer } = {}) {
  const handlers = new Map();
  const handlerFor = (apiBase) => {
    if (!handlers.has(apiBase))
      handlers.set(apiBase, createMcpHttpHandler(createServer({ apiBase })));
    return handlers.get(apiBase);
  };
  const install = (server) => {
    server.middlewares.use('/mcp', async (req, res) => {
      const host = req.headers.host || '';
      if (
        !isLocalMcpRequest({
          remoteAddress: req.socket?.remoteAddress,
          host,
          origin: req.headers.origin,
        })
      ) {
        res.writeHead(403, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            error: 'The MCP server only accepts local requests',
          }),
        );
        return;
      }
      // A client that disconnects before its answer cancels the tool call.
      const disconnect = new AbortController();
      const onClose = () => {
        if (!res.writableFinished) disconnect.abort();
      };
      res.on('close', onClose);
      try {
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        const request = new Request(`http://${host}/mcp`, {
          method: req.method,
          headers: Object.entries(req.headers).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, String(value)]],
          ),
          body,
          signal: disconnect.signal,
        });
        const response = await handlerFor(`http://${host}`)(request);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        if (disconnect.signal.aborted) return;
        if (res.headersSent) return res.destroy();
        res.writeHead(error?.status === 413 ? 413 : 400, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            error: error?.status === 413 ? 'Request too large' : 'Bad request',
          }),
        );
      } finally {
        res.off('close', onClose);
      }
    });
  };
  return {
    name: 'local-mcp',
    configureServer: install,
    configurePreviewServer: install,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      // Keep draining without storing, so the 413 response can still be sent.
      if (tooLarge || size <= MAX_BODY_BYTES) {
        if (!tooLarge) chunks.push(chunk);
        return;
      }
      tooLarge = true;
      chunks.length = 0;
      reject(Object.assign(new Error('Request too large'), { status: 413 }));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
