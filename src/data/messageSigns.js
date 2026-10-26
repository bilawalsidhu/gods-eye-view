import { defaultSurface } from './surfaceServices.js';
import { createApplicationMessageSigns } from '../app/layers/messageSigns.js';
import { createSourceSlot } from '../sources/sourceSlot.js';
import { createMessageSignsSource } from '../layers/messageSigns/index.js';
export * from '../layers/messageSigns/index.js';
const slot = createSourceSlot(
  createMessageSignsSource(),
  ['fetch'],
  'Message sign source',
);
export const configureMessageSignsSource = slot.configure;
export default createApplicationMessageSigns({
  surface: defaultSurface,
  source: slot.source,
});
