import { createTransitSource } from './source.js';
import { createTrails } from './trails.js';
import { createState } from './state.js';
import { createHeight } from './height.js';
import { createRendering } from './rendering.js';
import { createSelection } from './selection.js';
import { createIngestion } from './ingestion.js';
import { createViewport } from './viewport.js';
import { createQueries } from './queries.js';
import { createLifecycle } from './lifecycle.js';
import { createTesting } from './testing.js';
import { createTransitCockpitSubject } from './cockpitSubject.js';
import { TRANSIT_POLL_MS } from './policy.js';

/**
 * Construct one Transit layer with its own scene state and supplied services.
 *
 * Nothing here is module-global: the viewer, the point collection, the vehicle
 * and height maps, the in-flight requests, the manager handle and the overlay
 * host all live on the instance this returns, and `destroy()` releases every
 * shared registration it took (sprite collection, pick owner, render hold,
 * camera listener).
 *
 * @param {{services: object}} options
 * @returns {object} The data-layer module the manager registers.
 */
export function createTransitLayer({
  services,
  source = createTransitSource(),
}) {
  if (!services?.overlays || !services?.render || !services?.sprites) {
    throw new TypeError(
      'A transit layer needs overlay, render and sprite services',
    );
  }
  if (
    typeof source?.requestSnapshot !== 'function' ||
    typeof source?.getHistory !== 'function'
  ) {
    throw new TypeError(
      'A transit source needs snapshot and history operations',
    );
  }
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source };
  parts.trails = createTrails(context);
  parts.height = createHeight(context);
  parts.selection = createSelection(context);
  parts.rendering = createRendering(context);
  parts.ingestion = createIngestion(context);
  parts.viewport = createViewport(context);
  parts.queries = createQueries(context);
  parts.lifecycle = createLifecycle(context);
  parts.testing = createTesting(context);
  parts.cockpit = createTransitCockpitSubject(context);

  return Object.assign(
    { updateInterval: TRANSIT_POLL_MS },
    parts.lifecycle.methods,
    parts.queries.methods,
    parts.cockpit.methods,
    {
      /**
       * Select a vehicle by the id its card has, as a click on it does.
       * @param {string} id
       * @param {{center?: boolean}} [options]
       */
      pickById(id, options) {
        return parts.selection.pickVehicle(id, options);
      },
      /** Whether the vehicle a card names is the one selected. */
      isSelected(id) {
        const key = parts.selection.vehicleKeyFor(id);
        return key !== null && key === state._selectedKey;
      },
      /** Deselect the selected vehicle, as a click on the map does. */
      clearSelection() {
        parts.selection.clearSelection();
        services.render.governorRequestRender?.('transit-selection');
        return true;
      },
    },
    parts.testing,
  );
}

export {
  TRANSIT_MODE_COLORS,
  TRANSIT_POLL_MS,
  TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
  TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
  aggregateTransitFeedHealth,
  buildTransitSelectionCopy,
  createTransitSelectedOverlayEntry,
  interpolatedVehiclePosition,
  isStaleVehicleFix,
  transitDetectionClass,
  transitDetectionId,
  transitDetectionMetric,
  transitVehicleKey,
  vehicleFixAgeMs,
} from './policy.js';
