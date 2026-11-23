/**
 * @module entityMark
 * @description What Context marks an item with: the sprite the map draws it
 * with, for the layers that draw one per kind (aircraft by class, airport
 * vehicles and ground stations, vessels by type and the buoy of an aid to
 * navigation), or else its layer's glyph (`entityKind` in entityContext.js).
 */

import {
  AIRCRAFT_CLASS_LABELS,
  classifyAircraft,
} from '../data/aircraftClass.js';
import { aircraftIcon } from '../data/aircraftIcons.js';
import { entityKind } from '../data/entityContext.js';
import { aidSprite, vesselSprite } from '../data/vesselSprites.js';
import {
  VESSEL_KINDS,
  isAidToNavigation,
  vesselKind,
} from '../data/vesselTypes.js';

/** The layers whose map sprite follows the aircraft class. */
const AIRCRAFT_LAYERS = new Set(['flights', 'military', 'local-adsb']);
/** The layers whose map sprite follows the vessel kind. */
const VESSEL_LAYERS = new Set(['ais-live-vessels']);
/** Every class an aircraft sprite is drawn for, vehicles and stations too. */
const AIRCRAFT_KINDS = new Set(Object.keys(AIRCRAFT_CLASS_LABELS));
/** The kind an aid to navigation is marked as: the map's buoy. */
export const AID_MARK = 'aid';

const text = (value) =>
  value === null || value === undefined ? '' : String(value).trim();

/**
 * The sprite kind of an item, read from its layer record as the map picks
 * it: an aircraft's class (its own `aircraftClass`, else worked out from its
 * type), a vessel's kind, or {@link AID_MARK}. Empty for a layer that draws
 * no sprite per kind.
 * @param {string} layerId
 * @param {?object} source A layer record.
 * @returns {string}
 */
export function markKind(layerId, source) {
  if (!source) return '';
  if (AIRCRAFT_LAYERS.has(layerId)) {
    const own = text(source.aircraftClass);
    if (AIRCRAFT_KINDS.has(own)) return own;
    return classifyAircraft({
      typeCode: text(source.typeCode ?? source.type),
      category: source.category ?? null,
    });
  }
  if (VESSEL_LAYERS.has(layerId)) {
    const type = source.shipType ?? source.type;
    if (
      isAidToNavigation({
        type,
        mmsi: source.mmsi,
        virtual: source.virtual,
      })
    )
      return AID_MARK;
    return vesselKind(type);
  }
  return '';
}

/**
 * The sprite kind the map draws a layer's item of a kind with: an aircraft
 * layer's unknown kind is an airliner and a vessel layer's the default hull,
 * as on the map. Empty for a layer without sprites.
 * @param {string} layerId
 * @param {string} [kind] From {@link markKind}.
 * @returns {string}
 */
export function spriteKind(layerId, kind = '') {
  if (AIRCRAFT_LAYERS.has(layerId))
    return AIRCRAFT_KINDS.has(kind) ? kind : 'airliner';
  if (VESSEL_LAYERS.has(layerId))
    return kind === AID_MARK || VESSEL_KINDS.includes(kind) ? kind : 'other';
  return '';
}

/**
 * The map sprite of a layer's item of a kind ({@link spriteKind}), as an SVG
 * data URI, or '' for a layer without one.
 * @param {string} layerId
 * @param {string} [kind] From {@link markKind}.
 * @returns {string}
 */
export function markSprite(layerId, kind = '') {
  const shown = spriteKind(layerId, kind);
  if (!shown) return '';
  if (AIRCRAFT_LAYERS.has(layerId)) return aircraftIcon(shown);
  return shown === AID_MARK ? aidSprite() : vesselSprite(shown);
}

/**
 * The glyph a layer's items fall back to.
 * @param {string} layerId
 * @returns {string} A Material Symbols name.
 */
export const markGlyph = (layerId) => entityKind(layerId).icon;

/**
 * The inline style that draws a sprite as a mask over `currentColor`, one
 * em square (the size of the glyph it stands beside), or `size` pixels.
 * @param {string} uri
 * @param {?number} [size]
 * @returns {object}
 */
export function markStyle(uri, size = null) {
  const image = `url("${uri}")`;
  return {
    display: 'inline-block',
    flex: 'none',
    width: '1em',
    height: '1em',
    ...(size == null ? {} : { fontSize: `${size}px` }),
    verticalAlign: 'middle',
    backgroundColor: 'currentColor',
    WebkitMaskImage: image,
    maskImage: image,
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
    maskPosition: 'center',
    WebkitMaskSize: 'contain',
    maskSize: 'contain',
  };
}
