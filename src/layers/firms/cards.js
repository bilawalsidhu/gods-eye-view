import { t } from '../../i18n/index.js';
import {
  FIRMS_OVERLAY_SOURCE_ID,
  FIRMS_AMBIENT_COHORT_LIMIT,
} from '../../data/firmsLabels.js';
import { MAX_AMBIENT_LABELS, LABEL_VIEW_MARGIN_PX } from './policy.js';
import { canvasOf } from '../../render/rendererOf.js';

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
   * priority-ranked candidates, project each with the renderer's
   * `query.project`, and accept only candidates
   * ≥ LABEL_MIN_SEP_PX from every already-accepted card. Candidates whose
   * projection fails are dropped silently. SELECTION runs here, on LOD/
   * viewport rebuilds and camera moveEnd — never per frame; RENDERING is
   * the host, which re-projects the accepted entries every frame so
   * cards track the camera smoothly.
   */

  function rebuildAmbientLabels() {
    if (!layerState._viewer) return;
    const { query } = components.rendering.scenePorts();
    const project = (position) => query?.project(position) ?? null;
    // Ages count back from the time shown: the window's end, or now when live.
    const now = components.model.ageReferenceMs();
    const entries = [];
    /** @type {Array<{x: number, y: number}>} Screen positions of accepted labels. */
    const accepted = [];
    // Projection happily answers for points on the FAR side of the planet,
    // so without this the ≤18 ambient slots get spent on fires the overlay
    // host will then horizon-cull at paint time (`horizonCull: true` in
    // applyFirmsOverlayPolicy) — near-side fires silently lose their cards.
    // The renderer's ellipsoid horizon from the eye, the test the sprites'
    // GPU cull makes, so cards and sprites never disagree about which
    // hemisphere a detection is on.
    const beyondHorizon = (position) =>
      query ? query.isOccluded(position) : false;
    layerState._fireByCardId.clear();

    if (layerState._selectedFire) {
      const selectedCard = components.model.buildSelectedFireCard(
        layerState._selectedFire,
        now,
      );
      layerState._fireByCardId.set(selectedCard.id, layerState._selectedFire);
      entries.push(selectedCard);
      const screen = project(
        components.model.firePosition(layerState._selectedFire),
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

    const canvas = canvasOf(layerState._viewer);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    let ambientCount = 0;

    // An application drawing the detections in place of the markers draws
    // them unlabelled: only the selected fire's card shows then.
    const candidates = layerState._standIn ? [] : layerState._labelCandidates;
    for (const candidate of candidates) {
      if (ambientCount >= MAX_AMBIENT_LABELS) break;
      if (candidate.fire && candidate.fire === layerState._selectedFire)
        continue;
      // Spend the bounded cohort only on the visible hemisphere. At global
      // LOD, far-side cells can still project on-canvas; accepting those first
      // starves front-side cards before the host applies its authoritative cull.
      if (beyondHorizon(candidate.cullPosition || candidate.position)) continue;
      const screen = project(candidate.position);
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
          accessibilityLabel: t('Focus fire detection {title}, {details}', {
            title: card.title,
            details: card.details.join(', '),
          }),
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
