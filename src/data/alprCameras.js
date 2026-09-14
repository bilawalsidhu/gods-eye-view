import {
  createAlprCamerasLayer,
  createOverpassAlprSource,
} from '../layers/alpr/index.js';
import * as render from '../renderGovernor.js';
import * as context from './contextStore.js';
import * as picking from './pickRegistry.js';
import * as groundFloor from './groundFloor.js';
export * from '../layers/alpr/index.js';
export default createAlprCamerasLayer({
  source: createOverpassAlprSource(),
  services: { render, context, picking, groundFloor },
});
