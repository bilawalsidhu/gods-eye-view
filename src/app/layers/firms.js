import * as Cesium from 'cesium';
import { rendererFor } from './renderers.js';
import {
  createFirmsCesiumRenderer,
  projectFirmsWindow,
  firmsHorizonOccluder,
  FIRMS_LEFT_CLICK,
} from '../../layers/firms/render/cesium.js';
import { createFirmsHeatmapLayer as createLayer } from '../../layers/firms/index.js';
import * as render from '../../renderGovernor.js';
import * as sprites from '../../data/spriteOrder.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import * as focus from '../../worldFocus.js';
export const firmsServices = {
  render,
  sprites,
  context,
  picking,
  overlays,
  focus,
};

/** Bind a supplied fire feed to the application scene service owners. */
export function createApplicationFirms({ surface, ...options }) {
  return createLayer({
    ...options,
    icon: options.icon ?? '▲',
    source: options.source ?? 'NASA FIRMS',
    feed: options.feed,
    services: { ...firmsServices, anchors: surface.anchors },
    renderer: options.renderer ?? {
      create: ({ engine = null, ...renderOptions }) =>
        engine
          ? rendererFor('local-firms', engine, renderOptions)
          : createFirmsCesiumRenderer(null, renderOptions),
    },
    projectToWindow: options.projectToWindow ?? projectFirmsWindow,
    horizonOccluder: options.horizonOccluder ?? firmsHorizonOccluder,
    leftClickEventType: options.leftClickEventType ?? FIRMS_LEFT_CLICK,
    overlayHost: options.overlayHost ?? {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    screenSpaceEventHandlerFactory:
      options.screenSpaceEventHandlerFactory ??
      ((viewer) => new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)),
  });
}
