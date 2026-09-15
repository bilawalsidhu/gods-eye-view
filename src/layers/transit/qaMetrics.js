/** Acceptance reducers. Missing, non-finite or unexercised evidence never passes. */
export function percentile(values, fraction = 0.95) {
  if (!values.length || values.some((v) => !Number.isFinite(v)))
    return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function reduceMotion(rows, tolerance = 0.02) {
  let tested = 0,
    moving = 0,
    worstRelativeError = 0,
    distance = 0,
    worstFrame = null;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1],
      b = rows[i];
    if (
      !(a.expectedMps > 0) ||
      a.segment !== b.segment ||
      a.toSeq !== b.toSeq ||
      (a.phase && a.phase !== 'playing') ||
      (b.phase && b.phase !== 'playing')
    )
      continue;
    const seconds =
      (Number.isFinite(a.monoMs) && Number.isFinite(b.monoMs)
        ? b.monoMs - a.monoMs
        : b.displayT - a.displayT) / 1000;
    if (!(seconds > 0)) {
      tested++;
      worstRelativeError = Infinity;
      continue;
    }
    const metres = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const error = Math.abs(metres / seconds / a.expectedMps - 1);
    tested++;
    if (error > worstRelativeError || !Number.isFinite(error))
      worstFrame = {
        key: b.key,
        fromIndex: i - 1,
        toIndex: i,
        from: a,
        to: b,
        seconds,
        metres,
        error,
      };
    if (metres > 0.00001) moving++;
    distance += metres;
    worstRelativeError = Math.max(
      worstRelativeError,
      Number.isFinite(error) ? error : Infinity,
    );
  }
  return {
    pass:
      tested > 30 &&
      moving === tested &&
      distance > 1 &&
      worstRelativeError <= tolerance,
    tested,
    moving,
    distance,
    worstRelativeError,
    worstFrame,
    tolerance,
  };
}

export function reduceAnchor(rows) {
  const hiddenFrames = rows.filter((r) => r.markerVisible === false).length;
  const invalidWorld = rows.filter((r) => r.worldFinite === false);
  rows = rows.filter((r) => r.markerVisible !== false);
  // The host acquires its first card asynchronously. Only its leading acquisition
  // frames are outside the anchor test; any later missing anchor is a failure.
  const acquired = rows.findIndex((r) =>
    [r.mx, r.my, r.ax, r.ay].every(Number.isFinite),
  );
  const acquisitionFrames = acquired < 0 ? rows.length : acquired;
  rows = rows.slice(acquisitionFrames);
  let samples = 0,
    moving = 0,
    maxErrorPx = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (![r.mx, r.my, r.ax, r.ay].every(Number.isFinite)) continue;
    samples++;
    maxErrorPx = Math.max(maxErrorPx, Math.hypot(r.mx - r.ax, r.my - r.ay));
    const a = rows[i - 1];
    if (a && Math.hypot(r.mx - a.mx, r.my - a.my) > 0.0001) moving++;
  }
  const polls = new Set(rows.map((r) => r.poll).filter(Number.isFinite)).size;
  const conditions = {
    enoughSamples: samples > 30,
    allFinite: samples === rows.length && invalidWorld.length === 0,
    moving: moving > 30,
    withinOnePixel: maxErrorPx <= 1,
    pollTransition: polls >= 2,
  };
  return {
    pass: Object.values(conditions).every(Boolean),
    conditions,
    hiddenFrames,
    invalidSamples: rows
      .filter((r) => ![r.mx, r.my, r.ax, r.ay].every(Number.isFinite))
      .slice(0, 8),
    invalidWorld: invalidWorld.slice(0, 8),
    acquisitionFrames,
    inputFrames: rows.length + acquisitionFrames + hiddenFrames,
    polls,
    samples,
    moving,
    maxErrorPx,
  };
}

export function reduceFleet(
  rows,
  count,
  allocationBytesPerFrame,
  retainedBytes,
  fixBytes,
) {
  const street = count === 800;
  const limits = {
    cpuMs: street ? 1 : 4,
    intervalMs: street ? 20 : 25,
    uploadBytes: street ? 262144 : 1048576,
    allocationBytes: 8192,
    retainedBytes: (street ? 24 : 48) * 1048576,
    fixBytes: count * 128 * 48,
  };
  const metrics = {
    frames: rows.length,
    cpuP95: percentile(rows.map((r) => r.cpuMs)),
    intervalP95: percentile(rows.map((r) => r.intervalMs)),
    uploadMax: rows.length
      ? Math.max(...rows.map((r) => r.uploadBytes))
      : Infinity,
    movingMin: rows.length ? Math.min(...rows.map((r) => r.moving)) : 0,
    allocationBytesPerFrame,
    retainedBytes,
    fixBytes,
  };
  const motion = reduceMotion(rows);
  return {
    pass:
      rows.length >= 300 &&
      motion.pass &&
      metrics.movingMin === count &&
      metrics.cpuP95 <= limits.cpuMs &&
      metrics.intervalP95 <= limits.intervalMs &&
      metrics.uploadMax > 0 &&
      metrics.uploadMax <= limits.uploadBytes &&
      Number.isFinite(allocationBytesPerFrame) &&
      allocationBytesPerFrame <= limits.allocationBytes &&
      Number.isFinite(retainedBytes) &&
      retainedBytes > 0 &&
      retainedBytes <= limits.retainedBytes &&
      fixBytes > 0 &&
      fixBytes <= limits.fixBytes,
    limits,
    metrics,
    motion,
  };
}

export function reduceScenario(trace, key) {
  const keys = key.startsWith('mbta:') ? key : `mbta:sim-${key}`;
  const rows = trace.out[keys] || [];
  let moved = 0;
  let total = 0;
  let worstJump = 0;
  let speedWorst = 0;
  let wallFaster = 0;
  let lagMax = 0;
  let lagMin = Infinity;
  const initialResets = (rows.find((r) => r[5] === 1) || rows[0])?.[4] || 0;
  let resets = 0;
  let backwards = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const a = rows[i - 1];
    const b = rows[i];
    const d = Math.hypot(
      (b[1] - a[1]) * 111320,
      (b[2] - a[2]) * 111320 * Math.cos((a[1] * Math.PI) / 180),
    );
    // Position and playback time were sampled in preRender; GPU completion
    // jitter in column zero must not masquerade as acceleration or catch-up.
    const dWall =
      (Number.isFinite(a[16]) && Number.isFinite(b[16])
        ? b[16] - a[16]
        : b[0] - a[0]) / 1000;
    const dPlay = (b[3] - a[3]) / 1000;
    total += d;
    if (d > 0.05) moved += 1;
    worstJump = Math.max(worstJump, d / Math.max(dWall, 1 / 120));
    if (dPlay > dWall * 1.02 + 0.002) wallFaster += 1;
    if (dPlay > 0 && d > 0.001) speedWorst = Math.max(speedWorst, d / dPlay);
    if (b[1] < a[1] - 0.5 / 111320) backwards += 1;
    resets = Math.max(resets, b[4] - initialResets);
    const lag = (b[7] - b[3]) / 1000;
    lagMax = Math.max(lagMax, lag);
    lagMin = Math.min(lagMin, lag);
  }
  return {
    keys,
    lagValid:
      rows.length > 1 && Number.isFinite(lagMin) && Number.isFinite(lagMax),
    rows: rows.length,
    moved,
    total,
    worstJump,
    speedWorst,
    wallFaster,
    lagMax,
    lagMin,
    resets,
    initialResets,
    backwards,
    last: rows.at(-1),
    first: rows[0],
  };
}

/** Choose actual sampled backgrounds, never infer brightness from a place name. */
export function reduceBackground(name, pixels) {
  const values = pixels.map((p) => p.background);
  const luma = values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : NaN;
  const threshold = name === 'bright' ? 0.55 : 0.35;
  return {
    pass:
      values.length >= 4 &&
      values.every(Number.isFinite) &&
      (name === 'bright' ? luma >= threshold : luma <= threshold),
    luma,
    samples: values.length,
    threshold,
    comparison: name === 'bright' ? '>=' : '<=',
  };
}

/** Convert captured tuples without confusing paint completion with the playback clock. */
export function reduceScriptedMotion(key, rows) {
  return reduceMotion(
    rows.map((r) => ({
      key,
      monoMs: r[16],
      x: r[11],
      y: r[12],
      z: r[13],
      displayT: r[3],
      expectedMps: r[9],
      segment: r[10],
      toSeq: r[14],
      phase: r[15],
    })),
  );
}

/**
 * In-scene sensor signatures retain the active shader. Surveillance peak white
 * is P43 phosphor (0.16, 1, 0.22): Rec.601 luma 0.65992. D1 requires 90% of
 * that peak and a ring <= 0.25. Local background delta is diagnostic.
 * White-hot, Ironbow and noir require 0.85; black-hot keeps the inverse.
 * Six verified, unobscured sprites are required; absence is UNEXERCISED.
 */
export function reduceSensorContrast(pixels, polarity = 'white', preset = '') {
  const limits =
    polarity === 'black'
      ? { centreMax: 0.15, ringMin: 0.75 }
      : {
          centreMin:
            preset === 'surveillance'
              ? 0.9 * (0.299 * 0.16 + 0.587 + 0.114 * 0.22)
              : 0.85,
          ringMax: 0.25,
          backgroundDeltaMin: null,
        };
  const judged = pixels
    .filter((p) => p.verified === true)
    .map((p) => ({
      key: p.key,
      centre: p.centre,
      background: p.background,
      backgroundDelta: p.centre - p.background,
      ring: polarity === 'black' ? p.ringMax : p.ringMin,
      pass:
        polarity === 'black'
          ? p.centre <= limits.centreMax && p.ringMax >= limits.ringMin
          : p.centre >= limits.centreMin &&
            p.ringMin <= limits.ringMax &&
            (limits.backgroundDeltaMin === null ||
              p.centre - p.background >= limits.backgroundDeltaMin),
    }));
  return {
    pass: judged.length >= 6 && judged.every((p) => p.pass),
    unexercised: judged.length < 6,
    reason:
      judged.length < 6
        ? `Only ${judged.length} verified unobscured sprites; need 6`
        : null,
    limits,
    judged,
  };
}

/** Selected trail evidence stays inspectable even when the click failed. */
export function reduceTrailHead(anchor, target) {
  const conditions = {
    selected: anchor?.selected === true,
    enoughHeadSamples:
      Number.isFinite(anchor?.headSamples) && anchor.headSamples > 30,
    aligned: Number.isFinite(anchor?.headErrorPx) && anchor.headErrorPx <= 1,
    stableBody: anchor?.bodyMutation === 0,
    stableEntityCount:
      Number.isFinite(anchor?.entityCount) &&
      anchor.entityCount === target?.entityCount,
  };
  return {
    pass: Object.values(conditions).every(Boolean),
    conditions,
    headSamples: anchor?.headSamples ?? null,
    errorPx: anchor?.headErrorPx ?? null,
    bodyMutation: anchor?.bodyMutation ?? null,
    selection: anchor?.selection ?? null,
  };
}
