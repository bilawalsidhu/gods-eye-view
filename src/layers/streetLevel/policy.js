/** Identity and shared tuning for the Street Level layer. */
export const STREET_LEVEL_LAYER_ID = 'street-level';

/** Pick id of the viewer position marker. */
export const POSITION_PICK_ID = 'sl:pos';

/** The selection highlight and the position marker. */
export const COLORS = Object.freeze({
  selected: '#00d4ff',
  position: '#ffb300',
});

/** Panorama modes the imagery filter understands. */
export const PANO_MODES = Object.freeze(['all', 'pano', 'flat']);

/** Longest "captured since" window the filter accepts, in days (~100 years). */
export const MAX_SINCE_DAYS = 36_500;

/** Filter the layer starts with: all imagery, any date. */
export const FILTER_DEFAULT = Object.freeze({ pano: 'all', sinceDays: 0 });

/** The key gate's label for the pill and the layer list, or null when the key is fine. */
export function keyStatusLabel({ keyRequired, keyRejected }) {
  if (keyRejected) return 'KEY REJECTED';
  return keyRequired ? 'KEY REQUIRED' : null;
}
