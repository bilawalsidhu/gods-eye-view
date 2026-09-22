import { createPatternWatchLayer } from '../../layers/patterns/index.js';

/** Bind pattern detection to the same catalog aircraft instances rendering uses. */
export function createApplicationPatterns({ flights, military }) {
  return createPatternWatchLayer({ services: { flights, military } });
}
