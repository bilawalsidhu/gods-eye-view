import { createVesselLayer } from '../../layers/vessels/index.js';
import * as context from '../../data/contextStore.js';
import * as trails from '../../data/trailRenderer.js';
import * as labels from '../../data/detectionDraw.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlay from '../../overlays/worldOverlay.js';
import * as geoid from '../../data/geoid.js';
import * as sprites from '../../data/spriteOrder.js';
import * as focus from '../../data/focusDeemphasis.js';
import * as worldFocus from '../../worldFocus.js';
import * as render from '../../renderGovernor.js';
import * as readouts from '../../hudReadouts.js';
import { fleetModelServices } from './fleetModels.js';

/**
 * The terrain a vessel layer reads its water levels from, out of the
 * application's surface services, or null without them. The terrain
 * service's own heights, not the rendered-mesh floor aircraft read: on the
 * water that can be a moored boat or a bridge.
 * @param {object|null} surface
 * @returns {object|null}
 */
export function vesselGround(surface) {
  const terrain = surface?.terrain;
  if (
    typeof terrain?.cachedRealEllipsoidalGround !== 'function' ||
    typeof terrain?.resolveEllipsoidalGround !== 'function'
  )
    return null;
  return {
    cachedRealEllipsoidalGround: terrain.cachedRealEllipsoidalGround,
    cachedRealOrthometricGround: terrain.cachedRealOrthometricGround,
    resolveEllipsoidalGround: terrain.resolveEllipsoidalGround,
  };
}

/**
 * Construct one layer using the application scene owners and a supplied
 * source. `displayParams` reads the Flights layer's DISPLAY-rail 3D
 * preference, under which nearby vessels are drawn as fleet models.
 * `placement`: a host-supplied placement for its live vessels, or null.
 * `surface`: the application's surface services; with them, vessels on lakes
 * and rivers are drawn at the water's own level (without, on the geoid).
 */
export function createApplicationVessels({
  source,
  placement = null,
  options = {},
  displayParams = null,
  resolveAsset,
  surface = null,
}) {
  const ground = vesselGround(surface);
  return createVesselLayer({
    source,
    options,
    services: {
      ground,
      context,
      trails,
      labels,
      picking,
      overlay,
      geoid,
      sprites,
      focus,
      worldFocus,
      render,
      readouts,
      placement,
      fleet: fleetModelServices({
        display: displayParams,
        ...(resolveAsset ? { resolveAsset } : {}),
      }),
    },
  });
}
