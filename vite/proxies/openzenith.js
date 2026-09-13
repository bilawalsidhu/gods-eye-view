/**
 * OpenZenith bridge (`/api/openzenith/*`).
 *
 * Extracted verbatim from vite.config.js (Batch 4, PLAN.md) so each
 * endpoint can be unit-tested in isolation; vite.config.js assembles the
 * plugin list from these modules.
 */

import { handleOpenZenithRequest } from '../../functions/api/openzenith/_handler.js';

/**
 * `/api/openzenith/*` dev middleware — a thin Node→web bridge onto the SAME
 * handler the production Pages Function uses
 * (`functions/api/openzenith/_handler.js`), so dev and production cannot
 * drift: one allowlist, one validation, one cache implementation. There is
 * deliberately no local logic here to test; the handler's own test file
 * covers the contract, and the bridge is exercised by the dev-server QA.
 */
export function openZenithProxy() {
  const handle = (req, res) => {
    // Connect strips the mount prefix from req.url; the handler slices the
    // full `/api/openzenith/` pathname, so put it back.
    const request = new Request(`http://localhost/api/openzenith${req.url}`, {
      method: req.method,
      headers: { Accept: String(req.headers.accept || 'application/json') },
    });
    handleOpenZenithRequest(request, process.env).then(async (response) => {
      const headers = {};
      response.headers.forEach((value, name) => { headers[name] = value; });
      res.writeHead(response.status, headers);
      if (req.method === 'HEAD' || !response.body) {
        res.end();
        return;
      }
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    }).catch(() => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'OpenZenith proxy bridge failed' }));
    });
  };
  return {
    name: 'openzenith-proxy',
    configureServer(server) {
      server.middlewares.use('/api/openzenith', handle);
    },
  };
}
