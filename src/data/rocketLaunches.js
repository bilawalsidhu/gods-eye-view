import { createApplicationLaunches } from '../app/layers/rocketLaunches.js';
import { createSourceSlot } from '../sources/sourceSlot.js';
import { createLaunchSource } from '../layers/launches/index.js';
import * as satellites from './satellites.js';

const sourceSlot = createSourceSlot(
  createLaunchSource(),
  ['getLaunches', 'getActiveTle'],
  'Launch source',
);
export const configureLaunchSource = sourceSlot.configure;
const layer = createApplicationLaunches({
  source: sourceSlot.source,
  satellites,
});
export { createRocketMissionMarkerOverlayEntry } from '../layers/launches/overlays.js';
export {
  ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
  ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID,
  ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
  ROCKET_MISSION_AMBIENT_OVERLAY_COLLISION_CAPACITY,
  ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_OPTIONS,
  LAUNCH_PAD_ZONE_RADIUS_M,
} from '../layers/launches/index.js';
export default layer;
