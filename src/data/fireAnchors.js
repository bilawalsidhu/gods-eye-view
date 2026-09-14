import { createFireAnchors } from '../layers/firms/anchors.js';
import * as groundFloor from './groundFloor.js';
export { FIRE_ANCHOR_LIFT_M } from '../layers/firms/anchors.js';
const anchors = createFireAnchors(groundFloor);
export const {
  fireAnchorHeight,
  warmFireAnchorFloors,
  _resetFireAnchorsForTest,
} = anchors;
