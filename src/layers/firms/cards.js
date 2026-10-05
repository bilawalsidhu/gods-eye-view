import * as Cesium from 'cesium';
import {
  FIRMS_OVERLAY_SOURCE_ID,
  FIRMS_AMBIENT_COHORT_LIMIT,
} from '../../data/firmsLabels.js';
import { MAX_AMBIENT_LABELS, LABEL_VIEW_MARGIN_PX } from './policy.js';

export function createCards({
  layerState,
  services,
  components,
  config,
  feed,
}) {
  const { overlayHost } = config;

  /**
   * Rebuild the card entries for the shared world-overlay host: the
   * selected-fire detail card (if any) plus at most MAX_AMBIENT_LABELS
   * ambient cards picked by a greedy screen-space declutter — walk the
   * priority-ranked candidates, project each with
   * SceneTransforms.worldToWindowCoordinates, and accept only candidates
   * ≥ LABEL_MIN_SEP_PX from every already-accepted card. Candidates whose
   * projection fails are dropped silently. SELECTION runs here, on LOD/
   * viewport rebuilds and camera moveEnd — never per frame; RENDERING is
   * the host, which re-projects the accepted entries every frame so
   * cards track the camera smoothly.
   */

  function rebuildAmbientLabels() {
    if (!layerState._viewer) return;
    const scene = layerState._viewer.scene;
    const now = Date.now();
    const entries = [];
    /** @type {Array<{x: number, y: number}>} Screen positions of accepted labels. */
    const accepted = [];
    // worldToWindowCoordinates happily projects points on the FAR side of the
    // planet, so without this the ≤18 ambient slots get spent on fires the
    // overlay host will then horizon-cull at paint time (`horizonCull: true`
    // in applyFirmsOverlayPolicy) — near-side fires silently lose their cards.
    // Shared with the sprite pass (fireHorizonOccluder) so cards and sprites
    // never disagree about which hemisphere a detection is on.
    const occluder = components.rendering.fireHorizonOccluder();
    const beyondHorizon = (position) =>
      occluder ? occluder.isPointVisible(position) !== true : false;
    layerState._fireByCardId.clear();

    if (layerState._selectedFire) {
      const selectedCard = components.model.buildSelectedFireCard(
        layerState._selectedFire,
        now,
      );
      layerState._fireByCardId.set(selectedCard.id, layerState._selectedFire);
      entries.push(selectedCard);
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        components.model.firePosition(layerState._selectedFire),
        layerState.scratchWindowCoord,
      );
      // Seed the accepted list so ambient cards keep clear of the detail card.
      // A selected fire behind the limb is not painted, so it must not reserve
      // screen space either.
      if (
        screen &&
        !beyondHorizon(
          components.model.fireCullPosition(layerState._selectedFire),
        )
      ) {
        accepted.push({ x: screen.x, y: screen.y });
      }
    }

    const width = scene.canvas.clientWidth;
    const height = scene.canvas.clientHeight;
    let ambientCount = 0;

    for (const candidate of layerState._labelCandidates) {
      if (ambientCount >= MAX_AMBIENT_LABELS) break;
      if (candidate.fire && candidate.fire === layerState._selectedFire)
        continue;
      // Spend the bounded cohort only on the visible hemisphere. At global
      // LOD, far-side cells can still project on-canvas; accepting those first
      // starves front-side cards before the host applies its authoritative cull.
      if (beyondHorizon(candidate.cullPosition || candidate.position)) continue;
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        candidate.position,
        layerState.scratchWindowCoord,
      );
      if (!screen) continue; // projection failed (e.g. behind camera) — drop silently
      if (
        screen.x < -LABEL_VIEW_MARGIN_PX ||
        screen.x > width + LABEL_VIEW_MARGIN_PX ||
        screen.y < -LABEL_VIEW_MARGIN_PX ||
        screen.y > height + LABEL_VIEW_MARGIN_PX
      )
        continue;
      if (!components.model.screenSeparated(accepted, screen)) continue;
      accepted.push({ x: screen.x, y: screen.y });
      ambientCount += 1;
      const card = candidate.fire
        ? components.model.buildFireCard(candidate, now)
        : components.model.buildCellCard(candidate, now);
      if (candidate.fire) layerState._fireByCardId.set(card.id, candidate.fire);
      entries.push(card);
    }

    overlayHost.setEntries(
      FIRMS_OVERLAY_SOURCE_ID,
      entries.map((entry) => {
        const card = components.model.applyFirmsOverlayPolicy(
          entry,
          layerState._labelLodDistance,
        );
        if (!card.interactive) return card;
        return {
          ...card,
          accessibilityLabel: `Focus fire detection ${card.title}, ${card.details.join(', ')}`,
          activate: () => {
            const fire = layerState._fireByCardId.get(card.id);
            if (!fire) return false;
            components.selection.selectAndFocusFire(fire);
            return true;
          },
        };
      }),
      {
        cohortLimit: FIRMS_AMBIENT_COHORT_LIMIT,
        collisionCapacity: FIRMS_AMBIENT_COHORT_LIMIT,
        moving: false,
      },
    );
  }
  return { rebuildAmbientLabels };
}
