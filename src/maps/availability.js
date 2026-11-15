import { keySetupRequirementEnvVars } from '../keySetupCore.mjs';
import { t } from '../i18n/index.js';
/**
 * Why Google 3D is unavailable, phrased so the tooltip and toast recommend the
 * RIGHT fix. With no credentials the fix is a key (or the ion route); with a
 * key or ion token configured, the tileset failed for another reason —
 * restrictions, quota, an EEA-billed key, or the network — and telling the
 * user to add a key they already added is the wrong advice.
 * An ion token with the ion-hosted route switched off (it is opt-in, see
 * GEV_ENABLE_CESIUM_ION_3D) says how to turn it on instead.
 * @param {boolean} hasCredentials
 * @param {{ionPhotorealOff?: boolean}} [options]
 * @returns {string}
 */
export function photorealUnavailableReason(
  hasCredentials,
  { ionPhotorealOff = false } = {},
) {
  if (hasCredentials)
    return t(
      "Google 3D tiles unavailable — check the key's API restrictions, quota, or network",
    );
  const envVars = keySetupRequirementEnvVars('google-maps');
  if (ionPhotorealOff)
    return t(
      'Google 3D through Cesium ion is off by default — set {flag} to use your Cesium ion token, or add {envVars} in Provider Settings',
      { flag: 'GEV_ENABLE_CESIUM_ION_3D=1', envVars },
    );
  return t(
    'Needs {envVars} — add it in Provider Settings — or a Cesium ion token for the ion-hosted route',
    { envVars },
  );
}
