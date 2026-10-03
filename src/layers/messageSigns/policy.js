/** Layer identity, shared by the manager, state registry and entity contexts. */
export const LAYER_ID = 'message-signs';
export const LAYER_NAME = 'Message Signs';

/** The app-origin route; upstreams need a proxy (see server/providers/messageSigns.js). */
export const SIGNS_URL = '/api/signs';

/** The server caches at this interval too, so extra clients cost no upstream. */
export const REFRESH_MS = 60 * 1000;

/** How long a board holds each page before cycling. */
export const PAGE_DWELL_MS = 4000;

/** Board face geometry, in metres, at true scale for a highway DMS. */
export const BOARD_WIDTH_M = 9;
export const BOARD_HEIGHT_M = 3;
/** Bottom of the board above the roadway. */
export const BOARD_MOUNT_M = 6;

/** Amber on black, as a real dot-matrix board. */
export const BOARD_BACKGROUND = '#07070a';
export const BOARD_TEXT = '#ffb000';
export const BOARD_BEZEL = '#1a1a22';

/** How far the opaque housing back sits behind the lit face. */
export const BOARD_BACK_OFFSET_M = 0.2;

/** Canvas pixels per metre of board; sets texture resolution. */
export const BOARD_PIXELS_PER_M = 64;
/** Inset from the bezel to the lit area, as a fraction of board height. */
export const BOARD_PADDING_RATIO = 0.08;

/** Beyond this the face is unreadable, so it stops drawing. */
export const BOARD_VISIBLE_M = 40000;
/**
 * The marker draws at every range inside this, including close up: the board
 * is a vertical plane and reads as edge-on from above, and the marker is also
 * the click target.
 */
export const MARKER_VISIBLE_M = 1500000;
/** Marker glyph texture size and the pixel box it holds on screen. */
export const GLYPH_PX = 64;
export const GLYPH_MIN_PX = 18;
export const GLYPH_MAX_PX = 34;

/** Camera range used when flying to read a board face. */
export const FOCUS_RANGE_M = 90;
