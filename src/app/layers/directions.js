import directionsLayer from '../../data/directions.js';

/**
 * Supply the Directions layer to the application catalog.
 *
 * The layer keeps one set of scene state for the page, like the other
 * `src/data` layers, and `src/data/directions.js` is where it is bound to the
 * shared services. This is the catalog's handle on it.
 * @returns {object} The registered layer module.
 */
export function createApplicationDirections() {
  return directionsLayer;
}
