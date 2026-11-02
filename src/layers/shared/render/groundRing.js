// A geographic ring is local, including across 180°. Put the click and ring in
// the same longitude interval before casting the ray.
export function containsGroundPoint(ring, lon, lat) {
  const origin = ring[0][0];
  const local = (x) => x - origin - 360 * Math.round((x - origin) / 360);
  const x = local(lon);
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j],
      [bx, by] = ring[i];
    if (ay > lat === by > lat) continue;
    const a = local(ax),
      b = local(bx);
    if (x < a + ((b - a) * (lat - ay)) / (by - ay)) inside = !inside;
  }
  return inside;
}
