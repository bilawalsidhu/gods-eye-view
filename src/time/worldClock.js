/**
 * The world's one time, in epoch ms. Every layer that draws something at a
 * moment reads it here instead of calling `Date.now()` itself, so layers can
 * never disagree about when the world is.
 *
 * Live is a mode, not a timestamp: while live the clock is the wall clock and
 * every layer behaves as it would reading `Date.now()`. Away from live the
 * clock holds a cursor, fixed or playing. Only the layers that follow the clock
 * move with the cursor; the rest keep reading the live edge through
 * `timeFor(id)`. On the page's clock the layers whose data has a time of its
 * own (the sky, satellites, launches and weather) follow it. Flights,
 * military aircraft and vessels follow it only when their source declares a
 * timeline, that is, can answer a snapshot at a given time (see
 * src/time/snapshotTimeline.js); otherwise they stay live.
 *
 * Playback is continuous (`cursor + elapsed × rate`) unless a driver takes
 * it: a driver steps the clock itself and moves it as it goes, so play and
 * pause hand over to it. Several drivers may be attached; play goes to the
 * newest that can play, pause to the one playing. Layers that load frames
 * (weather) do not drive it: they gate continuous play at their next frame.
 */

/**
 * A timeline mark as a layer gives it: its time in epoch ms, and optionally
 * a short label to show for it, the layer's own id for it and its kind.
 * @typedef {{time: number, label?: string, id?: string, kind?: string}} WorldClockMarkInput
 */

/**
 * A timeline mark as `coverage().markDetails` returns it: a finite time, and
 * only those of `label`, `id` and `kind` that are non-empty strings.
 * @typedef {Readonly<{time: number, label?: string, id?: string, kind?: string}>} WorldClockMark
 */

const MARK_TEXT = ['label', 'id', 'kind'];
/**
 * The longest label a mark carries, ellipsis and all, in characters as a
 * reader sees them (graphemes where the runtime can tell them, otherwise code
 * points), so an emoji or an accented letter is never split.
 */
export const WORLD_CLOCK_MARK_LABEL_LENGTH = 60;

const graphemes =
  typeof Intl?.Segmenter === 'function'
    ? (() => {
        const segmenter = new Intl.Segmenter(undefined, {
          granularity: 'grapheme',
        });
        return (text) =>
          Array.from(segmenter.segment(text), ({ segment }) => segment);
      })()
    : (text) => Array.from(text);

/** `mark` with its label cut to WORLD_CLOCK_MARK_LABEL_LENGTH, ending in `…`. */
function shownMark(mark) {
  if (!mark.label || mark.label.length <= WORLD_CLOCK_MARK_LABEL_LENGTH)
    return mark;
  const parts = graphemes(mark.label);
  if (parts.length <= WORLD_CLOCK_MARK_LABEL_LENGTH) return mark;
  const label = `${parts
    .slice(0, WORLD_CLOCK_MARK_LABEL_LENGTH - 1)
    .join('')
    .trimEnd()}…`;
  return Object.freeze({ ...mark, label });
}

/**
 * A mark (a number, or `{time, label?, id?, kind?}`) in its one shape, or
 * null for one with no finite time.
 * @param {unknown} input
 * @returns {WorldClockMark | null}
 */
function readMark(input) {
  if (typeof input === 'number')
    return Number.isFinite(input) ? Object.freeze({ time: input }) : null;
  if (!input || typeof input !== 'object') return null;
  const { time } = input;
  if (typeof time !== 'number' || !Number.isFinite(time)) return null;
  const mark = { time };
  for (const key of MARK_TEXT) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) mark[key] = value.trim();
  }
  return Object.freeze(mark);
}

// Marks in time order; at one time, by kind, label and id, so the order
// never depends on which source registered first.
const byText = (a = '', b = '') => (a < b ? -1 : a > b ? 1 : 0);
const byMark = (a, b) =>
  a.time - b.time ||
  byText(a.kind, b.kind) ||
  byText(a.label, b.label) ||
  byText(a.id, b.id);

/** The span a JS Date can hold, either side of 1970. */
const MAX_DATE_MS = 8.64e15;

/** Whether `ms` is a time the world clock can hold. */
export const isWorldTime = (ms) =>
  Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS;

/**
 * How often subscribers hear of a continuously playing cursor with no
 * animation frames to go by; with them, they hear of it every frame.
 */
export const WORLD_CLOCK_TICK_MS = 250;

/**
 * @param {{now?: () => number, monotonicNow?: () => number,
 *   setInterval?: typeof globalThis.setInterval,
 *   clearInterval?: typeof globalThis.clearInterval,
 *   requestFrame?: typeof globalThis.requestAnimationFrame | null,
 *   cancelFrame?: typeof globalThis.cancelAnimationFrame | null,
 *   follow?: Iterable<string>}} [options] `follow` lists the layers that
 *   move with the cursor from the start. Playing, the clock tells its
 *   listeners of the time each animation frame, or each tick without frames.
 */
export function createWorldClock({
  // Read at each call, so a stand-in for Date.now (a test's, a harness's)
  // reaches every layer as it did when they called Date.now themselves.
  now = () => Date.now(),
  monotonicNow = () => globalThis.performance.now(),
  setInterval = globalThis.setInterval,
  clearInterval = globalThis.clearInterval,
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis) ?? null,
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis) ?? null,
  follow = [],
} = {}) {
  const listeners = new Set();
  // Layers a host follows, and layers a part of the app holds following.
  const following = new Set(follow);
  const holds = new Map();
  const readers = new Map();
  const sources = new Set();
  const drivers = [];
  let live = true;
  // The cursor while fixed; while playing continuously, the cursor at `anchorMono`.
  let cursorMs = null;
  let anchorMono = 0;
  let rate = 1;
  let playing = false;
  // How many times the cursor has jumped (a seek, a return to live), so a
  // layer can tell a jump from the cursor playing on.
  let jumps = 0;
  // The driver handle stepping the clock, or null.
  let active = null;
  let ticker = null;
  let notifying = 0;
  // Layers loading what the cursor needs; continuous play holds while any is.
  const waits = new Map();
  // Times continuous play may not pass yet, by layer: each one's next frame.
  const gates = new Map();

  const continuous = () => playing && !active;
  const buffering = () => waits.size > 0;
  const isFollowed = (id) => following.has(id) || (holds.get(id) ?? 0) > 0;
  const followedIds = () => [
    ...new Set([...following, ...[...holds.keys()].filter(isFollowed)]),
  ];
  // A host's coverage that throws counts as none, so it cannot break the
  // listeners every state reaches.
  const spanOf = (source) => {
    let span;
    try {
      span = source.coverage();
    } catch (error) {
      console.error(`World time coverage failed: ${source.id}`, error);
      return null;
    }
    return span && span.end >= span.start ? span : null;
  };
  // Whether a layer that moves with the clock has time to show: only then is
  // there anything for a timeline to play.
  const isSupported = () => {
    for (const { source } of sources)
      if (isFollowed(source.id) && spanOf(source)) return true;
    return false;
  };
  const time = () => {
    if (live) return now();
    if (!continuous() || buffering()) return cursorMs;
    let at = cursorMs + (monotonicNow() - anchorMono) * rate;
    for (const gate of gates.values())
      if (gate >= cursorMs) at = Math.min(at, gate);
    return at;
  };
  const getState = () =>
    Object.freeze({
      live,
      timeMs: time(),
      playing,
      rate,
      // A driver steps the clock, at its own pace rather than the rate.
      stepping: Boolean(active),
      // Playing, but held while a layer loads what the cursor needs.
      buffering: continuous() && buffering(),
      following: followedIds(),
      supported: isSupported(),
      jumps,
    });
  // Each listener hears the state as it is when called. A change made from
  // inside a listener notifies everyone afresh, and the outer round stops, so
  // nobody is left holding a state that has since changed.
  // A round's state is read once: any change made during it starts a new one.
  const notify = () => {
    const round = ++notifying;
    let state = null;
    for (const listener of [...listeners]) {
      if (round !== notifying) return;
      if (!listeners.has(listener)) continue;
      try {
        listener((state ??= getState()));
      } catch (error) {
        console.error('World clock listener failed', error);
      }
    }
  };
  // Playing, the time moves on smoothly: each frame, so the timeline and the
  // globe move with it and a layer's next frame is met as it comes, or each
  // tick where there are no frames.
  const frames = Boolean(requestFrame && cancelFrame);
  const frame = () => {
    ticker = requestFrame(frame);
    notify();
  };
  const syncTicker = () => {
    if (continuous() && listeners.size) {
      if (ticker === null)
        ticker = frames
          ? requestFrame(frame)
          : setInterval(notify, WORLD_CLOCK_TICK_MS);
    } else if (ticker !== null) {
      if (frames) cancelFrame(ticker);
      else clearInterval(ticker);
      ticker = null;
    }
  };
  const changed = () => {
    syncTicker();
    notify();
  };
  // Freeze a continuously playing cursor where it is.
  const settle = () => {
    if (continuous()) cursorMs = time();
    anchorMono = monotonicNow();
  };

  const api = {
    /** The live edge: the wall clock, whatever the cursor does. */
    wallNow: () => now(),
    /** The world time: the wall clock while live, else the cursor. */
    now: time,
    isLive: () => live,
    isPlaying: () => playing,
    getRate: () => rate,

    /** Hold the world at `ms`; a playing clock plays on from there. */
    seek(ms) {
      if (!isWorldTime(ms)) throw new TypeError('World time must be epoch ms');
      if (!live && cursorMs === ms && !continuous()) return;
      live = false;
      cursorMs = ms;
      anchorMono = monotonicNow();
      jumps += 1;
      changed();
    },
    /**
     * Back to the wall clock; playback stops. The rate stays as chosen, so
     * the next play, from wherever it starts, runs at it.
     */
    goLive() {
      if (live && !playing) return;
      const stepping = active;
      live = true;
      cursorMs = null;
      playing = false;
      active = null;
      jumps += 1;
      // Its driven(false) finds nothing left to stop.
      stepping?.driver.pause();
      changed();
    },
    /**
     * Play from the cursor (from now, when live). A driver steps it unless
     * `continuous`, which runs the cursor at the rate past every driver.
     */
    play({ rate: nextRate, continuous: runOn = false } = {}) {
      if (nextRate !== undefined) api.setRate(nextRate);
      if (playing) return;
      for (let index = drivers.length - 1; !runOn && index >= 0; index -= 1) {
        if (drivers[index].driver.play() !== false) return;
      }
      if (live) {
        live = false;
        cursorMs = now();
      }
      playing = true;
      anchorMono = monotonicNow();
      changed();
    },
    pause() {
      if (!playing) return;
      if (active) {
        active.driver.pause();
        return;
      }
      settle();
      playing = false;
      changed();
    },
    togglePlay() {
      return playing ? api.pause() : api.play();
    },
    /**
     * Hold continuous play where it is while layer `id` loads what the cursor
     * needs, as a video waits on its buffer; play goes on once every hold is
     * released. A seek still moves the cursor. Returns the release. Neither
     * tells listeners (play's own ticks do), so a layer can take and release a
     * hold mid-change without anyone moving the clock under it.
     */
    wait(id) {
      settle();
      waits.set(id, (waits.get(id) ?? 0) + 1);
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        const count = waits.get(id) - 1;
        if (count > 0) {
          waits.set(id, count);
          return;
        }
        waits.delete(id);
        // Play goes on from where it held, not from where it would have been.
        if (!buffering()) anchorMono = monotonicNow();
      };
    },
    /**
     * Keep continuous play from passing `ms` (null lifts it): the time layer
     * `id` shows next, which it has yet to load. Play stops there, to wait on
     * the load as it starts, rather than rush past frames between ticks.
     */
    gate(id, ms) {
      settle();
      if (ms === null || ms === undefined) gates.delete(id);
      else if (isWorldTime(ms)) gates.set(id, ms);
    },
    /**
     * Simulated ms per real ms for continuous playback. It holds while paused
     * and live, so any play (`play()` with no rate) runs at the one chosen.
     */
    setRate(nextRate) {
      if (!Number.isFinite(nextRate) || nextRate <= 0)
        throw new RangeError('World clock rate must be positive');
      if (nextRate === rate) return;
      settle();
      rate = nextRate;
      changed();
    },

    /**
     * Offer a stepping player. The driver moves the clock with `seek()` and
     * reports through its handle's `driven(playing, atMs?)`; its `play()`
     * returns false when it cannot play, and the clock tries an older driver
     * or plays continuously instead.
     * @param {{play: () => (boolean|void), pause: () => void}} driver
     * @returns {{driven: (playing: boolean, atMs?: number) => void,
     *   detach: () => number}} `detach()` returns how many drivers remain.
     */
    attachDriver(driver) {
      const handle = {
        driver,
        /** This driver started stepping (at `atMs`, if given) or stopped. */
        driven(isPlaying, atMs) {
          if (!drivers.includes(handle)) return;
          if (!isPlaying) {
            if (active !== handle) return;
            active = null;
            playing = false;
            changed();
            return;
          }
          // A continuous run hands over where it is; another driver stops.
          settle();
          const previous = active;
          active = handle;
          playing = true;
          live = false;
          if (Number.isFinite(atMs)) {
            cursorMs = atMs;
            jumps += 1;
          } else cursorMs ??= now();
          anchorMono = monotonicNow();
          if (previous && previous !== handle) previous.driver.pause();
          changed();
        },
        detach() {
          const index = drivers.indexOf(handle);
          if (index < 0) return drivers.length;
          handle.driven(false);
          drivers.splice(index, 1);
          return drivers.length;
        },
      };
      drivers.push(handle);
      return handle;
    },

    /** Let layer `id` move with the cursor instead of reading the live edge. */
    follow(id, on = true) {
      if (on === following.has(id)) return;
      if (on) following.add(id);
      else following.delete(id);
      changed();
    },
    /**
     * Keep layer `id` following until the returned release is called, however
     * many parts of the app hold it.
     */
    hold(id) {
      const was = isFollowed(id);
      holds.set(id, (holds.get(id) ?? 0) + 1);
      if (!was) changed();
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        const count = holds.get(id) - 1;
        if (count > 0) holds.set(id, count);
        else holds.delete(id);
        if (!isFollowed(id)) changed();
      };
    },
    follows: isFollowed,
    /**
     * The time layer `id` draws at: the cursor when it follows the clock,
     * otherwise the live edge.
     * @returns {() => number}
     */
    timeFor(id) {
      let reader = readers.get(id);
      if (!reader) {
        reader = () => (isFollowed(id) ? time() : now());
        readers.set(id, reader);
      }
      return reader;
    },

    /**
     * A layer's span of time it can show, for a host's timeline; null while
     * it has none (off, or nothing loaded). Returns the unregister.
     *
     * `marks` are the moments in that span worth going to (a launch, a strong
     * earthquake), drawn as ticks the timeline's arrow keys step to. Each is
     * an epoch ms number, or `{time, label?, id?, kind?}`: `label` is short
     * text the timeline shows for it (a name, `M6.4 · a place`; one longer
     * than WORLD_CLOCK_MARK_LABEL_LENGTH is cut to it, ending in `…`), `id` the
     * layer's own key for the event and `kind` what sort of event it is.
     * Numbers and objects may be mixed; a mark with no finite time is
     * ignored, as are a label, id or kind that is not a non-empty string.
     * @param {{id: string, coverage: () => ({start: number, end: number, marks?: Array<number | WorldClockMarkInput>} | null)}} source
     */
    register(source) {
      // Each registration is its own, even under a shared id.
      const entry = { source };
      sources.add(entry);
      changed();
      return () => {
        if (sources.delete(entry)) changed();
      };
    },
    /** A source's coverage changed (frames loaded, the layer paused). */
    coverageChanged: () => changed(),
    /** Whether a followed layer has time to show; see getState().supported. */
    isSupported,
    /**
     * The union of the registered sources' coverage, or null with none:
     * `{start, end, marks, markDetails}`. `marks` is every mark's time, once
     * each, in order, as numbers. `markDetails` is the marks themselves, in
     * time order, each `{time, label?, id?, kind?}` (frozen): a mark several
     * sources give alike is there once, and a bare time is dropped where a
     * mark with more to say shares it.
     * @returns {{start: number, end: number, marks: number[], markDetails: WorldClockMark[]} | null}
     */
    coverage() {
      let start = Infinity;
      let end = -Infinity;
      const details = new Map();
      for (const { source } of sources) {
        const span = spanOf(source);
        if (!span) continue;
        start = Math.min(start, span.start);
        end = Math.max(end, span.end);
        for (const input of span.marks ?? []) {
          const mark = readMark(input);
          if (!mark) continue;
          const key = JSON.stringify([
            mark.time,
            mark.label,
            mark.id,
            mark.kind,
          ]);
          if (!details.has(key)) details.set(key, mark);
        }
      }
      if (start > end) return null;
      const told = new Set();
      for (const mark of details.values())
        if (Object.keys(mark).length > 1) told.add(mark.time);
      // Marks merge on their whole label, and are cut for showing after, so
      // two whose labels only differ past the cut stay two.
      const markDetails = [...details.values()]
        .filter((mark) => Object.keys(mark).length > 1 || !told.has(mark.time))
        .sort(byMark)
        .map(shownMark);
      const marks = [...new Set(markDetails.map((mark) => mark.time))];
      return { start, end, marks, markDetails };
    },

    getState,
    subscribe(listener) {
      listeners.add(listener);
      syncTicker();
      return () => {
        listeners.delete(listener);
        syncTicker();
      };
    },
  };
  return api;
}

/**
 * The page's world clock. Layers, the sky and a host all read this one. The
 * sky and the HUD's clock show the world time; satellites (and the launched
 * missions flying on their time) and launches have a time of their own and
 * move with it; weather holds each product it shows.
 */
export const worldClock = createWorldClock({
  follow: ['sky', 'hud', 'satellites', 'rocket-launches'],
});

/** The time layer `id` draws at on the page's clock. */
export const worldTimeFor = (id) => worldClock.timeFor(id);
