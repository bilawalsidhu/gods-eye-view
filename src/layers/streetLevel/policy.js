/** Identity and shared tuning for the provider-neutral Street Level layer. */
export const STREET_LEVEL_LAYER_ID = 'street-level';

/** Pick id of the viewer position marker; the core owns it, not a provider. */
export const POSITION_PICK_ID = 'sl:pos';

/** One colour per imagery source: chip, coverage lines, points, cones and legend. */
export const PROVIDER_COLORS = Object.freeze({
  mapillary: '#05cb63',
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

/** Nearest-image search radius in metres (Mapillary's graph API caps it at 50 m). */
export const NEAREST_RADIUS_M = 50;
