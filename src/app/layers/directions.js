import { createApplicationDirectionsLayer } from '../../data/directions.js';

/** Construct Directions with application scene owners and an explicit route source. */
export function createApplicationDirections({ source }) {
  return createApplicationDirectionsLayer({ source });
}
