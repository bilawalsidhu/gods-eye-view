/**
 * @module alpr/markerState
 * @description The ALPR layer's markers: one icon per camera in a draw set,
 * and the layer's own per-marker state, held in the layer. Each marker is a
 * plain carrier object (`{ id, show }`) that the layer registers as the
 * camera's context entity; its state lives in `alprMarkers`:
 * - `record`: the camera record the marker shows.
 * - `position`, `clamped`: where the badge is drawn natively, and whether it
 *   follows the ground there rather than sitting at its height.
 * - `selected`: drawn with the selected badge.
 * - `canvasPosition`, `displayPosition`: the canvas anchor and the position the card reads.
 * - `wedge`: the direction wedge's positions, plain ECEF.
 * - `canvasOwned`: the overlay canvas draws the badge; the icon stays as a
 *   faint pick target at the canvas anchor.
 * - `shown`, `surfaceCheckedFor`: whether the icon shows and the anchor last checked.
 */
import { createEntityStore } from '../../data/entityRecords.js';
import {
  MARKER_ICON_SIZE,
  MARKER_SCALE_BY_DISTANCE,
  SELECTED_MARKER_ICON_SIZE,
} from './policy.js';
import { MARKER_IMAGE, SELECTED_IMAGE } from './visuals.js';

export const alprMarkers = createEntityStore();

const [NEAR, NEAR_SCALE, FAR, FAR_SCALE] = MARKER_SCALE_BY_DISTANCE;
/** City-wide views hold hundreds of badges; they shrink with distance. */
const SCALE_BY_DISTANCE = Object.freeze({
  near: NEAR,
  nearValue: NEAR_SCALE,
  far: FAR,
  farValue: FAR_SCALE,
});
/** Under the canvas badge: faint, but still picked. */
const PICK_TARGET_COLOR = Object.freeze([1, 1, 1, 0.01]);

/**
 * Where a marker's icon is drawn: the canvas anchor while the canvas owns
 * it, else its native position.
 * @param {{id: string}} carrier
 * @returns {import('../../render/contract/common').Ecef|null|undefined}
 */
export function alprIconPosition(carrier) {
  const marker = alprMarkers.read(carrier);
  if (!marker) return null;
  return marker.canvasOwned && marker.canvasPosition
    ? marker.canvasPosition
    : marker.position;
}

/**
 * The icon a marker draws now.
 * @param {{id: string}} carrier
 * @returns {import('../../render/contract/draw').IconItem}
 */
export function alprIconItem(carrier) {
  const marker = alprMarkers.read(carrier) ?? {};
  const canvas = Boolean(marker.canvasOwned && marker.canvasPosition);
  const size = marker.selected ? SELECTED_MARKER_ICON_SIZE : MARKER_ICON_SIZE;
  return {
    id: carrier.id,
    pos: canvas ? marker.canvasPosition : marker.position,
    // Ground clamping is the placeholder until a marker's floor resolves.
    height: !canvas && marker.clamped ? 'clampGround' : 'absolute',
    image: marker.selected ? SELECTED_IMAGE : MARKER_IMAGE,
    size: [size, size],
    disableDepthTest: Number.POSITIVE_INFINITY,
    show: marker.shown !== false,
    ...(canvas
      ? { color: PICK_TARGET_COLOR }
      : { scaleByDistance: SCALE_BY_DISTANCE }),
  };
}

/** What tells one drawn icon from another, so unchanged ones are not sent again. */
function itemKey(item) {
  const { pos } = item;
  return [
    pos?.x,
    pos?.y,
    pos?.z,
    item.height,
    item.image,
    item.size[0],
    item.show,
    item.color ? 'pick' : 'badge',
  ].join('|');
}

/**
 * The layer's markers, drawn as one icon set: carriers by camera id, and
 * the writes to the set, batched until `flush`.
 * @returns {object}
 */
export function createAlprMarkerSet() {
  const carriers = new Map();
  /** The key of each icon last sent to the set, by id. */
  const sent = new Map();
  const dirty = new Set();
  let icons = null;

  function flush() {
    if (!icons || !dirty.size) return;
    const items = [];
    for (const carrier of dirty) {
      if (carriers.get(carrier.id) !== carrier) continue;
      const item = alprIconItem(carrier);
      if (!item.pos) continue;
      const key = itemKey(item);
      if (sent.get(carrier.id) === key) continue;
      sent.set(carrier.id, key);
      items.push(item);
    }
    dirty.clear();
    if (items.length) icons.upsert(items);
  }

  return {
    /** Draw the markers into `set`, an icon set made for them. */
    attach(set) {
      icons = set;
    },
    /** The icon set, while attached. */
    get icons() {
      return icons;
    },
    get size() {
      return carriers.size;
    },
    get(id) {
      return carriers.get(id) ?? null;
    },
    values() {
      return carriers.values();
    },
    /** A new marker for `id`, drawn at the next `flush`. */
    add(id) {
      const carrier = { id, show: true };
      carriers.set(id, carrier);
      dirty.add(carrier);
      return carrier;
    },
    /** Remove the markers with these ids now. */
    remove(ids) {
      const gone = [];
      for (const id of ids) {
        if (!carriers.delete(id)) continue;
        sent.delete(id);
        gone.push(id);
      }
      if (gone.length) icons?.remove(gone);
    },
    /** Redraw `carrier` at the next `flush`, if how it draws changed. */
    changed(carrier) {
      if (carrier) dirty.add(carrier);
    },
    flush,
    clear() {
      carriers.clear();
      sent.clear();
      dirty.clear();
      icons?.clear();
    },
    dispose() {
      carriers.clear();
      sent.clear();
      dirty.clear();
      icons?.dispose();
      icons = null;
    },
  };
}
