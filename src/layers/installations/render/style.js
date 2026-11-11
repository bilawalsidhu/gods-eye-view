// The Mapped Installations look on every engine: sizes in CSS pixels,
// colours as rgba in 0..1, and the draw orders of the layer's sets. The
// class colours are policy.js's COLOR_BY_CLASS (model.js colorFor).

import { COLOR_BY_CLASS } from '../policy.js';

/** A site's disc; the selected site's, drawn white over the others. */
export const MARKER_SIZE_PX = 9;
export const SELECTED_MARKER_SIZE_PX = 13;
export const SELECTED_MARKER_COLOR = Object.freeze([1, 1, 1, 1]);
/** A named area's disc. */
export const NAMED_MARKER_SIZE_PX = 7;
export const MARKER_OUTLINE_PX = 1;
export const MARKER_OUTLINE_COLOR = Object.freeze([0, 0, 0, 0.8]);
export const NAMED_MARKER_OUTLINE_COLOR = Object.freeze([0, 0, 0, 1]);

/** A site's outlines on the ground, in its class colour. */
export const OUTLINE_WIDTH_PX = 2;
export const OUTLINE_ALPHA = 0.85;
/** The selected site's footprints on the ground, in its class colour. */
export const SELECTION_FILL_ALPHA = 0.22;

// Map data under the moving contacts (src/data/spriteOrder.js); the named
// discs over the sites' discs, the selected disc over both.
export const MARKER_ORDER = -1;
export const NAMED_MARKER_ORDER = -0.75;
export const SELECTED_MARKER_ORDER = -0.5;
// The outlines over the selection fill.
export const SELECTION_FILL_ORDER = 0;
export const OUTLINE_ORDER = 1;

const DEFAULT_ACCENT = '#9ca6b0';

/** A site's card and title accent: its class colour, in CSS. */
export const installationAccent = (record) =>
  COLOR_BY_CLASS[record?.class] || DEFAULT_ACCENT;
