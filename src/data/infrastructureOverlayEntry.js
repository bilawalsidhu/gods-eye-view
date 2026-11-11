const LOCAL_OVERLAY_MAX_DISTANCE_M = 14000000;
const LOCAL_OVERLAY_FADE_START_M = 250000;
const LOCAL_OVERLAY_FADE_START_RATIO =
  LOCAL_OVERLAY_FADE_START_M / LOCAL_OVERLAY_MAX_DISTANCE_M;

/** Shared ambient infrastructure card contract; the host owns projection and persistence. */
export function createInfrastructureOverlayEntry({
  id,
  source,
  position,
  title,
  details = [],
  accent,
  priority,
}) {
  return {
    id: String(id),
    source: source,
    position,
    variant: 'card',
    title: title,
    details: details,
    accent,
    priority,
    collisionGroup: 'ambient-card',
    zIndex: 30,
    interactive: false,
    minDistance: 0,
    maxDistance: LOCAL_OVERLAY_MAX_DISTANCE_M,
    distanceFadeStartRatio: LOCAL_OVERLAY_FADE_START_RATIO,
    distanceScale: {
      near: 250000,
      nearValue: 1,
      far: 9000000,
      farValue: 0.62,
    },
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    placement: 'above',
  };
}
