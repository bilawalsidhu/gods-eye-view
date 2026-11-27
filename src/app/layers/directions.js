/**
 * Directions over the application's shared scene owners: credits, the render
 * governor, sprite order, the pick registry, the camera verbs, the shared
 * ground floor and the pointer arbiter; its cards go to the world overlay.
 */
import * as credits from '../../data/dataCredits.js';
import * as render from '../../renderGovernor.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import * as camera from '../../cameraVerbs.js';
import * as ground from '../../data/groundFloor.js';
import * as input from '../../data/inputOwnership.js';
import { createDirectionsLayer } from '../../layers/directions/index.js';
import { createDirectionsSource } from '../../layers/directions/source.js';

const directionsServices = Object.freeze({
  credits,
  render,
  sprites,
  picking,
  camera,
  ground,
  input,
});

const applicationOverlayHost = Object.freeze({
  setEntries: overlays.setOverlayEntries,
  setVisible: overlays.setOverlaySourceVisible,
  clearSource: overlays.clearOverlaySource,
});

/**
 * Construct one Directions layer with an explicit (or the default) route
 * source and overlay host.
 */
export function createApplicationDirections({
  source = createDirectionsSource(),
  overlayHost = applicationOverlayHost,
} = {}) {
  return createDirectionsLayer({
    services: directionsServices,
    source,
    overlayHost,
  });
}
