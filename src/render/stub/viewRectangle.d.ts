/** The view rectangle of a pose, as the reference camera measures it. */
import type { CameraPose, Ecef, GeoRect } from '../contract/index';

export function computeViewRectangle(
  pose: CameraPose,
  viewport: { width: number; height: number },
  pickEllipsoid: (x: number, y: number) => Ecef | null,
): GeoRect | null;
