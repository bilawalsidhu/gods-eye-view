import assert from 'node:assert/strict';

/** Boot a mounted provider middleware without a real server. */
export function installWindProxy(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  assert.equal(routes.size, 1);
  const handler = [...routes.values()][0];
  return async (url = '/', method = 'GET') => {
    const res = {
      statusCode: 200,
      headers: {},
      headersSent: false,
      writeHead(status, headers) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(headers || {}))
          this.headers[name.toLowerCase()] = value;
        this.headersSent = true;
      },
      end(body) {
        this.body = body;
        this.headersSent = true;
      },
    };
    await handler({ url, method }, res);
    return res;
  };
}
