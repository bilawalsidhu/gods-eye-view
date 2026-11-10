import { createSatellitesDisplay } from '../layers/satellites/render/display.js';

export function satelliteServices() {
  const noop = () => {};
  return {
    renderer: {
      create: ({ engine }) => createSatellitesDisplay(engine),
    },
    overlays: {
      setEntries: noop,
      setVisible: noop,
      clearSource: noop,
    },
    layerState: { isExplicitLayerStateOrigin: () => false },
    focus: {
      clearFocusTarget: noop,
      publishFocusTargetFromCachedPosition: noop,
      getFocusTarget: () => null,
    },
    context: {
      clearTrackedSubjectContext: noop,
      getContextStore: () => ({ entities: new Map() }),
      refreshTrackedSubjectContext: noop,
      selectTrackedSubjectContext: noop,
    },
    readout: { refreshTrackedReadout: noop },
    render: { holdContinuousRender: noop, releaseContinuousRender: noop },
    picking: { registerPickOwner: noop, unregisterPickOwner: noop },
  };
}
