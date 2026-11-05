import * as Cesium from 'cesium';
import { createRadiosondesLayer } from '../../layers/radiosondes/index.js';
import * as render from '../../renderGovernor.js';
import * as sprites from '../../data/spriteOrder.js';
import * as geoid from '../../data/geoid.js';
import * as picking from '../../data/pickRegistry.js';
import * as focus from '../../worldFocus.js';
import { hitTestWorldOverlay } from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { createCredits } from '../../layers/streetLevel/credits.js';
import { overlayHost } from './overlayHost.js';

/** Wire SondeHub observations to the application scene and supplied source. */
export function createApplicationRadiosondes({ groundFloor, source }) {
  return createRadiosondesLayer({
    source,
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    services: {
      groundFloor,
      render,
      sprites,
      geoid,
      picking,
      focus,
      pointer: { isPointerFree },
      credits: createCredits(),
    },
    overlayHost: {
      ...overlayHost,
      hitTest: hitTestWorldOverlay,
    },
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
  });
}
