import { keySetupRequirement } from '../keySetupCore.mjs';
import { t } from '../i18n/index.js';
/**
 * Why Google 3D is unavailable, phrased so the tooltip and toast recommend the
 * RIGHT fix. With no credentials the fix is a key (or the ion route); with a
 * key or ion token configured, the tileset failed for another reason —
 * restrictions, quota, an EEA-billed key, or the network — and telling the
 * user to add a key they already added is the wrong advice. Translated at call
 * time so a caller composing under the active locale gets the active wording.
 * @param {boolean} hasCredentials
 * @returns {string}
 */
export function photorealUnavailableReason(hasCredentials) {
  if (hasCredentials) return t('mapsource.photoreal.keyed');
  return t('mapsource.photoreal.keyless', {
    requirement: keySetupRequirement('google-maps'),
  });
}
