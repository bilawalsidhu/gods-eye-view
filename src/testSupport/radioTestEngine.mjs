// The globe engine the radio layer tests draw on: the fake engine with its
// camera 7,000 km from the Earth's centre over 0°, 0°, looking down.

import { createFakeEngine } from '../globe/testing/fakeEngine.js';

export function radioTestEngine() {
  const engine = createFakeEngine();
  engine.fake.setPose({ position: { x: 7_000_000, y: 0, z: 0 } });
  return engine;
}

/** The selected station's marker (its pick id and position), or null. */
export function radioSelectedMarker(engine) {
  const set = engine.fake.moverSet('radio-selected');
  if (!set?.store.count) return null;
  const { pickIds, positions } = set.store;
  return {
    id: pickIds[0],
    position: { x: positions[0], y: positions[1], z: positions[2] },
  };
}
