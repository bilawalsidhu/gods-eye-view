import { createTransitService } from '../../src/sources/transitService.js';
export { fetchTransitFeed } from '../../src/sources/transitService.js';

/** Connect the reusable transit request service to development and preview. */
export function transitProxy(options = {}) {
  const service = createTransitService(options);
  function install(server) {
    server.middlewares.use('/api/transit', async (req, res) => {
      const response = await service.handle({
        url: `http://localhost/api/transit${req.url || '/'}`,
        method: req.method,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });
    server.httpServer?.once('close', service.close);
  }
  return {
    name: 'transit-proxy',
    closeBundle: service.close,
    configureServer: install,
    configurePreviewServer: install,
  };
}
