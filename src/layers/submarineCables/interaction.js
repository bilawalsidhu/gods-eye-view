import { toRadians } from '../../geo/vector.js';
import { cameraOf } from '../../render/rendererOf.js';

export function createInteraction({ state, parts, inputFor, picking }) {
  function beginInteraction(viewer) {
    if (state._clickSubscription) return;
    state._clickSubscription = inputFor(viewer).onClick((event) => {
      if (!state._enabled) return;
      // Cable labels are not interactive, so any card or label painted on
      // top is another layer's, painted over the cable: its click.
      if (picking?.clickCard?.(event)) return;
      const record = resolvePickRecord(event.drawHit);
      if (!record?.reference) return;
      flyToReference(viewer, record.reference);
    });
  }

  /**
   * What a click's draw hit names: a cable, landing point or reference of
   * this layer's current items, as `{ label, kind, featureId, reference }`,
   * or null.
   */
  function resolvePickRecord(hit) {
    return parts.rendering.pickInfo(hit);
  }

  function flyToReference(viewer, reference) {
    if (!viewer || !reference) return;
    const camera = cameraOf(viewer);
    camera.cancelFlight();
    camera.flyTo(
      { lon: reference.lon, lat: reference.lat, height: 6500 },
      {
        orientation: {
          heading: camera.pose().heading || 0,
          pitch: toRadians(-52),
          roll: 0,
        },
        durationS: 1.35,
        easing: 'cubicInOut',
      },
    );
  }
  return {
    beginInteraction,
    resolvePickRecord,
    flyToReference,
  };
}
