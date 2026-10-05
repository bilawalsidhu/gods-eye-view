import { createRadioProxyMiddleware } from './radio/catalog.js';
export { createRadioProxyMiddleware };
export { isPublicRadioAddress } from './radio/transport.js';
export {
  normalizeRadioBrowserStation,
  publicRadioStation,
  publicRadioHttpsUrl,
} from './radio/stations.js';
export function radioBrowserProxy() {
  const middleware = createRadioProxyMiddleware();
  const install = (server) => {
    server.middlewares.use('/api/radio', middleware);
  };
  return {
    name: 'radio-browser-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
