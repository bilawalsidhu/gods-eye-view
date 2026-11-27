import { msg } from '../i18n/index.js';

/**
 * How a camera's calibration reads in its tools and scene summary: the CAL
 * badge ('raw-prior', 'curated', 'calibrated') or unsaved edits ('edited'),
 * as a sentence.
 */
export const CAL_STATUS_WORDS = Object.freeze({
  calibrated: msg('Saved calibration'),
  curated: msg('Hand-checked calibration'),
  'raw-prior': msg("Using the camera's default calibration"),
  edited: msg('Edited, not saved'),
});
