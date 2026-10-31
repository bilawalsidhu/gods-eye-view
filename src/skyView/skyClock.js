/**
 * Sky time. One clock is the only time source for the sky
 * overlay, the satellite worker ticks, the Sun/Moon/planet ephemeris and
 * Cesium's viewer.clock (so the sun lighting and the atmosphere follow it).
 *
 * Built-in provider (createSkyClock), three modes:
 *   'live'   Date.now() on every read (no drift)
 *   'fixed'  a picked UTC instant
 *   'play'   anchor + (wall time since the anchor) x rate; rate is one of
 *            +/-1, 10, 60, 600, 3600 (negative = backwards)
 * createSkyTimeSource() puts the clock behind the read-only interface the rest
 * of the Sky view uses: mode / moving / rate / getTime() / subscribe().
 */

/** Allowed play speeds (absolute value); negative runs backwards. */
export const SKY_RATES = Object.freeze([1, 10, 60, 600, 3600]);
export const DEFAULT_PLAY_RATE = 60;
/**
 * The clock never leaves years 1700..2300 UTC. astronomy-engine is documented
 * for far longer; the validity banner (skyValidity.js) names the narrower
 * range that was actually checked.
 */
export const SKY_TIME_MIN_MS = Date.UTC(1700, 0, 1);
export const SKY_TIME_MAX_MS = Date.UTC(2300, 0, 1);

export const clampSkyTime = (ms) =>
  Math.min(SKY_TIME_MAX_MS, Math.max(SKY_TIME_MIN_MS, ms));

/** A valid play rate (one of +/-SKY_RATES) or null. */
export function normalizeRate(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value) || value === 0) return null;
  return SKY_RATES.includes(Math.abs(value)) ? value : null;
}

export function createSkyClock({ now = () => Date.now() } = {}) {
  let mode = 'live';
  let fixedMs = null;
  let anchorMs = 0;
  let anchorWall = 0;
  let rate = DEFAULT_PLAY_RATE;
  const listeners = new Set();
  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener(clock);
      } catch {
        /* a broken listener must not stop the others */
      }
    }
  };
  // a range stop found inside getTime() is announced after the read returns
  let emitQueued = false;
  const queueEmit = () => {
    if (emitQueued) return;
    emitQueued = true;
    Promise.resolve().then(() => {
      emitQueued = false;
      emit();
    });
  };

  const playTime = () => anchorMs + (now() - anchorWall) * rate;

  /** Play mode stops (becomes fixed) at the ends of the range. */
  function read() {
    if (mode === 'live') return now();
    if (mode === 'fixed') return fixedMs;
    const t = playTime();
    if (t < SKY_TIME_MIN_MS || t > SKY_TIME_MAX_MS) {
      mode = 'fixed';
      fixedMs = clampSkyTime(t);
      queueEmit();
      return fixedMs;
    }
    return t;
  }

  const clock = {
    get mode() {
      return mode;
    },
    get rate() {
      return rate;
    },
    get playing() {
      return mode === 'play';
    },
    getTime: read,
    setLive() {
      if (mode === 'live') return;
      mode = 'live';
      fixedMs = null;
      emit();
    },
    setFixed(ms) {
      const value = Number(ms);
      if (!Number.isFinite(value)) return false;
      const t = clampSkyTime(value);
      if (mode === 'fixed' && fixedMs === t) return true;
      mode = 'fixed';
      fixedMs = t;
      emit();
      return true;
    },
    /** Start playing from the current Sky time (or `fromMs`). */
    play({ rate: nextRate, fromMs } = {}) {
      if (nextRate !== undefined) {
        const r = normalizeRate(nextRate);
        if (r == null) return false;
        rate = r;
      }
      const from = Number.isFinite(fromMs) ? fromMs : read();
      anchorMs = clampSkyTime(from);
      anchorWall = now();
      mode = 'play';
      fixedMs = null;
      emit();
      return true;
    },
    /** Stop at the current Sky time (fixed). Live and fixed are unchanged. */
    pause() {
      if (mode !== 'play') return false;
      fixedMs = clampSkyTime(playTime());
      mode = 'fixed';
      emit();
      return true;
    },
    /** Change the speed; a playing clock continues from where it is. */
    setRate(nextRate) {
      const r = normalizeRate(nextRate);
      if (r == null) return false;
      if (r === rate) return true;
      if (mode === 'play') {
        anchorMs = clampSkyTime(playTime());
        anchorWall = now();
      }
      rate = r;
      emit();
      return true;
    },
    /** Move the time by `deltaMs`; live becomes fixed, play keeps playing. */
    step(deltaMs) {
      const delta = Number(deltaMs);
      if (!Number.isFinite(delta)) return false;
      const t = clampSkyTime(read() + delta);
      if (mode === 'play') {
        anchorMs = t;
        anchorWall = now();
        emit();
        return true;
      }
      return clock.setFixed(t);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return clock;
}

/**
 * The time source the Sky view reads: the clock above behind a
 * read-only interface.
 */
export function createSkyTimeSource({ clock }) {
  const listeners = new Set();
  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener(source);
      } catch {
        /* keep going */
      }
    }
  };
  const removers = [clock.subscribe(emit)];
  const source = {
    /** 'live' | 'fixed' | 'play'. */
    get mode() {
      return clock.mode;
    },
    /** True when the time moves by itself (live, play). */
    get moving() {
      return clock.mode !== 'fixed';
    },
    /** Sky seconds per wall second (1 for live, 0 when stopped). */
    get rate() {
      if (clock.mode === 'live') return 1;
      return clock.mode === 'play' ? clock.rate : 0;
    },
    getTime() {
      return clock.getTime();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      for (const remove of removers.splice(0)) remove?.();
      listeners.clear();
    },
  };
  return source;
}
