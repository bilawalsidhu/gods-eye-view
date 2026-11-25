import { formatCockpitCoordinate } from './cockpitPresentation.js';

export function coordinateText(lat, lon) {
  return `${formatCockpitCoordinate(lat, 'N', 'S')}  ${formatCockpitCoordinate(lon, 'E', 'W')}`;
}
