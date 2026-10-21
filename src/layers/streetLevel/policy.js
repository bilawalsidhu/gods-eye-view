// Reached by the providers' source modules (no browser globals, see
// check:boundaries), so no i18n import: the text stays English data here.
const msg = (text) => text;

/** Identity and shared tuning for the provider-neutral Street Level layer. */
export const STREET_LEVEL_LAYER_ID = 'street-level';

/**
 * The pixel window a click picks in: coverage lines are 2.5 px wide and there
 * is no hover cue, so a click a few pixels off still finds the line.
 */
export const CLICK_PICK_WINDOW_PX = 9;

/** Pick id of the viewer position marker; the core owns it, not a provider. */
export const POSITION_PICK_ID = 'sl:pos';

/** One colour per imagery source: chip, coverage lines and cones. */
export const PROVIDER_COLORS = Object.freeze({
  mapillary: '#05cb63',
  google: '#4285f4',
  kartaview: '#635bff',
  panoramax: '#ff6f00',
});

/** Colours every provider shares: the selection highlight and the marker. */
export const COLORS = Object.freeze({
  selected: '#00d4ff',
  position: '#ffb300',
});

/** Panorama modes the imagery filter understands. */
export const PANO_MODES = Object.freeze(['all', 'pano', 'flat']);

/** Longest "captured since" window the filter accepts, in days (~100 years). */
export const MAX_SINCE_DAYS = 36_500;

/** Filter every provider starts with: all imagery, any date. */
export const FILTER_DEFAULT = Object.freeze({ pano: 'all', sinceDays: 0 });

/** Nearest-image search radius in metres. */
export const NEAREST_RADIUS_M = 50;

/** The Google 3D map stack: Street View may be shown only on it. */
export const GOOGLE_3D_MAP_STACK_ID = 'photoreal';

/** Above this, a ground click is a misclick, not a street. */
export const GROUND_CLICK_MAX_HEIGHT_M = 3_000;

/** English data: the Street Level panel translates it (translateKnown). */
export const AIM_AT_GROUND_MESSAGE = msg(
  'Aim the middle of the view at a street to look for imagery there',
);

/** The key gate's label for the pill and the layer list, or null when the key is fine. */
export function keyStatusLabel({ keyRequired, keyRejected }) {
  if (keyRejected) return msg('KEY REJECTED');
  return keyRequired ? msg('KEY REQUIRED') : null;
}
