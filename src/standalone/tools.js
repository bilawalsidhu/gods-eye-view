import { createApplicationTools } from '../app/tools.js';
import { startStandaloneChrome } from './startupChrome.js';
export function createStandaloneTools(options) {
  return createApplicationTools({
    startChrome: startStandaloneChrome,
    ...options,
  });
}
