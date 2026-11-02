import { INCIDENT_OVERVIEW_HOLD_SEC } from '../../data/bhoteKoshiIncidentPlaces.js';

/** Existing Nepal presentation rules; authored assets and saved shots stay untouched. */
export const nepalScenePresentation = {
  minimumHoldSec(states) {
    const overview = states['bhote-koshi-locator'];
    return overview?.enabled &&
      overview.params?.presentation === 'bhote-koshi-incident-places'
      ? INCIDENT_OVERVIEW_HOLD_SEC
      : 0;
  },
  resolveVisual(shot, visual, isMapStackAvailable) {
    const isNepalShot =
      shot?.layers?.['bhote-koshi-2026']?.enabled ||
      shot?.layers?.['bhote-koshi-locator']?.enabled;
    // A credential is not proof of a loaded tileset. Resolve actual capability at playback time.
    return isNepalShot &&
      visual.mapStack === 'photoreal' &&
      !isMapStackAvailable('photoreal')
      ? { ...visual, mapStack: 'esri-imagery' }
      : visual;
  },
  cancelMotion(getLayerModule) {
    getLayerModule('bhote-koshi-locator')?.cancelSceneMotion?.();
  },
};
