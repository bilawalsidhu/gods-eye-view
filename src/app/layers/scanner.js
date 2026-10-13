import { createScannerLayer } from '../../layers/scanner/index.js';
/** Wire the police-scanner layer to the application's feed source. */
export function createApplicationScanner(options) {
  return createScannerLayer(options);
}
