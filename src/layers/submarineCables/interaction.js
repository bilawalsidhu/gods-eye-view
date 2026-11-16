import { toRadians } from '../../geo/vector.js';
import { cameraOf } from '../../render/rendererOf.js';

const CARD_BACKGROUND_ID = 'submarine-cables';

export function createInteraction({
  state,
  parts,
  inputFor,
  overlayHost,
  picking,
}) {
  function beginInteraction(viewer) {
    if (state._clickSubscription) return;
    // Our cables stand aside for a card painted over them (below), so that
    // card's layer may act on the click; without a hit-test they cannot.
    if (overlayHost?.hitTest)
      picking?.registerCardBackground?.(
        CARD_BACKGROUND_ID,
        (hit) => state._enabled && Boolean(resolvePickRecord(hit)?.reference),
      );
    const unsubscribe = inputFor(viewer).onClick((event) => {
      if (!state._enabled) return;
      // Cable labels are not interactive, so any overlay entry hit here is
      // another layer's card or label painted over the cable: its click.
      if (
        overlayHost?.hitTest?.(event.screenPosition?.x, event.screenPosition?.y)
      )
        return;
      const record = resolvePickRecord(event.drawHit);
      if (!record?.reference) return;
      flyToReference(viewer, record.reference);
    });
    state._clickSubscription = () => {
      unsubscribe();
      picking?.unregisterCardBackground?.(CARD_BACKGROUND_ID);
    };
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
