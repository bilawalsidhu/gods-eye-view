import { createOverpassFeatureSource } from '../sources/overpassFeatures.js';
import { FEATURE_SOURCE_METHODS } from '../sources/featureSource.js';
import { requestWithDeadline } from '../sources/requestDeadline.js';
import { createSourceSlot } from '../sources/sourceSlot.js';
import { createApplicationRequestServices } from './requests.js';

export const LAYER_COUNTS_TIMEOUT_MS = 10_000;

// Compatibility owners are page-scoped, like the viewer and its layer registry.
const defaults = createApplicationRequestServices();
const slots = Object.fromEntries(
  Object.entries({
    boundaries: ['query'],
    terrain: ['getHeights'],
    regional: ['getBrief'],
    weather: ['getConditions'],
    summary: ['summarize'],
    layerCounts: ['getCounts'],
  }).map(([name, methods]) => [
    name,
    createSourceSlot(defaults[name], methods, `${name} service`),
  ]),
);
slots.features = createSourceSlot(
  createOverpassFeatureSource({ boundarySource: slots.boundaries.source }),
  FEATURE_SOURCE_METHODS,
  'features service',
);
export const applicationServices = Object.freeze(
  Object.fromEntries(
    Object.entries(slots).map(([name, slot]) => [name, slot.source]),
  ),
);

/** Supply selected services before constructing the application; release after its consumers. */
export function configureApplicationServices(services) {
  const releases = [];
  try {
    for (const [name, service] of Object.entries(services)) {
      if (!slots[name])
        throw new TypeError(`Unknown application service: ${name}`);
      releases.push(slots[name].configure(service));
    }
  } catch (error) {
    for (const release of releases.reverse()) release();
    throw error;
  }
  return () => {
    for (const release of releases.reverse()) release();
  };
}

/** Bound the configured source even when its adapter ignores abort. */
export function getConfiguredLayerCounts({ signal } = {}) {
  return requestWithDeadline(
    (boundedSignal) =>
      applicationServices.layerCounts.getCounts({ signal: boundedSignal }),
    { signal, timeoutMs: LAYER_COUNTS_TIMEOUT_MS },
  );
}
