/**
 * The moments of a contact's journey worth a pin on the timeline, from its
 * observed track. Path fixes are `[seconds, lat, lon, altitude m, heading]`.
 *
 * An aircraft's journey is its airframe's day, often several flights, so the
 * pins are where each flight starts and ends: it TOOK OFF where its fixes
 * leave the ground, and LANDED where they reach it. A fix on the ground
 * reports an altitude of 0, or none. A track that starts or ends in the air
 * says FIRST SEEN or LAST SEEN there instead.
 */
const GROUND_M = 30;
const AIRBORNE_M = 150;

const onGround = (fix) => !Number.isFinite(fix[3]) || fix[3] <= GROUND_M;
const airborne = (fix) => Number.isFinite(fix[3]) && fix[3] >= AIRBORNE_M;

/**
 * @param {Array<Array<number|null>>} path
 * @param {{kind?: 'aircraft'|'vessel', nowMs?: number}} [options]
 * @returns {Array<{time: number, label: string, kind: string, lat: number, lon: number}>}
 */
export function journeyMoments(path, { kind = 'aircraft', nowMs = Date.now() } = {}) {
  if (!path?.length) return [];
  const at = (fix, label, type) => ({
    time: fix[0] * 1000,
    label,
    kind: type,
    lat: fix[1],
    lon: fix[2],
  });
  const first = path[0];
  const last = path.at(-1);
  if (kind !== 'aircraft') {
    const moments = [at(first, 'FIRST SEEN', 'seen')];
    if (nowMs - last[0] * 1000 > 30 * 60_000) moments.push(at(last, 'LAST SEEN', 'seen'));
    return moments;
  }
  const moments = [];
  // Where it is, settled: on the ground or in the air, once two fixes agree.
  let state = airborne(first) ? 'air' : onGround(first) ? 'ground' : null;
  if (state === 'air') moments.push(at(first, 'FIRST SEEN', 'seen'));
  for (let index = 1; index < path.length; index += 1) {
    const fix = path[index];
    const next = path[index + 1];
    if (state !== 'ground' && onGround(fix) && (!next || onGround(next))) {
      if (state === 'air') moments.push(at(fix, 'LANDED', 'landed'));
      state = 'ground';
    } else if (state !== 'air' && airborne(fix) && (!next || airborne(next))) {
      // The last fix on the ground before it rose is where it took off.
      const from = state === 'ground' ? path[index - 1] : fix;
      if (state === 'ground') moments.push(at(from, 'TOOK OFF', 'departed'));
      state = 'air';
    }
  }
  if (state === 'air' && nowMs - last[0] * 1000 > 5 * 60_000)
    moments.push(at(last, 'LAST SEEN', 'seen'));
  return moments;
}
