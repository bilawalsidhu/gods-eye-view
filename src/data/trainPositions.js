/**
 * Place trains from stop-time predictions.
 *
 * The Dutch train feed publishes TripUpdates and no positions at all, so a
 * train's place has to be inferred: find the two stops it is between right
 * now, and interpolate by time.
 *
 * THE RESULT IS AN ESTIMATE ON A STRAIGHT LINE between stations, not a
 * position on the track. Between Amsterdam and Utrecht that is close; through
 * a river bend it is visibly not the rail. Callers must label it as modelled,
 * the way the launch layer labels its reconstructions.
 *
 * Pure: no network, no Cesium.
 */

/** Great-circle bearing in degrees, 0 = north. */
export function bearingDeg(fromLat, fromLon, toLat, toLon) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLon = toRad(toLon - fromLon);
  const y = Math.sin(dLon) * Math.cos(toRad(toLat));
  const x = Math.cos(toRad(fromLat)) * Math.sin(toRad(toLat))
    - Math.sin(toRad(fromLat)) * Math.cos(toRad(toLat)) * Math.cos(dLon);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/**
 * The leg a trip is on at `now`.
 *
 * Returns `dwelling` when the clock sits between an arrival and its own
 * departure — a train standing at a platform is not 100% of the way along the
 * previous leg, and drawing it as such puts it a carriage short of the station
 * for as long as it waits.
 * @param {Array<{stopId:string, arrival:?number, departure:?number}>} stops
 * @param {number} now - Unix seconds.
 * @returns {?{fromIndex:number, toIndex:number, fraction:number, dwelling:boolean}}
 */
export function legAt(stops, now) {
  if (!Array.isArray(stops) || stops.length < 2 || !Number.isFinite(now)) return null;
  const timeOut = (s) => (Number.isFinite(s.departure) ? s.departure : s.arrival);
  const timeIn = (s) => (Number.isFinite(s.arrival) ? s.arrival : s.departure);

  const first = timeOut(stops[0]);
  const last = timeIn(stops[stops.length - 1]);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  // Not yet departed, or already terminated: not a train in motion.
  if (now < first || now > last) return null;

  for (let i = 0; i < stops.length - 1; i += 1) {
    const out = timeOut(stops[i]);
    const nextIn = timeIn(stops[i + 1]);
    if (!Number.isFinite(out) || !Number.isFinite(nextIn)) continue;

    const arrivedHere = timeIn(stops[i]);
    if (Number.isFinite(arrivedHere) && now >= arrivedHere && now < out) {
      return { fromIndex: i, toIndex: Math.min(i + 1, stops.length - 1), fraction: 0, dwelling: true };
    }
    if (now >= out && now <= nextIn) {
      const span = nextIn - out;
      // A zero or negative span means the prediction has the train arriving
      // before it left; pinning the fraction is better than dividing by zero.
      const fraction = span > 0 ? Math.min(1, Math.max(0, (now - out) / span)) : 0;
      return { fromIndex: i, toIndex: i + 1, fraction, dwelling: false };
    }
  }
  return null;
}

/**
 * Positions for every trip that is underway.
 *
 * @param {Array<object>} trips - From decodeTripUpdates.
 * @param {Map<string,{lat:number, lon:number, name:string}>} stops - Stop table.
 * @param {number} now - Unix seconds.
 * @returns {Array<{tripId:string, routeId:string, lat:number, lon:number,
 *   bearing:number, fraction:number, dwelling:boolean, fromName:string,
 *   toName:string, delaySec:?number, estimated:true}>}
 */
export function placeTrains(trips, stops, now) {
  const out = [];
  for (const trip of trips || []) {
    // Only stops we can actually place may take part: a missing coordinate in
    // the middle of a run would otherwise stretch a leg across the gap.
    const placed = (trip.stops || []).filter((s) => stops?.has(s.stopId));
    const leg = legAt(placed, now);
    if (!leg) continue;
    const from = stops.get(placed[leg.fromIndex].stopId);
    const to = stops.get(placed[leg.toIndex].stopId);
    if (!from || !to) continue;

    const lat = from.lat + (to.lat - from.lat) * leg.fraction;
    const lon = from.lon + (to.lon - from.lon) * leg.fraction;
    const delaySec = Number.isFinite(placed[leg.fromIndex].delay) ? placed[leg.fromIndex].delay : null;
    out.push({
      tripId: trip.tripId,
      routeId: trip.routeId || '',
      lat,
      lon,
      bearing: bearingDeg(from.lat, from.lon, to.lat, to.lon),
      fraction: leg.fraction,
      dwelling: leg.dwelling,
      fromName: from.name || '',
      toName: to.name || '',
      delaySec,
      estimated: true,
    });
  }
  return out;
}
