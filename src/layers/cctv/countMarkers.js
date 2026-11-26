import { createCountMarkerLane } from '../../overlays/countMarkers.js';
import {
  CAMERA_GREEN,
  COUNT_CAMERA_ICON,
  CAMERA_ICON_PX,
  COUNT_MERGE_GAP_PX,
} from './policy.js';

/** CCTV count markers: green rings with the camera glyph over the count. */
const CCTV_COUNT_STYLE = Object.freeze({
  color: CAMERA_GREEN,
  glyph: Object.freeze({
    src: COUNT_CAMERA_ICON,
    // Painted bounds of the camera art, scaled from its viewBox to source pixels.
    source: Object.freeze([3.4, 13.4, 28.1, 19.5].map((v) => (v * 48) / 36)),
    // Reserve the camera's landscape slot even while the map sprite is loading.
    slotAspect: 1.5,
  }),
  iconPx: CAMERA_ICON_PX,
  gap: COUNT_MERGE_GAP_PX,
});

/** Merged camera groups and their last painted hit rectangles in CSS pixels. */
export function createCountMarkers(
  registerPaintLane,
  id,
  refreshView,
  keyholeAlpha,
) {
  return createCountMarkerLane(
    registerPaintLane,
    id,
    refreshView,
    keyholeAlpha,
    CCTV_COUNT_STYLE,
  );
}
