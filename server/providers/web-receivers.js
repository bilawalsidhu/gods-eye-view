import { createWebReceiversProxyMiddleware } from './web-receivers/catalog.js';
export { createWebReceiversProxyMiddleware };
export {
  mergeWebReceivers,
  normalizeKiwiSdrRows,
  normalizeReceiverbookSites,
  publicWebReceiverUrl,
  webReceiverId,
} from './web-receivers/directory.js';
export { WEB_RECEIVERS_SOURCES } from './web-receivers/constants.js';

/** Serve the merged KiwiSDR / WebSDR / OpenWebRX directory under `/api/web-receivers`. */
export function webReceiversProxy() {
  const middleware = createWebReceiversProxyMiddleware();
  const install = (server) => {
    server.middlewares.use('/api/web-receivers', middleware);
  };
  return {
    name: 'web-receivers-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
