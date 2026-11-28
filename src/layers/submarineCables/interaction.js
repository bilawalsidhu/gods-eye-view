import {
  centerOnClick,
  yieldSelectionToOthers,
} from '../../data/clickSelect.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { CABLE_LAYER_ID } from './policy.js';

export function createInteraction({ state, parts, inputFor, picking }) {
  function beginInteraction(viewer) {
    if (state._clickSubscription) return;
    state._clickSubscription = inputFor(viewer).onClick((event) => {
      if (!state._enabled) return;
      // Cable labels are not interactive, so any card or label painted on
      // top is another layer's, painted over the cable: its click (and its
      // selection, if it makes one, puts the name card away).
      if (picking?.clickCard?.(event)) return;
      const record = resolvePickRecord(event.drawHit);
      // A click on anything else puts the name card away.
      if (!record?.reference) {
        parts.rendering.select(null);
        return;
      }
      // The card stands where the click met a cable's line (or an area), and
      // at the reference of a pin, stem or reference dot, which stand above
      // the ground; the camera centres there once, as a click on any
      // selected thing does.
      const reference = fromDegrees(
        record.reference.lon,
        record.reference.lat,
        0,
      );
      const at = parts.rendering.onSurface(event.drawHit)
        ? (event.ground?.() ?? reference)
        : reference;
      parts.rendering.select(record, at);
      centerOnClick(viewer, () => at);
    });
    // Another layer selected something: the name card goes.
    state._selectionYield ??= yieldSelectionToOthers(
      CABLE_LAYER_ID,
      () => Boolean(state._selected),
      () => parts.rendering.select(null),
    );
  }

  /**
   * What a click's draw hit names: a cable, landing point or reference of
   * this layer's current items, as `{ label, kind, featureId, reference }`,
   * or null.
   */
  function resolvePickRecord(hit) {
    return parts.rendering.pickInfo(hit);
  }

  return {
    beginInteraction,
    resolvePickRecord,
  };
}
