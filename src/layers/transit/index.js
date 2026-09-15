/**
 * @module layers/transit
 * @description Live public transit — buses, trams, metros, trains and ferries
 * from open GTFS-Realtime VehiclePositions feeds, moving on the globe.
 *
 * One point primitive per vehicle, colored by mode. The supplied source reads
 * each feed's decoded snapshot through the server-side `/api/transit` proxy
 * (registered URLs only, never client-supplied), and only the feeds whose
 * coverage circle contains the camera's look-at point are polled — a session
 * over Boston costs one MBTA request every 15 s and nothing for Norway.
 *
 * Motion: each poll gives every vehicle a new fix; the point then glides from
 * where it was drawn to the new fix over the next poll interval. That is one
 * interval behind real time (the same trade the flights layer makes) and
 * buys smooth motion with no extrapolation snap-back. Vehicles missing from
 * two consecutive polls are removed.
 *
 * Height: near the ground a vehicle sits on the shared ground floor every
 * anchored point in the app reads (rendered mesh cell on the photoreal
 * stack, DEM cell keyless) and stays hidden until its cell answers; from
 * 60 km up the fleet renders at the ellipsoid, always visible through the
 * mesh. Cells are warmed per poll and re-read on a short timer, never per
 * frame.
 *
 * Instance per catalog: everything mutable lives in `createState`; the pure
 * projections (glide, staleness, card copy, stats) stay at module scope.
 */

import { createState } from './state.js';
import { createViewport } from './viewport.js';
import { createIngestion } from './ingestion.js';
import { createRendering } from './rendering.js';
import { createSelection } from './selection.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';
import { createTesting } from './testing.js';

/** Construct one layer with its own scene state and supplied application services. */
export function createTransitLayer({ services, source }) {
  if (typeof source?.getVehicles !== 'function')
    throw new TypeError('A transit source is required');
  for (const name of [
    'render',
    'sprites',
    'picking',
    'overlays',
    'ground',
    'input',
  ]) {
    if (!services?.[name])
      throw new TypeError(`Transit needs the ${name} service`);
  }
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source };
  parts.viewport = createViewport(context);
  parts.ingestion = createIngestion(context);
  parts.rendering = createRendering(context);
  parts.selection = createSelection(context);
  parts.controls = createControls(context);
  parts.lifecycle = createLifecycle(context);
  parts.testing = createTesting(context);
  return Object.assign(
    {},
    parts.controls.methods,
    parts.lifecycle.methods,
    parts.testing,
  );
}

export { createTransitSource } from './source.js';
export {
  TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
  TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
  TRANSIT_POLL_MS,
  TRANSIT_MODE_COLORS,
  ACTIVATION_ALTITUDE_M,
  FLOOR_ANCHOR_MAX_ALTITUDE_M,
  MISSED_POLLS_TO_DROP,
  VEHICLE_MAX_AGE_S,
} from './policy.js';
export {
  transitVehicleKey,
  interpolatedVehiclePosition,
  isStaleVehicleFix,
  vehicleHeightM,
  vehicleVisible,
  buildTransitSelectionCopy,
  createTransitSelectedOverlayEntry,
  transitStats,
} from './model.js';
