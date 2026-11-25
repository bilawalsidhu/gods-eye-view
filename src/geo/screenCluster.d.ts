/** Screen-space clustering of drawn points (`screenCluster.js`). */
import type { Ecef, ScreenXY } from '../render/contract/index';

export interface ScreenClusterPoint {
  id: string;
  position: Ecef;
  screen: ScreenXY;
  /** Its drawn size, CSS pixels. */
  pixelSize: number;
}

/** What a pass leaves for the next. */
export interface ScreenClusterState {
  clusters: Array<{
    position: Ecef;
    width: number;
    height: number;
    minimumWidth: number;
    minimumHeight: number;
  }>;
  /** The eye's height above the ground at that pass. */
  height: number;
}

export function clusterScreenPoints(options: {
  points: ScreenClusterPoint[];
  pixelRange: number;
  minimumClusterSize: number;
  /** The view's height, CSS pixels. */
  viewHeight: number;
  /** The eye's height above the ground, m. */
  eyeHeight: number;
  previous?: ScreenClusterState | null;
  project: (position: Ecef) => ScreenXY | null;
  isOccluded: (position: Ecef) => boolean;
}): {
  clusters: Array<{ position: Ecef; ids: string[] }>;
  single: string[];
  state: ScreenClusterState;
};
