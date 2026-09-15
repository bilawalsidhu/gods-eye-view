/** Portable retained report-time playback. No scene or scheduling ownership. */
export const FIX_BYTES = 48;
export const FIX_FLAGS = Object.freeze({
  VEHICLE_TIME: 1,
  FEED_TIME: 2,
  RECEIPT_TIME: 4,
  FLOOR: 8,
  BREAK: 16,
  LIVE: 32,
});
const clampDelay = (n) => Math.max(25_000, Math.min(120_000, n));

export function createLagReservoir(capacity = 256) {
  return { values: new Float64Array(capacity), count: 0, cursor: 0 };
}
function addLag(reservoir, value) {
  if (!reservoir || !Number.isFinite(value) || value < 0) return;
  reservoir.values[reservoir.cursor] = value;
  reservoir.cursor = (reservoir.cursor + 1) % reservoir.values.length;
  reservoir.count = Math.min(reservoir.count + 1, reservoir.values.length);
}
function percentile(reservoir, rank) {
  if (!reservoir?.count) return 0;
  const sorted = reservoir.values.slice(0, reservoir.count).sort();
  return sorted[Math.ceil(sorted.length * rank) - 1];
}

/** Optional shared payload budget. Call trimTrack on lower-priority tracks first. */
export function createHistoryBudget(maxBytes = 32 * 1024 * 1024) {
  return { maxBytes, allocatedBytes: 0 };
}
export function createTrack({
  capacity = 128,
  retentionMs = 900_000,
  policy = {},
  budget = null,
} = {}) {
  capacity = Math.max(2, Math.min(128, Math.floor(capacity)));
  return {
    capacity,
    retentionMs,
    policy,
    budget,
    metricsScratchA: {},
    metricsScratchB: {},
    storage: new DataView(new ArrayBuffer(0)),
    slots: 0,
    head: 0,
    count: 0,
    baseSeq: 0,
    revision: 0,
    truncated: false,
    epochs: new Map(),
    lag: createLagReservoir(32),
    targetDelayMs: 25_000,
    displayT: NaN,
    wallAnchor: NaN,
    monoAnchor: NaN,
    lastMono: NaN,
    offset: 0,
    rate: 1,
    phase: 'buffering',
    resets: 0,
    resetReason: null,
    acceptedAt: NaN,
    acceptedMono: NaN,
    resumePending: false,
    bracket: 0,
    metricsRevision: -1,
    metricsIndex: -1,
    from: {},
    to: {},
    metrics: {},
    latest: {},
    pending: null,
    pendingCount: 0,
  };
}
function address(track, index) {
  return ((track.head + index) % track.slots) * FIX_BYTES;
}
export function readFix(track, index, out = {}) {
  if (index < 0 || index >= track.count) return null;
  const v = track.storage,
    o = address(track, index);
  out.t = v.getFloat64(o);
  out.lat = v.getFloat64(o + 8);
  out.lon = v.getFloat64(o + 16);
  out.heightM = v.getFloat32(o + 24);
  out.h = out.heightM;
  out.receivedAt = v.getFloat64(o + 28);
  out.bearingDeg = v.getFloat32(o + 36);
  out.flags = v.getUint32(o + 40);
  out.epoch = v.getUint32(o + 44);
  out.seq = track.baseSeq + index;
  return out;
}
function writeFix(track, index, fix) {
  const v = track.storage,
    o = address(track, index);
  v.setFloat64(o, fix.t);
  v.setFloat64(o + 8, fix.lat);
  v.setFloat64(o + 16, fix.lon);
  v.setFloat32(o + 24, fix.heightM ?? fix.h ?? NaN);
  v.setFloat64(o + 28, fix.receivedAt ?? NaN);
  v.setFloat32(o + 36, fix.bearingDeg ?? NaN);
  v.setUint32(o + 40, fix.flags || 0);
  v.setUint32(o + 44, fix.epoch || 0);
}
function resize(track, slots) {
  const bytes = slots * FIX_BYTES,
    delta = bytes - track.storage.byteLength;
  if (
    delta > 0 &&
    track.budget &&
    track.budget.allocatedBytes + delta > track.budget.maxBytes
  )
    return false;
  const old = track.storage,
    head = track.head,
    oldSlots = track.slots;
  const next = new Uint8Array(bytes),
    previous = new Uint8Array(old.buffer);
  for (let i = 0; i < track.count; i++) {
    const o = ((head + i) % oldSlots) * FIX_BYTES;
    next.set(previous.subarray(o, o + FIX_BYTES), i * FIX_BYTES);
  }
  track.storage = new DataView(next.buffer);
  track.slots = slots;
  track.head = 0;
  if (track.budget) track.budget.allocatedBytes += delta;
  return true;
}
export function destroyTrack(track) {
  if (track.budget) track.budget.allocatedBytes -= track.storage.byteLength;
  track.storage = new DataView(new ArrayBuffer(0));
  track.count = 0;
  track.slots = 0;
  track.epochs.clear();
}
function timeAt(track, i) {
  return track.storage.getFloat64(address(track, i));
}
function dropOldest(track) {
  track.head = (track.head + 1) % track.slots;
  track.count--;
  track.baseSeq++;
  track.revision++;
  track.truncated = true;
}
/** Retention never evicts the bracket currently on screen. */
export function trimTrack(track, nowMs, keep = track.capacity) {
  while (
    track.count > 2 &&
    (track.count > keep || timeAt(track, 1) < nowMs - track.retentionMs)
  ) {
    if (Number.isFinite(track.displayT) && timeAt(track, 1) > track.displayT)
      break;
    dropOldest(track);
  }
  if (keep < track.slots && track.count <= keep)
    resize(track, Math.max(2, track.count));
  const used = new Set();
  for (let i = 0; i < track.count; i++)
    used.add(track.storage.getUint32(address(track, i) + 44));
  for (const id of track.epochs.keys())
    if (!used.has(id)) track.epochs.delete(id);
}
export function validFix(fix) {
  return (
    Number.isFinite(fix?.t) &&
    fix.t >= 0 &&
    Number.isFinite(fix.lat) &&
    Math.abs(fix.lat) <= 90 &&
    Number.isFinite(fix.lon) &&
    Math.abs(fix.lon) <= 180
  );
}
function distance(a, b) {
  const lon = ((b.lon - a.lon + 540) % 360) - 180;
  return Math.hypot(
    (b.lat - a.lat) * 111320,
    lon * 111320 * Math.cos((a.lat * Math.PI) / 180),
  );
}
function append(track, fix) {
  if (track.count === track.slots && track.slots < track.capacity)
    resize(track, Math.min(track.capacity, Math.max(8, track.slots * 2)));
  if (track.count === track.slots) {
    if (track.count < 2) return false;
    if (Number.isFinite(track.displayT) && timeAt(track, 1) > track.displayT) {
      // Pin both active ends; drop the next future observation and mark the gap.
      if (track.count < 4) return false;
      const scratch = {};
      for (let i = 2; i < track.count - 1; i++) {
        readFix(track, i + 1, scratch);
        if (i === 2) scratch.flags |= FIX_FLAGS.BREAK;
        writeFix(track, i, scratch);
      }
      track.count--;
      track.truncated = true;
    } else dropOldest(track);
  }
  writeFix(track, track.count++, fix);
  track.revision++;
  return true;
}

export function insertFix(track, fix, observation = {}) {
  if (
    !validFix(fix) ||
    (Number.isFinite(observation.wallNowMs) &&
      fix.t > observation.wallNowMs + 10_000)
  )
    return { accepted: false, reason: 'malformed' };
  const last = readFix(track, track.count - 1, track.latest);
  if (last && fix.t === last.t)
    return {
      accepted: false,
      reason:
        fix.lat === last.lat && fix.lon === last.lon ? 'repeat' : 'conflict',
    };
  let reason = last ? 'moved' : 'first';
  if (
    last &&
    (fix.t < last.t || (track.policy.accept && !track.policy.accept(last, fix)))
  ) {
    reason = fix.t < last.t ? 'out-of-order' : 'implausible';
    const prior = track.pending;
    if (
      !prior ||
      prior.reason !== reason ||
      fix.t <= prior.t ||
      (track.policy.accept && !track.policy.accept(prior, fix))
    ) {
      if (!prior || fix.t !== prior.t) {
        track.pending = { ...fix, reason };
        track.pendingCount = 1;
      }
      return { accepted: false, reason };
    }
    track.pendingCount++;
    const required = reason === 'out-of-order' ? 3 : 2;
    if (track.pendingCount < required) {
      track.pending = { ...fix, reason };
      return { accepted: false, reason };
    }
    // Clock correction starts a new time domain. A spatial replacement retains a visible gap.
    if (reason === 'out-of-order') {
      track.count = 0;
      track.head = 0;
      track.baseSeq += 128;
    }
    const epoch = (last.epoch + 1) >>> 0;
    append(track, {
      ...prior,
      epoch,
      flags: (prior.flags || 0) | FIX_FLAGS.BREAK,
    });
    fix = { ...fix, epoch };
    if (reason === 'out-of-order') track.displayT = NaN;
    track.resetReason = reason;
    track.resets++;
  }
  const receivedAt =
    observation.receivedAt ?? fix.receivedAt ?? observation.wallNowMs ?? fix.t;
  trimTrack(track, receivedAt);
  const accepted = append(track, {
    ...fix,
    receivedAt,
    flags: (fix.flags || 0) | FIX_FLAGS.LIVE,
  });
  if (accepted) {
    if (!observation.replayed) {
      if (last && fix.t > last.t && reason === 'moved') {
        addLag(track.lag, receivedAt - last.t);
        addLag(track.policy.feedLag, receivedAt - last.t);
        track.targetDelayMs = clampDelay(
          Math.max(
            percentile(track.lag, 0.95),
            percentile(track.policy.feedLag, 0.9),
          ) + 5000,
        );
      } else if (!last)
        track.targetDelayMs = clampDelay(
          Math.max(0, receivedAt - fix.t) + 20_000,
        );
    }
    track.acceptedAt = receivedAt;
    track.acceptedMono = observation.monoNowMs ?? NaN;
    track.resumePending = true;
    track.pending = null;
    track.pendingCount = 0;
  }
  return { accepted, reason: accepted ? reason : 'capacity' };
}

/** Bounded backfill; live positions win conflicts and the clock/health are untouched. */
export function mergeHistory(track, fixes) {
  const merged = new Map();
  for (const fix of fixes.slice(-128))
    if (
      validFix(fix) &&
      (!Number.isFinite(track.acceptedAt) ||
        fix.t >= track.acceptedAt - track.retentionMs)
    )
      merged.set(fix.t, { ...fix, flags: (fix.flags || 0) & ~FIX_FLAGS.LIVE });
  for (let i = 0; i < track.count; i++) {
    const fix = readFix(track, i);
    merged.set(fix.t, fix);
  }
  const ordered = [...merged.values()].sort((a, b) => a.t - b.t);
  const active = Number.isFinite(track.displayT)
    ? ordered.findLastIndex((f) => f.t <= track.displayT)
    : -1;
  const pinnedFrom = ordered[active],
    pinnedTo = ordered[active + 1];
  while (ordered.length > track.capacity) {
    const i = ordered.findIndex((f) => f !== pinnedFrom && f !== pinnedTo);
    if (i > 0 && i + 1 < ordered.length)
      ordered[i + 1].flags |= FIX_FLAGS.BREAK;
    ordered.splice(Math.max(0, i), 1);
    track.truncated = true;
  }
  for (let i = 1; i < ordered.length; i++) {
    if (track.policy.accept && !track.policy.accept(ordered[i - 1], ordered[i]))
      ordered[i].flags |= FIX_FLAGS.BREAK;
  }
  track.count = 0;
  track.head = 0;
  track.baseSeq += 128;
  for (const fix of ordered) append(track, fix);
  track.revision++;
  track.bracket = 0;
}
export function correctHeight(track, seq, heightM) {
  const i = seq - track.baseSeq;
  if (i < 0 || i >= track.count || !Number.isFinite(heightM)) return false;
  const o = address(track, i),
    value = Math.fround(heightM);
  if (track.storage.getFloat32(o + 24) === value) return false;
  track.storage.setFloat32(o + 24, value);
  track.storage.setUint32(
    o + 40,
    track.storage.getUint32(o + 40) | FIX_FLAGS.FLOOR,
  );
  track.revision++;
  return true;
}
function anchoredWall(track, clocks) {
  if (!Number.isFinite(track.wallAnchor)) {
    track.wallAnchor = clocks.wallNowMs;
    track.monoAnchor = clocks.monoNowMs;
  }
  return track.wallAnchor + Math.max(0, clocks.monoNowMs - track.monoAnchor);
}
/** Stable numeric fields avoid dictionary properties and boxed doubles in hot samples. */
export function createSample() {
  return {
    displayT: NaN,
    revision: 0,
    nextWakeMonoMs: Infinity,
    phase: 'buffering',
    motion: 'unknown',
    fromSeq: -1,
    toSeq: -1,
    lat: NaN,
    lon: NaN,
    heightM: NaN,
    segmentCourseDeg: NaN,
    segmentSpeedMps: NaN,
    fraction: NaN,
    fromT: NaN,
    toT: NaN,
    nextMotionT: Infinity,
    latestReportAgeMs: NaN,
    actualDelayMs: NaN,
  };
}
/** Sample an explicit report time into caller-owned storage. */
export function sampleAt(track, displayTimeMs, out) {
  out.displayT = displayTimeMs;
  return sampleCurrent(track, out);
}
/** The frame path keeps its changing double in storage across this call. */
function sampleCurrent(track, out) {
  const sampleTime = out.displayT;
  out.revision = track.revision;
  out.nextWakeMonoMs = Infinity;
  out.phase = track.phase;
  out.motion = 'unknown';
  out.fromSeq = -1;
  out.toSeq = -1;
  out.lat = NaN;
  out.lon = NaN;
  out.heightM = NaN;
  out.segmentCourseDeg = NaN;
  out.segmentSpeedMps = 0;
  if (!track.count) return out;
  let i = Math.min(track.bracket, track.count - 1);
  if (timeAt(track, i) > sampleTime) i = 0;
  while (i + 1 < track.count && timeAt(track, i + 1) <= sampleTime) i++;
  track.bracket = i;
  const a = readFix(track, i, track.from);
  const j = sampleTime < a.t ? i : Math.min(i + 1, track.count - 1);
  const b = readFix(track, j, track.to);
  const continuous =
    i !== j && a.epoch === b.epoch && !(b.flags & FIX_FLAGS.BREAK);
  out.fromSeq = a.seq;
  out.toSeq = continuous ? b.seq : a.seq;
  out.fraction = continuous
    ? Math.max(0, Math.min(1, (sampleTime - a.t) / (b.t - a.t)))
    : 1;
  out.fromT = a.t;
  out.toT = continuous ? b.t : a.t;
  if (
    track.metricsRevision !== track.revision ||
    track.metricsIndex !== i ||
    track.metricsTo !== j
  ) {
    const metres = continuous ? distance(a, b) : 0;
    const metrics = track.metrics;
    metrics.speed = continuous ? (metres * 1000) / (b.t - a.t) : 0;
    metrics.course = NaN;
    if (metres >= (track.policy.courseMinTravelM ?? 12)) {
      metrics.course =
        ((Math.atan2(
          (((b.lon - a.lon + 540) % 360) - 180) *
            Math.cos((a.lat * Math.PI) / 180),
          b.lat - a.lat,
        ) *
          180) /
          Math.PI +
          360) %
        360;
    } else {
      // Tiny displacement holds the last reliable course in this epoch.
      // With no reliable displacement yet, use the earliest known bearing.
      const p = track.metricsScratchA,
        q = track.metricsScratchB;
      for (let k = i; k >= 0; k--) {
        readFix(track, k, q);
        if (q.epoch !== a.epoch) break;
        if (Number.isFinite(q.bearingDeg)) metrics.course = q.bearingDeg;
        if (k === 0 || q.flags & FIX_FLAGS.BREAK) continue;
        readFix(track, k - 1, p);
        if (
          p.epoch === q.epoch &&
          distance(p, q) >= (track.policy.courseMinTravelM ?? 12)
        ) {
          metrics.course =
            ((Math.atan2(
              (((q.lon - p.lon + 540) % 360) - 180) *
                Math.cos((p.lat * Math.PI) / 180),
              q.lat - p.lat,
            ) *
              180) /
              Math.PI +
              360) %
            360;
          break;
        }
      }
    }
    metrics.nextMotionT = Infinity;
    const p = track.metricsScratchA,
      q = track.metricsScratchB;
    for (let k = i; k + 1 < track.count; k++) {
      readFix(track, k, p);
      readFix(track, k + 1, q);
      if (
        p.lat !== q.lat ||
        p.lon !== q.lon ||
        p.epoch !== q.epoch ||
        q.flags & FIX_FLAGS.BREAK
      ) {
        metrics.nextMotionT =
          p.epoch !== q.epoch || q.flags & FIX_FLAGS.BREAK ? q.t : p.t;
        break;
      }
    }
    track.metricsRevision = track.revision;
    track.metricsIndex = i;
    track.metricsTo = j;
  }
  const f = out.fraction;
  out.lat = continuous ? a.lat + (b.lat - a.lat) * f : a.lat;
  out.lon = continuous
    ? a.lon + (((b.lon - a.lon + 540) % 360) - 180) * f
    : a.lon;
  if (out.lon > 180) out.lon -= 360;
  if (out.lon < -180) out.lon += 360;
  out.heightM = continuous
    ? a.heightM + (b.heightM - a.heightM) * f
    : a.heightM;
  out.segmentCourseDeg = track.metrics.course;
  out.segmentSpeedMps = track.metrics.speed;
  out.motion = continuous
    ? track.metrics.speed > 0
      ? 'moving'
      : 'stopped'
    : 'unknown';
  out.nextMotionT = track.metrics.nextMotionT;
  out.latestReportAgeMs = Number.isFinite(track.wallAnchor)
    ? track.wallAnchor +
      track.lastMono -
      track.monoAnchor -
      timeAt(track, track.count - 1)
    : NaN;
  out.actualDelayMs = Number.isFinite(track.wallAnchor)
    ? track.wallAnchor + track.lastMono - track.monoAnchor - sampleTime
    : NaN;
  return out;
}
export function advance(track, clocks, out) {
  const wall = anchoredWall(track, clocks),
    previousMono = track.lastMono;
  const dt = Number.isFinite(previousMono)
    ? Math.max(0, clocks.monoNowMs - previousMono)
    : 0;
  track.lastMono = clocks.monoNowMs;
  if (!track.count) return sampleAt(track, NaN, out);
  const newest = timeAt(track, track.count - 1),
    oldest = timeAt(track, 0);
  const ceiling = Math.min(newest, wall - track.targetDelayMs + track.offset);
  const delayBlocked =
    track.offset === 0 &&
    track.phase !== 'playing' &&
    ceiling < track.displayT &&
    track.displayT < newest;
  if (!Number.isFinite(track.displayT))
    track.displayT = Math.min(
      newest,
      wall - track.targetDelayMs + track.offset,
    );
  else if (
    track.offset === 0 &&
    track.rate !== 0 &&
    (ceiling - track.displayT > 90_000 ||
      (track.truncated && track.displayT < oldest))
  ) {
    track.resetReason =
      ceiling - track.displayT > 90_000 ? 'backlog' : 'unavailable-bracket';
    track.displayT = ceiling;
    track.resets++;
  } else if (track.rate !== 0) {
    // While playing, finish the active segment at 1x even if lag grows.
    const activeCeiling =
      track.offset < 0 || track.phase === 'playing' ? newest : ceiling;
    let next = track.displayT + dt * track.rate;
    if (track.phase === 'held' && track.resumePending) {
      const sinceReceipt = Number.isFinite(track.acceptedMono)
        ? Math.max(0, clocks.monoNowMs - track.acceptedMono)
        : 0;
      next = track.displayT + Math.min(dt, sinceReceipt) * track.rate;
    }
    track.displayT = Math.max(track.displayT, Math.min(next, activeCeiling));
  }
  track.phase =
    track.rate === 0
      ? 'paused'
      : track.displayT < oldest || delayBlocked
        ? 'buffering'
        : track.displayT >= newest
          ? 'held'
          : 'playing';
  track.resumePending = false;
  out.displayT = track.displayT;
  sampleCurrent(track, out);
  if (out.motion !== 'moving' || track.phase !== 'playing') {
    const boundary = Math.max(oldest, out.nextMotionT);
    if (
      Number.isFinite(boundary) &&
      boundary > track.displayT &&
      track.rate > 0
    )
      out.nextWakeMonoMs =
        clocks.monoNowMs + (boundary - track.displayT) / track.rate;
  }
  if (delayBlocked && track.rate > 0)
    out.nextWakeMonoMs =
      clocks.monoNowMs + Math.max(1, track.displayT - ceiling);
  if (out.latestReportAgeMs > (track.policy.staleMs ?? 90_000))
    out.motion = 'stale';
  return out;
}
export function seek(track, displayTimeMs, clocks) {
  if (!Number.isFinite(displayTimeMs))
    throw new TypeError('A seek needs a finite time');
  anchoredWall(track, clocks);
  track.displayT = displayTimeMs;
  track.offset = -1;
  track.rate = 0;
  track.phase = 'paused';
  track.lastMono = clocks.monoNowMs;
  track.bracket = 0;
  track.resets++;
  track.resetReason = 'seek';
}
export function setTimeOffsetMs(track, offset, clocks) {
  if (!Number.isFinite(offset) || offset > 0)
    throw new RangeError('Offset must be zero or negative');
  if (Number.isFinite(track.displayT)) {
    track.resets++;
    track.resetReason = 'time-offset';
  }
  track.offset = offset;
  track.rate = 1;
  track.displayT = anchoredWall(track, clocks) - track.targetDelayMs + offset;
  track.lastMono = clocks.monoNowMs;
  track.phase = 'buffering';
  track.bracket = 0;
}
export function setRate(track, rate, clocks) {
  if (!Number.isFinite(rate) || rate < 0 || rate > 16)
    throw new RangeError('Rate must be in [0, 16]');
  if (track.offset === 0 && rate !== 0 && rate !== 1)
    throw new RangeError('Live playback uses 1x or hold');
  track.rate = rate;
  track.lastMono = clocks.monoNowMs;
  track.phase = rate === 0 ? 'paused' : 'buffering';
}
