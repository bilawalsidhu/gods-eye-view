/**
 * @module entityMark
 * @description What Context marks an item with: the sprite the map draws it
 * with, for the layers that draw one per kind (aircraft by class, airport
 * vehicles and ground stations, vessels by type and the buoy of an aid to
 * navigation), or else its layer's glyph (`entityKind` in entityContext.js).
 */

import { isAircraftLayer } from '../data/aircraftLayerIds.js';
import {
  AIRCRAFT_CLASS_LABELS,
  classifyAircraft,
} from '../data/aircraftClass.js';
import { aircraftIcon } from '../data/aircraftIcons.js';
import { aidSprite, vesselSprite } from '../data/vesselSprites.js';
import { isAidToNavigation, vesselKind } from '../data/vesselTypes.js';

const VESSEL_LAYERS = new Set(['ais-live-vessels']);
const AIRCRAFT_KINDS = new Set(Object.keys(AIRCRAFT_CLASS_LABELS));
/** The kind an aid to navigation is marked as: the map's buoy. */
export const AID_MARK = 'aid';

const text = (value) =>
  value === null || value === undefined ? '' : String(value).trim();

/**
 * The sprite kind of an item, read from its card (`aircraftClass`,
 * `modelSubject`) or its layer record, as the map picks it: an aircraft's
 * class, a vessel's kind, or {@link AID_MARK}. Empty for a layer that draws
 * no sprite per kind.
 */
export function markKind(layerId, source) {
  if (!source) return '';
  const subject = source.modelSubject || source;
  if (isAircraftLayer(layerId)) {
    const own = text(source.aircraftClass);
    if (AIRCRAFT_KINDS.has(own)) return own;
    return classifyAircraft({
      typeCode: text(subject.typeCode ?? subject.type),
      category: subject.category ?? null,
    });
  }
  if (VESSEL_LAYERS.has(layerId)) {
    const type = subject.shipType ?? subject.type;
    if (
      isAidToNavigation({
        type,
        mmsi: subject.mmsi,
        virtual: subject.virtual,
      })
    )
      return AID_MARK;
    return vesselKind(type);
  }
  return '';
}

/**
 * The map sprite as an SVG data URI. Unknown kinds use the map's airliner
 * or default hull. Layers without sprites return an empty string.
 */
export function markSprite(layerId, kind = '') {
  if (isAircraftLayer(layerId))
    return aircraftIcon(AIRCRAFT_KINDS.has(kind) ? kind : 'airliner');
  if (!VESSEL_LAYERS.has(layerId)) return '';
  return kind === AID_MARK ? aidSprite() : vesselSprite(kind);
}
