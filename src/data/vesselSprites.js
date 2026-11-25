/**
 * @module vesselSprites
 * @description The map sprites of the vessel layer, as SVG data URIs: one hull
 * per vessel kind (`vesselKind` in vesselTypes.js), seen from above with its
 * bow up (north), and one buoy for every aid to navigation, standing upright.
 *
 * Every sprite is white with dark detail, drawn on the 96-unit frame of
 * aircraftIcons.js (centre 48,48). The layer tints it at draw time (the
 * kind's colour, white while selected), so one image serves every colour and
 * state, as the aircraft glyphs do: one icon-atlas slot per shape. Hulls
 * share one length and differ in shape only; widths are exaggerated so they
 * read at small sizes.
 */

const VIEW = 96;
const C = VIEW / 2;

/** Raster size of every vessel sprite (px): sharp at its largest drawn size. */
export const VESSEL_SPRITE_PX = 64;

/** The hull edge: dark so a light tint still reads on light ground. */
const EDGE =
  'stroke="rgba(4,18,24,0.9)" stroke-width="2.1" stroke-linejoin="round"';
/** Superstructure and deck detail: dark, so tinting leaves it dark. */
const DETAIL = 'fill="rgba(4,18,24,0.42)"';

/** Each kind's hull and detail, centred, bow toward −Y. */
const HULLS = {
  // Container ship: fine bow, long parallel sides, square stern; container
  // rows forward and the bridge aft.
  cargo: `
    <path d="M0,-43 C -7,-41 -13,-36 -16.8,-28 L -16.8,37 L -14.7,43 L 14.7,43
             L 16.8,37 L 16.8,-28 C 13,-36 7,-41 0,-43 Z" fill="white" ${EDGE}/>
    <path d="M-13,-26 h26 v5 h-26 Z M-13,-19 h26 v5 h-26 Z M-13,-12 h26 v5 h-26 Z
             M-13,-5 h26 v5 h-26 Z M-13,2 h26 v5 h-26 Z M-13,9 h26 v5 h-26 Z
             M-13,16 h26 v5 h-26 Z M-16,26 h32 v4 h-32 Z" ${DETAIL}/>`,

  // Tanker: full bow, a pipe run down the centre line with its manifold
  // across, the bridge aft.
  tanker: `
    <path d="M0,-43 C -8,-42 -15,-37 -17.9,-30 L -17.9,36 L -15.3,43 L 15.3,43
             L 17.9,36 L 17.9,-30 C 15,-37 8,-42 0,-43 Z" fill="white" ${EDGE}/>
    <path d="M-1.3,-34 h2.6 v62 h-2.6 Z M-14,-5.6 h28 v3.2 h-28 Z
             M-17.4,28.6 h34.8 v5.3 h-34.8 Z" ${DETAIL}/>`,

  // Passenger ship or ferry: a superstructure covering nearly the whole deck.
  passenger: `
    <path d="M0,-43 C -6,-41.5 -12,-36 -15.3,-29.6 L -17.1,-28 L -17.1,30.5
             L -15.6,39 L -14.2,43 L 14.2,43 L 15.6,39 L 17.1,30.5 L 17.1,-28
             L 15.3,-29.6 C 12,-36 6,-41.5 0,-43 Z" fill="white" ${EDGE}/>
    <path d="M-14.6,-27 h29.2 v55 h-29.2 Z" ${DETAIL}/>
    <path d="M-2.5,6 h5 v8 h-5 Z" fill="white"/>`,

  // High-speed craft: a catamaran, two slim bows and a square stern.
  highspeed: `
    <path d="M-17.9,-32.3 L -16.1,-33.1 L -14.7,-39.9 L -13.4,-43 L -12.1,-40.7
             L -9.9,-32.4 L 9.9,-32.4 L 12.1,-40.7 L 13.4,-43 L 14.7,-39.9
             L 16.1,-33.1 L 17.9,-32.3 L 17.9,43 L 9.3,43 L 8.3,42.2 L -8.3,42.2
             L -9.3,43 L -17.9,43 Z" fill="white" ${EDGE}/>
    <path d="M-9.7,-14.6 h19.4 v12.8 h-19.4 Z" ${DETAIL}/>`,

  // Fishing vessel: a narrow hull, the wheelhouse forward and outrigger
  // booms across amidships.
  fishing: `
    <path d="M-24,2.3 h48 v3.2 h-48 Z" fill="white" ${EDGE}/>
    <path d="M0,-43 C -5,-40 -9.5,-31 -11.7,-24.8 L -13.1,-17.7 L -13.1,30.4
             L -11.1,41.1 L -9.9,43 L 9.9,43 L 11.1,41.1 L 13.1,30.4 L 13.1,-17.7
             L 11.7,-24.8 C 9.5,-31 5,-40 0,-43 Z" fill="white" ${EDGE}/>
    <path d="M-8.8,-20.4 h17.6 v12.1 h-17.6 Z" ${DETAIL}/>`,

  // Tug, pilot or service boat: short, wide and blunt, the wheelhouse
  // amidships and two towing bitts aft.
  tug: `
    <path d="M-7,-43 L 7,-43 C 14,-40 20,-33 22.5,-22 L 24,-13 L 24,19
             C 24,28 21,36 17,42 L 16,43 L -16,43 L -17,42 C -21,36 -24,28
             -24,19 L -24,-13 L -22.5,-22 C -20,-33 -14,-40 -7,-43 Z"
          fill="white" ${EDGE}/>
    <path d="M-13.9,-12.9 h27.8 v12.3 h-27.8 Z M-12.4,4.8 h5 v4.3 h-5 Z
             M7.4,4.8 h5 v4.3 h-5 Z" ${DETAIL}/>`,

  // Sailing boat: a rounded hull with its sail filled to one side.
  sailing: `
    <path d="M0,-43 C -6,-40 -12,-31 -15.5,-21 C -18,-13 -19.4,-5 -19.4,3
             L -19.3,34.2 L -17.1,39.8 L -14.3,43 L 14.3,43 L 17.1,39.8
             L 19.3,34.2 L 19.4,3 C 19.4,-5 18,-13 15.5,-21 C 12,-31 6,-40 0,-43 Z"
          fill="white" ${EDGE}/>
    <path d="M0,-30 Q 21.6,-6 2,26 L -1,26 Q 7.8,-4 0,-30 Z" fill="white"
          stroke="rgba(4,18,24,0.9)" stroke-width="1.4" stroke-linejoin="round"/>
    <circle cx="0" cy="-12" r="2.6" fill="rgba(4,18,24,0.85)"/>`,

  // Pleasure craft: a motor yacht, fine bow and a long cabin.
  pleasure: `
    <path d="M0,-43 C -5,-40 -11,-31 -15.9,-19.8 L -17.9,-12.6 L -17.9,32.7
             L -17.2,37.6 L -16.2,38.2 L -16.2,43 L 16.2,43 L 16.2,38.2
             L 17.2,37.6 L 17.9,32.7 L 17.9,-12.6 L 15.9,-19.8 C 11,-31 5,-40 0,-43 Z"
          fill="white" ${EDGE}/>
    <path d="M-15.2,-12.8 h30.4 v34.5 h-30.4 Z" ${DETAIL}/>`,

  // Military, law enforcement or rescue: a patrol boat, sharp bow, a gun
  // forward of the bridge.
  military: `
    <path d="M0,-43 C -4,-41 -9.6,-32 -12.6,-25.2 L -14.8,-17.1 L -15.3,-11.7
             L -15.1,36.8 L -13.8,41.3 L -12.6,43 L 12.6,43 L 13.8,41.3
             L 15.3,36.8 L 15.3,-11.7 L 14.8,-17.1 L 12.6,-25.2 C 9.6,-32 4,-41 0,-43 Z"
          fill="white" ${EDGE}/>
    <path d="M-10.2,-13.4 h20.4 v10 h-20.4 Z M-4.2,9.6 h8.4 v6.5 h-8.4 Z" ${DETAIL}/>
    <circle cx="0" cy="-22" r="3.2" ${DETAIL}/>`,

  // Any other vessel: a plain hull with a deckhouse aft.
  other: `
    <path d="M0,-43 C -6,-42 -12,-37 -14.8,-29.9 L -17.4,-23.3 L -17.9,-19.4
             L -17.9,35.6 L -16.9,39.3 L -14.9,43 L 14.9,43 L 16.9,39.3
             L 17.9,35.6 L 17.9,-19.4 L 17.4,-23.3 L 14.8,-29.9 C 12,-37 6,-42 0,-43 Z"
          fill="white" ${EDGE}/>
    <path d="M-10.8,8.3 h21.6 v13.1 h-21.6 Z" ${DETAIL}/>`,
};

/**
 * The buoy every aid to navigation is drawn as, seen from the side: a
 * flared float with a dark waterline band, a tapering body, a lantern and a
 * round top-mark, centred on the frame. No halo; it is never turned.
 */
const BUOY = `
    <path d="M27.6,36.5 L 26.4,31.5 L 25.2,27.5 L 14.4,23.5 L 11.4,-7.5
             L 12.6,-7.5 L 12.6,-10.5 L 3.8,-10.5 L 2.9,-17.5 L -2.9,-17.5
             L -3.8,-10.5 L -12.6,-10.5 L -12.6,-7.5 L -11.4,-7.5 L -14.4,23.5
             L -25.2,27.5 L -26.4,31.5 L -27.6,36.5 Z" fill="white" ${EDGE}/>
    <path d="M26.4,31.5 L 27.6,36.5 L -27.6,36.5 L -26.4,31.5 Z
             M-12.6,-10.5 h25.2 v3 h-25.2 Z" fill="rgba(4,18,24,0.7)"/>
    <path d="M-1.9,-22 h3.8 v4.5 h-3.8 Z" fill="white" ${EDGE}/>
    <circle cx="0" cy="-30" r="7" fill="white" ${EDGE}/>`;

const cache = new Map();

const b64 = (s) =>
  typeof btoa === 'function'
    ? btoa(s)
    : Buffer.from(s, 'utf8').toString('base64');

function sprite(key, body) {
  let uri = cache.get(key);
  if (!uri) {
    const px = VESSEL_SPRITE_PX;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${VIEW} ${VIEW}"><g transform="translate(${C},${C})">${body}</g></svg>`;
    uri = 'data:image/svg+xml;base64,' + b64(svg);
    cache.set(key, uri);
  }
  return uri;
}

/**
 * The hull sprite of a vessel kind (`other` for one it does not know).
 * @param {string} kind One of `VESSEL_KINDS`.
 * @returns {string} SVG data URI.
 */
export function vesselSprite(kind) {
  const k = HULLS[kind] ? kind : 'other';
  return sprite(k, HULLS[k]);
}

/**
 * The buoy sprite of every aid to navigation.
 * @returns {string} SVG data URI.
 */
export function aidSprite() {
  return sprite('aid', BUOY);
}
