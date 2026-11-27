import { toLonLatH } from '../geo/ellipsoid.js';
import { canvasOf, findQuery } from './rendererOf.js';

/**
 * The ground under the middle of `host`'s canvas, where its query port's pick
 * meets the ellipsoid: degrees and the ECEF `position`; null without a sized
 * canvas or a query port, or over sky.
 * @param {object} host
 * @returns {{ lon: number, lat: number, position: object } | null}
 */
export function groundAtViewCentre(host) {
  const canvas = canvasOf(host);
  const width = canvas?.clientWidth || canvas?.width;
  const height = canvas?.clientHeight || canvas?.height;
  if (!(width > 0) || !(height > 0)) return null;
  const query = findQuery(host);
  if (typeof query?.pickEllipsoid !== 'function') return null;
  const position = query.pickEllipsoid(width / 2, height / 2);
  const ground = position ? toLonLatH(position) : null;
  return ground ? { lon: ground.lon, lat: ground.lat, position } : null;
}
