import { createSourceSlot } from '../app/sourceSlot.js';
import { createApplicationRequestServices } from './requests.js';

// Compatibility owners are page-scoped, like the viewer and its layer registry.
const defaults = createApplicationRequestServices();
const slots = Object.fromEntries(
  Object.entries({
    boundaries: ['query'],
    terrain: ['getHeights'],
    regional: ['getBrief'],
    weather: ['getConditions'],
    summary: ['summarize'],
  }).map(([name, methods]) => [
    name,
    createSourceSlot(defaults[name], methods, `${name} service`),
  ]),
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
