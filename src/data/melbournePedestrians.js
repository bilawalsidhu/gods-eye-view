import { createApplicationPedestrians } from '../app/layers/melbournePedestrians.js';
import { createSourceSlot } from '../sources/sourceSlot.js';
import { createMelbournePedestrianSource } from '../layers/pedestrians/index.js';
export * from '../layers/pedestrians/index.js';
const slot = createSourceSlot(
  createMelbournePedestrianSource(),
  ['getSnapshot'],
  'Pedestrian source',
);
export const configurePedestrianSource = slot.configure;
export default createApplicationPedestrians({ source: slot.source });
