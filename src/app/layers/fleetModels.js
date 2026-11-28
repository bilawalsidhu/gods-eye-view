import { FLEET_MODEL_POLICY } from '../../layers/flights/policy.js';

/**
 * The fleet-model service the Vessels, Transit and Rail layers draw their 3D
 * models with: the Flights layer's DISPLAY-rail 3D preference
 * (`{ models3d, models3dMode }`), the aircraft layers' icon-to-model rules,
 * the resolver the fleet set's files are fetched through, and the moving sea
 * surface vessel models float on, if any (`seaSurface` in
 * ../../data/fleetModelInstances.js).
 * @param {{display?: (() => object|null)|null,
 *   resolveAsset?: (url: string) => string,
 *   seaSurface?: (() => Function|null)|null}} [options]
 * @returns {object|null} Null without a display preference (no models).
 */
export function fleetModelServices({
  display = null,
  resolveAsset = (url) =>
    `${import.meta.env?.BASE_URL || '/'}${url.replace(/^\//, '')}`,
  seaSurface = null,
} = {}) {
  if (!display) return null;
  return Object.freeze({
    display,
    policy: FLEET_MODEL_POLICY,
    resolveAsset,
    seaSurface,
  });
}
