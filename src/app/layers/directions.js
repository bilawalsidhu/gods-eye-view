import { createApplicationDirectionsLayer } from '../../data/directions.js';

/**
 * Construct one Directions layer using the application scene owners.
 *
 * It takes no data source: a route is fetched from `/api/route` when the
 * operator places both endpoints, so there is nothing to supply up front.
 * @returns {object} A fresh layer instance for this catalog.
 */
export function createApplicationDirections() {
  return createApplicationDirectionsLayer();
}
