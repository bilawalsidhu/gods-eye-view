/** Identity and shared tuning for the provider-neutral Street Level layer. */
export const STREET_LEVEL_LAYER_ID = 'street-level';

/** Pick id of the viewer position marker; the core owns it, not a provider. */
export const POSITION_PICK_ID = 'sl:pos';

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

/** Nearest-image search when the user asks to look at a place. */
export const NEAREST_RADIUS_M = 50;

/**
 * Map stack the globe camera may follow the street-level view on. Only Google
 * Photorealistic 3D has buildings to stand among; on flat imagery or terrain
 * a camera at eye height looks at a smeared texture.
 */
export const FOLLOW_MAP_STACK_ID = 'photoreal';

/** Eye height above the sampled ground when the globe camera follows the viewer. */
export const FOLLOW_EYE_HEIGHT_M = 2.4;
