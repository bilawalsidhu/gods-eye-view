<script setup>
// PROTOTYPE of the world timeline's design (not for merging as is).
//
// One line at rest: the clock, the shuttle (rewind, play, forward), the speed,
// a track over a window of time that ends at now, the window's length, the
// lanes switch and LIVE. The track is a window, never the whole archive: it
// shows the last day by default and zooms from an hour to a month. Under its
// ruler one strip says where the layers on have data. The lanes, opened on
// demand, give each layer its own row.
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { worldClock } from '../../../time/worldClock.js';
import { useWorldTimeStore } from '../../stores/worldTime.js';
import { useEntityCardStore } from '../../stores/entityCard.js';
import { vRootClass } from '../../rail/rootClass.js';
import { recordedJourney } from '../../../proto/recordedFlights.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const store = useWorldTimeStore();
const { time } = storeToRefs(store);
const cards = useEntityCardStore();

// ── What each layer's time is made of ───────────────────────────────────
// observed: positions or frames a sensor reported. computed: worked out from
// orbital elements, not seen. events: moments, drawn as marks.
const LANES = {
  flights: { label: 'FLIGHTS', kind: 'observed', order: 1 },
  military: { label: 'MILITARY', kind: 'observed', order: 2 },
  vessels: { label: 'VESSELS', kind: 'observed', order: 3 },
  'weather-radar': { label: 'RAIN RADAR', kind: 'frames', order: 4 },
  'weather-satellite': { label: 'CLOUDS', kind: 'frames', order: 5 },
  'weather-lightning': { label: 'LIGHTNING', kind: 'frames', order: 6 },
  satellites: { label: 'SATELLITES', kind: 'computed', order: 7 },
  earthquakes: { label: 'QUAKES', kind: 'events', order: 8 },
  'rocket-launches': { label: 'LAUNCHES', kind: 'events', order: 9 },
};
const laneOf = (id) =>
  LANES[id] ?? {
    label: id.replace(/^weather-/, '').replaceAll('-', ' ').toUpperCase(),
    kind: 'observed',
    order: 20,
  };

// ── Speeds, in world time per real second ───────────────────────────────
const SPEEDS = [
  { rate: 1, label: '1×' },
  { rate: 60, label: '1 MIN/S' },
  { rate: 300, label: '5 MIN/S' },
  { rate: 900, label: '15 MIN/S' },
  { rate: 3600, label: '1 H/S' },
  { rate: 21600, label: '6 H/S' },
  { rate: 86400, label: '1 D/S' },
];
// The window's length picks a speed that plays it through in about a minute.
const WINDOWS = [
  { key: '1H', length: HOUR, speed: 1 },
  { key: '6H', length: 6 * HOUR, speed: 2 },
  { key: '24H', length: DAY, speed: 3 },
  { key: '7D', length: 7 * DAY, speed: 5 },
  { key: '30D', length: 30 * DAY, speed: 6 },
];

const speedIndex = ref(3);
const speedPinned = ref(false);
const speed = computed(() => SPEEDS[speedIndex.value]);
// -1 rewinding, 0 still, 1 playing on.
const direction = ref(0);
const windowKey = ref('24H');
// The window: `length` long, ending at `end`, or at now while `end` is null.
const win = shallowRef({ length: DAY, end: null });
const lanesOpen = ref(false);
// At rest (live, untouched) the bar is a small clock with a strip of the last
// day. Touching time (a rewind, a drag, a key) opens it to the full bar.
const touched = ref(false);
const hover = shallowRef(null);
const trackEl = ref(null);

const nowMs = () => worldClock.wallNow();
const past = computed(() => !time.value.live && time.value.timeMs < nowMs() - 5000);
const future = computed(() => !time.value.live && time.value.timeMs > nowMs() + 5000);
const tense = computed(() => (future.value ? 'future' : past.value ? 'past' : 'live'));

// ── The window on the track ─────────────────────────────────────────────
const view = computed(() => {
  // Read the time so a window pinned to now moves on with it.
  void time.value.timeMs;
  const end = win.value.end ?? nowMs() + win.value.length * 0.04;
  return { start: end - win.value.length, end };
});
const place = (ms) =>
  ((ms - view.value.start) / (view.value.end - view.value.start)) * 100;
const clampPct = (pct) => Math.min(100, Math.max(0, pct));
const timeAt = (clientX) => {
  const { left, width } = trackEl.value.getBoundingClientRect();
  const share = width > 0 ? (clientX - left) / width : 1;
  return view.value.start + Math.min(1, Math.max(0, share)) * win.value.length;
};
function setWindow(key) {
  const preset = WINDOWS.find((each) => each.key === key);
  windowKey.value = key;
  const at = time.value.timeMs;
  // Pinned to now while the time shown is within the window's reach of now.
  const pinned = time.value.live || nowMs() - at < preset.length * 0.9;
  win.value = {
    length: preset.length,
    end: pinned ? null : at + preset.length * 0.3,
  };
  if (!speedPinned.value) speedIndex.value = preset.speed;
  applyRate();
}
// Keep the time shown on the track: it pages on as play reaches an edge.
function keepInView(ms) {
  const { start, end } = view.value;
  const length = win.value.length;
  if (ms >= start + length * 0.02 && ms <= end) return;
  const nextEnd = ms < start + length * 0.02 ? ms + length * 0.8 : ms + length * 0.2;
  win.value = { length, end: nextEnd >= nowMs() ? null : nextEnd };
}
function zoomAround(ms, factor) {
  const length = Math.min(60 * DAY, Math.max(10 * MIN, win.value.length * factor));
  const share = (ms - view.value.start) / win.value.length;
  const end = ms + (1 - share) * length;
  win.value = { length, end: end >= nowMs() + length * 0.04 ? null : end };
  windowKey.value = WINDOWS.find((each) => each.length === length)?.key ?? '';
}
function pan(ms) {
  const end = view.value.end + ms;
  win.value = {
    length: win.value.length,
    end: end >= nowMs() + win.value.length * 0.04 && !hasFuture.value ? null : end,
  };
}

// ── Where there is data ─────────────────────────────────────────────────
const sources = computed(() => {
  void time.value;
  const byId = new Map();
  for (const source of worldClock.sources()) {
    const known = byId.get(source.id);
    if (!known) byId.set(source.id, { ...source });
    else {
      known.start = Math.min(known.start, source.start);
      known.end = Math.max(known.end, source.end);
    }
  }
  return [...byId.values()]
    .map((source) => {
      const lane = laneOf(source.id);
      // A layer of frames shows its newest frame until the next one comes, so
      // its data reaches a little past that frame (never past now).
      const frames = source.frames ?? [];
      const spacing =
        frames.length > 1 ? (frames.at(-1) - frames[0]) / (frames.length - 1) : 0;
      const end =
        lane.kind === 'frames'
          ? Math.min(nowMs(), source.end + Math.max(2 * spacing, 15 * MIN))
          : source.end;
      return { ...source, ...lane, end, lastFrame: source.end };
    })
    .sort((a, b) => a.order - b.order);
});
const hasFuture = computed(() =>
  sources.value.some((source) => source.end > nowMs() + HOUR),
);
// Layers whose time is a stretch of data (events have marks, not coverage).
const spans = computed(() =>
  sources.value.filter((source) => source.kind !== 'events'),
);
// The one strip of the bar: each stretch says how many of those layers have
// data there. All of them: solid. Some: hatched. None: empty.
const strip = computed(() => {
  const list = spans.value;
  if (!list.length) return [];
  const { start, end } = view.value;
  const cuts = new Set([start, end]);
  for (const source of list)
    for (const edge of [source.start, Math.min(source.end, end)])
      if (edge > start && edge < end) cuts.add(edge);
  const edges = [...cuts].sort((a, b) => a - b);
  const out = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    const from = edges[index];
    const to = edges[index + 1];
    const mid = (from + to) / 2;
    const have = list.filter((source) => mid >= source.start && mid <= source.end);
    if (!have.length) continue;
    out.push({
      left: place(from),
      width: place(to) - place(from),
      all: have.length === list.length,
      future: mid > nowMs(),
      title: `${have.map((source) => source.label).join(' · ')}`,
    });
  }
  return out;
});
const lanes = computed(() =>
  sources.value.map((source) => {
    const { start, end } = view.value;
    const from = Math.max(source.start, start);
    const to = Math.min(source.end, end);
    const pxPerMs = (trackEl.value?.clientWidth ?? 600) / win.value.length;
    const frames = (source.frames ?? []).filter((ms) => ms >= start && ms <= end);
    const every = source.frames ?? [];
    const spacing =
      every.length > 1 ? (every.at(-1) - every[0]) / (every.length - 1) : 0;
    const at = time.value.timeMs;
    // What the layer shows at the time: the frame at or before it, or none.
    let status = '';
    const count = (source.marks ?? []).length;
    if (source.kind === 'events') status = `${count} ${count === 1 ? 'EVENT' : 'EVENTS'}`;
    else if (at < source.start) status = `NO DATA · STARTS ${day(source.start)} ${hhmm(source.start)}Z`;
    else if (at > source.end) status = 'NO DATA YET';
    else if (source.kind === 'frames' && source.frames?.length) {
      const frame = source.frames.findLast((ms) => ms <= at) ?? source.frames[0];
      const every = Math.round(spacing / MIN);
      status = `FRAME ${hhmm(frame)}Z${every ? ` · EVERY ${every} MIN` : ''}`;
    } else if (source.kind === 'computed') status = 'COMPUTED FROM ORBITS';
    else status = `OBSERVED · SINCE ${day(source.start)} ${hhmm(source.start)}Z`;
    return {
      ...source,
      shown: to > from,
      left: place(from),
      width: place(to) - place(from),
      nowLeft: place(Math.min(nowMs(), end)),
      frames: spacing * pxPerMs >= 4 ? frames.map((ms) => place(ms)) : [],
      marks: (source.marks ?? [])
        .map((mark) => (typeof mark === 'number' ? mark : mark?.time))
        .filter((ms) => ms >= start && ms <= end)
        .map((ms) => place(ms)),
      missing: source.kind !== 'events' && (at < source.start || at > source.end),
      status,
      since: source.start,
    };
  }),
);
// What the bar says when the time shown has no data for a layer that is on:
// which layers, and the nearest time that has them all, one press away.
const gap = computed(() => {
  if (time.value.live) return null;
  const at = time.value.timeMs;
  const list = spans.value;
  const missing = list.filter((source) => at < source.start || at > source.end);
  if (!missing.length) return null;
  const from = Math.max(...list.map((source) => source.start));
  const to = Math.min(...list.map((source) => source.end), nowMs());
  const nearest = from <= to ? Math.min(to, Math.max(from, at)) : null;
  return {
    text:
      missing.length === list.length
        ? 'NO DATA AT THIS TIME'
        : `NO ${missing.map((source) => source.label).join(', ')} HERE`,
    nearest,
    label: nearest === null ? '' : `${nearest > at ? 'STARTS' : 'ENDS'} ${day(nearest)} ${hhmm(nearest)}Z`,
  };
});
const marks = computed(() => {
  const { start, end } = view.value;
  return (time.value.span?.markDetails ?? [])
    .filter((mark) => mark.time >= start && mark.time <= end)
    .map((mark) => ({ ...mark, left: place(mark.time) }));
});

// ── The ruler ───────────────────────────────────────────────────────────
const STEPS = [MIN, 5 * MIN, 15 * MIN, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const two = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
};
const day = (ms) => {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${two(d.getUTCDate())}`;
};
const ruler = computed(() => {
  const width = trackEl.value?.clientWidth ?? 600;
  const { start, end } = view.value;
  const want = (win.value.length / width) * 84;
  const step = STEPS.find((each) => each >= want) ?? 30 * DAY;
  const minor = step / (step === DAY || step === 7 * DAY ? 4 : step === 3 * HOUR ? 3 : step === 5 * MIN ? 5 : 4);
  const ticks = [];
  for (let ms = Math.ceil(start / minor) * minor; ms <= end; ms += minor) {
    const major = ms % step === 0;
    const midnight = ms % DAY === 0;
    ticks.push({
      ms,
      left: place(ms),
      major,
      midnight,
      label: major ? (step >= DAY || midnight ? day(ms) : hhmm(ms)) : '',
    });
  }
  return ticks;
});

// ── The clock ───────────────────────────────────────────────────────────
const clock = computed(() => {
  const ms = time.value.timeMs;
  const d = new Date(ms);
  const offset = ms - nowMs();
  const abs = Math.abs(offset);
  let ago;
  if (abs < 5000) ago = '';
  else if (abs < HOUR) ago = `${Math.floor(abs / MIN)}M ${two(Math.floor((abs % MIN) / 1000))}S`;
  else if (abs < 2 * DAY) ago = `${Math.floor(abs / HOUR)}H ${two(Math.floor((abs % HOUR) / MIN))}M`;
  else ago = `${Math.floor(abs / DAY)}D ${two(Math.floor((abs % DAY) / HOUR))}H`;
  const local = new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  return {
    time: `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`,
    date: `${day(ms)} ${d.getUTCFullYear()}`,
    ago: ago ? `${offset < 0 ? '−' : '+'}${ago}` : '',
    local: local.toUpperCase(),
  };
});
const headPct = computed(() => place(time.value.timeMs));
const nowPct = computed(() => place(nowMs()));

// ── The shuttle ─────────────────────────────────────────────────────────
// Playing on is the clock's own continuous play. Rewinding moves the clock
// back each frame, the way a drag of the handle does, so every layer follows
// it as it follows a scrub.
let frame = null;
let lastFrame = 0;
let startedBeforeNow = false;
// Rewind runs out where the observed layers' data does (the end of the
// tape); with only computed layers on, where theirs does.
const earliest = () => {
  const observed = spans.value.filter((source) => source.kind !== 'computed');
  const list = observed.length ? observed : spans.value;
  return list.length
    ? Math.min(...list.map((source) => source.start))
    : (time.value.span?.start ?? nowMs());
};
// The speed before J, L or a hold raised it; stopping gives it back.
let baseSpeed = null;
function applyRate() {
  worldClock.setRate(speed.value.rate);
}
function stopRewind() {
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
}
function still() {
  stopRewind();
  if (worldClock.isPlaying()) worldClock.pause();
  direction.value = 0;
  if (baseSpeed !== null) {
    speedIndex.value = baseSpeed;
    baseSpeed = null;
    applyRate();
  }
}
function rewindFrame(stamp) {
  frame = requestAnimationFrame(rewindFrame);
  const elapsed = Math.min(1000, stamp - lastFrame);
  lastFrame = stamp;
  const floor = earliest();
  const next = worldClock.now() - elapsed * speed.value.rate;
  if (next <= floor) {
    worldClock.seek(floor);
    still();
    return;
  }
  worldClock.seek(next);
}
function run(next) {
  if (next === 0) return still();
  stopRewind();
  direction.value = next;
  if (next < 0) {
    if (worldClock.isPlaying()) worldClock.pause();
    if (worldClock.isLive()) worldClock.seek(nowMs() - 1000);
    lastFrame = performance.now();
    frame = requestAnimationFrame(rewindFrame);
    return;
  }
  if (worldClock.isLive()) return still();
  startedBeforeNow = worldClock.now() < nowMs();
  applyRate();
  worldClock.play({ continuous: true });
}
function faster(by) {
  speedIndex.value = Math.min(SPEEDS.length - 1, Math.max(0, speedIndex.value + by));
  speedPinned.value = true;
  applyRate();
}
// J and L, as an editor's shuttle: the first press runs that way, each press
// after it runs faster; the other way's key turns it round at the same speed.
function shuttle(way) {
  if (direction.value === way) {
    baseSpeed ??= speedIndex.value;
    speedIndex.value = Math.min(SPEEDS.length - 1, speedIndex.value + 1);
    applyRate();
  } else run(way);
}
function togglePlay() {
  if (direction.value !== 0) return still();
  run(time.value.live ? -1 : 1);
}
function goLive() {
  still();
  touched.value = false;
  lanesOpen.value = false;
  store.goLive();
  win.value = { length: win.value.length, end: null };
}
// Play that reaches now goes live there; it does not run on into what the
// satellites' orbits predict unless it started there.
watch(
  () => time.value.timeMs,
  (ms) => {
    if (direction.value > 0 && startedBeforeNow && ms >= nowMs() - 500) goLive();
    if (direction.value !== 0 && !dragging) keepInView(ms);
    if (direction.value > 0 && !time.value.playing && !time.value.live) direction.value = 0;
  },
);
// Held: it rewinds (or runs on) while held, faster the longer, and stops on
// release. Tapped: it latches, as J and L do.
const HOLD_MS = 350;
let holdAt = 0;
let holdBase = 0;
let ramp = null;
function holdStart(way, event) {
  event.currentTarget.setPointerCapture?.(event.pointerId);
  holdAt = performance.now();
  holdBase = speedIndex.value;
  if (direction.value === way) shuttle(way);
  else run(way);
  holdBase = speedIndex.value;
  ramp = setInterval(() => {
    const held = performance.now() - holdAt;
    const up = held > 5000 ? 2 : held > 2000 ? 1 : 0;
    const next = Math.min(SPEEDS.length - 1, holdBase + up);
    if (next !== speedIndex.value) {
      baseSpeed ??= holdBase;
      speedIndex.value = next;
      applyRate();
    }
  }, 200);
}
function holdEnd() {
  if (ramp === null) return;
  clearInterval(ramp);
  ramp = null;
  if (performance.now() - holdAt < HOLD_MS) return;
  baseSpeed ??= holdBase;
  still();
}

// ── Stepping ────────────────────────────────────────────────────────────
// A step is the finest frame of the layers on (radar's ten minutes), or with
// none, a two-hundredth of the window rounded to something a person says.
const stepMs = computed(() => {
  let finest = Infinity;
  for (const source of sources.value) {
    const frames = source.frames ?? [];
    if (frames.length > 1)
      finest = Math.min(finest, (frames.at(-1) - frames[0]) / (frames.length - 1));
  }
  if (Number.isFinite(finest)) return Math.max(MIN, Math.round(finest / MIN) * MIN);
  return STEPS.find((each) => each >= win.value.length / 200) ?? HOUR;
});
function seekTo(ms) {
  still();
  store.scrub(ms, win.value.length);
  keepInView(ms);
}
const step = (way) => seekTo(time.value.timeMs + way * stepMs.value);
function toMark(way) {
  const list = time.value.span?.marks ?? [];
  const at = time.value.timeMs;
  const to = way < 0 ? list.findLast((ms) => ms < at - 1000) : list.find((ms) => ms > at + 1000);
  if (to !== undefined) seekTo(to);
}

// ── The pointer on the track ────────────────────────────────────────────
let dragging = false;
// From rest the bar opens under the pointer, so the drag is measured from
// where it began (now) rather than by where the pointer is on the track.
let pull = null;
function onDown(event) {
  if (event.button > 0) return;
  dragging = true;
  event.currentTarget.setPointerCapture?.(event.pointerId);
  still();
  if (!engaged.value) {
    pull = { x: event.clientX, ms: nowMs() };
    touched.value = true;
    return;
  }
  pull = null;
  store.scrub(snap(timeAt(event.clientX), event), win.value.length);
}
function snap(ms, event) {
  if (event.altKey) return ms;
  const px = (trackEl.value.clientWidth / win.value.length) * 1;
  let best = ms;
  let near = 6;
  for (const mark of time.value.span?.marks ?? []) {
    const off = Math.abs(mark - ms) * px;
    if (off < near) {
      near = off;
      best = mark;
    }
  }
  return best;
}
function onMove(event) {
  const ms = timeAt(event.clientX);
  const mark = marks.value.find(
    (each) => Math.abs(each.time - ms) * (trackEl.value.clientWidth / win.value.length) < 6,
  );
  hover.value = { pct: place(ms), ms, label: mark?.label ?? '' };
  if (!dragging) return;
  if (pull) {
    const moved = ((event.clientX - pull.x) / trackEl.value.clientWidth) * win.value.length;
    if (Math.abs(event.clientX - pull.x) > 3)
      store.scrub(Math.min(nowMs(), pull.ms + moved), win.value.length);
    return;
  }
  store.scrub(snap(ms, event), win.value.length);
}
function onUp() {
  dragging = false;
  pull = null;
}
function onWheel(event) {
  event.preventDefault();
  const unit = [1, 16, 400][event.deltaMode] ?? 1;
  const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
  if (sideways || event.shiftKey) {
    const pixels = (sideways ? event.deltaX : event.deltaY) * unit;
    pan((pixels / trackEl.value.clientWidth) * win.value.length);
    return;
  }
  zoomAround(timeAt(event.clientX), Math.exp(event.deltaY * unit * 0.0025));
}

// ── Keys ────────────────────────────────────────────────────────────────
function onKey(event) {
  if (!time.value.span) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  )
    return;
  const key = event.key.toLowerCase();
  if (key === 'j') shuttle(-1);
  else if (key === 'l') shuttle(1);
  else if (key === 'k') togglePlay();
  else if (key === ',') step(-1);
  else if (key === '.') step(1);
  else if (key === '[') toMark(-1);
  else if (key === ']') toMark(1);
  else if (key === '\\') goLive();
  else return;
  event.preventDefault();
}
onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.__wt = { worldClock, cards };
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  stopRewind();
  clearInterval(ramp);
});

// ── The thing selected ──────────────────────────────────────────────────
// Selecting an aircraft gives the track its journey: the stretch it was
// observed over, with a way to its first fix and a window that fits it.
const journey = shallowRef(null);
const selected = computed(() => {
  const card = cards.card;
  if (!card) return null;
  const id = card.id ?? card.identity?.id ?? card.reference;
  const layer = card.layerId ?? card.identity?.layerId ?? card.kind;
  return id ? { id: String(id), layer, title: card.title ?? card.name ?? String(id) } : null;
});
watch(
  () => selected.value?.id,
  async (id) => {
    journey.value = null;
    if (!id) return;
    const found = await recordedJourney(id);
    if (found && selected.value?.id === id)
      journey.value = { ...found, title: selected.value.title };
  },
  { immediate: true },
);
const journeyBar = computed(() => {
  if (!journey.value) return null;
  const { start, end } = view.value;
  const from = Math.max(journey.value.start, start);
  const to = Math.min(Math.max(journey.value.end, nowMs()), end);
  return {
    left: place(from),
    width: Math.max(0.4, place(to) - place(from)),
    startShown: journey.value.start >= start,
    startLeft: place(journey.value.start),
  };
});
function fitJourney() {
  const length = Math.max(20 * MIN, (nowMs() - journey.value.start) * 1.25);
  win.value = { length, end: null };
  windowKey.value = '';
}
const toJourneyStart = () => seekTo(journey.value.start + 1000);

// The first time the bar opens, the window is the shortest that holds the
// newest-starting layer's data, and never longer than a day.
let opened = false;
function openWindow() {
  if (opened) return;
  opened = true;
  const starts = spans.value
    .filter((source) => source.kind !== 'computed')
    .map((source) => source.start);
  if (!starts.length) return;
  const reach = nowMs() - Math.max(...starts);
  const preset =
    WINDOWS.find((each) => each.length >= reach * 1.1 && each.length <= DAY) ??
    WINDOWS[2];
  windowKey.value = preset.key;
  win.value = { length: preset.length, end: null };
  if (!speedPinned.value) speedIndex.value = preset.speed;
}
const engaged = computed(
  () => !time.value.live || lanesOpen.value || direction.value !== 0 || touched.value,
);
// ── The page ────────────────────────────────────────────────────────────
// The dock above rises by the bar's height; the HUD's stamp reads the tense.
const root = ref(null);
const rightEl = ref(null);
const rightWidth = ref(250);
let sizes = null;
watch(rightEl, (el) => {
  sizes?.disconnect();
  if (!el) return;
  sizes = new ResizeObserver(() => (rightWidth.value = el.offsetWidth));
  sizes.observe(el);
});
const lift = computed(() => {
  if (!time.value.span) return 0;
  if (!engaged.value) return 50;
  return 92 + (lanesOpen.value ? lanes.value.length * 18 + 10 : 0);
});
watch(engaged, (on) => on && openWindow(), { flush: 'sync' });
watch(
  [lift, tense, () => Boolean(time.value.span)],
  () => {
    const body = document.body;
    body.style.setProperty('--world-timeline-lift', `${lift.value}px`);
    body.dataset.worldTense = time.value.span ? tense.value : 'live';
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  document.body.style.removeProperty('--world-timeline-lift');
  delete document.body.dataset.worldTense;
});
const speedLabel = computed(() =>
  direction.value < 0 ? `◀ ${speed.value.label}` : direction.value > 0 ? `${speed.value.label} ▶` : speed.value.label,
);
</script>

<template>
  <div
    v-if="time.supported && time.span"
    id="world-timeline"
    ref="root"
    v-root-class="{ 'has-world-timeline': true }"
    class="wt"
    :class="[`is-${tense}`, engaged ? 'is-engaged' : 'is-rest', { 'is-open': lanesOpen, 'is-running': direction !== 0 }]"
    role="group"
    :aria-label="t('World time')"
  >
    <!-- The lanes: each layer's own stretch of data, opened on demand. -->
    <div v-if="lanesOpen" class="wt-lanes">
      <div v-for="lane in lanes" :key="lane.id" class="wt-lane" :class="[`is-${lane.kind}`, { 'is-missing': lane.missing }]">
        <span class="wt-lane-track">
          <span v-if="lane.shown && lane.kind !== 'events'" class="wt-lane-bar" :style="{ left: `${lane.left}%`, width: `${lane.width}%` }"></span>
          <span v-for="(at, index) in lane.frames" :key="`f${index}`" class="wt-lane-frame" :style="{ left: `${at}%` }"></span>
          <span v-for="(at, index) in lane.marks" :key="`m${index}`" class="wt-lane-mark" :style="{ left: `${at}%` }"></span>
          <span class="wt-lane-head" :style="{ left: `${clampPct(headPct)}%` }"></span>
        </span>
        <span class="wt-lane-name">{{ lane.label }}</span>
        <span class="wt-lane-status">{{ lane.status }}</span>
      </div>
    </div>

    <div class="wt-bar">
      <!-- The clock: one place to read the time, whatever the handle does. -->
      <button type="button" class="wt-clock" :title="`${clock.date} · ${clock.local}`" :aria-label="t('Back to live')" @click="goLive">
        <span class="wt-clock-time">{{ clock.time }}<i>Z</i><b v-if="tense !== 'live' && engaged" class="wt-clock-ago">{{ clock.ago }}</b></span>
        <span class="wt-clock-sub">
          <template v-if="tense === 'live'"><b class="wt-dot"></b>LIVE · </template>{{ clock.date.slice(0, 6) }}<template v-if="engaged"> · {{ clock.local }}</template>
        </span>
      </button>

      <div class="wt-shuttle">
        <button type="button" class="wt-key" :class="{ 'is-on': direction < 0 }" :aria-label="t('Rewind')" title="Rewind · hold, or J" @pointerdown="holdStart(-1, $event)" @pointerup="holdEnd" @pointercancel="holdEnd">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11L2.5 10zM17.5 4.5v11L10 10z" /></svg>
        </button>
        <button type="button" class="wt-key wt-key--play" :aria-label="direction !== 0 ? t('Pause') : t('Play')" title="Play or pause · K" @click="togglePlay">
          <svg v-if="direction !== 0" viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 4h3v12h-3zM11.5 4h3v12h-3z" /></svg>
          <svg v-else viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4l10 6-10 6z" /></svg>
        </button>
        <button type="button" class="wt-key wt-key--fwd" :class="{ 'is-on': direction > 0 }" :disabled="time.live" :aria-label="t('Fast forward')" title="Forward · hold, or L" @pointerdown="holdStart(1, $event)" @pointerup="holdEnd" @pointercancel="holdEnd">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11l7.5-5.5zM2.5 4.5v11L10 10z" /></svg>
        </button>
        <button type="button" class="wt-speed" :class="{ 'is-auto': !speedPinned }" title="Speed · click for the next, shift-click for the one before" @click="faster($event.shiftKey ? -1 : 1)" @contextmenu.prevent="faster(-1)">{{ speedLabel }}</button>
      </div>

      <!-- The track: a window of time, its ruler, where there is data, the marks and the handle. -->
      <div
        ref="trackEl"
        class="wt-track"
        role="slider"
        tabindex="0"
        :aria-label="t('World time')"
        :aria-valuetext="`${clock.date} ${clock.time} UTC`"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
        @pointerleave="hover = null"
        @wheel="onWheel"
        @dblclick="setWindow('24H')"
        @keydown.left.prevent="step(-1)"
        @keydown.right.prevent="step(1)"
      >
        <span v-if="nowPct < 100" class="wt-ahead" :style="{ left: `${clampPct(nowPct)}%` }"></span>
        <span v-for="tick in ruler" :key="tick.ms" class="wt-tick" :class="{ 'is-major': tick.major, 'is-midnight': tick.midnight }" :style="{ left: `${tick.left}%` }"
          ><em v-if="tick.label">{{ tick.label }}</em></span
        >
        <span class="wt-strip">
          <span v-for="(part, index) in strip" :key="index" class="wt-strip-part" :class="{ 'is-all': part.all, 'is-future': part.future }" :style="{ left: `${part.left}%`, width: `${part.width}%` }" :title="part.title"></span>
        </span>
        <span v-if="journeyBar" class="wt-journey" :style="{ left: `${journeyBar.left}%`, width: `${journeyBar.width}%` }"></span>
        <span v-if="journeyBar?.startShown" class="wt-journey-start" :style="{ left: `${journeyBar.startLeft}%` }"></span>
        <span v-for="mark in marks" :key="`${mark.time}${mark.label}`" class="wt-mark" :style="{ left: `${mark.left}%` }"></span>
        <span v-if="nowPct >= 0 && nowPct <= 100" class="wt-now" :style="{ left: `${nowPct}%` }"><em>NOW</em></span>
        <span v-if="hover && !dragging" class="wt-hover" :style="{ left: `${hover.pct}%` }"
          ><em>{{ hover.label ? `${hover.label} · ` : '' }}{{ day(hover.ms) }} {{ hhmm(hover.ms) }}Z</em></span
        >
        <span v-if="headPct >= 0 && headPct <= 100" class="wt-head" :style="{ left: `${headPct}%` }"><i></i></span>
        <span v-if="time.buffering" class="wt-wait" :style="{ left: `${clampPct(headPct)}%` }"></span>
      </div>

      <button v-if="gap && engaged" type="button" class="wt-gap" :disabled="gap.nearest === null" @click="seekTo(gap.nearest)">
        <span>{{ gap.text }}</span><b v-if="gap.label">{{ gap.label }} ›</b>
      </button>

      <div ref="rightEl" class="wt-right">
        <div v-if="journey" class="wt-subject">
          <span class="wt-subject-name">{{ journey.callsign || journey.title }}</span>
          <button type="button" title="Go to where it was first seen" @click="toJourneyStart">|◀ START</button>
          <button type="button" title="Fit the track to its journey" @click="fitJourney">FIT</button>
        </div>
        <div class="wt-windows" role="group" :aria-label="t('Time shown')">
          <button v-for="each in WINDOWS" :key="each.key" type="button" :class="{ 'is-on': windowKey === each.key }" @click="setWindow(each.key)">{{ each.key }}</button>
        </div>
        <button type="button" class="wt-key wt-key--lanes" :class="{ 'is-on': lanesOpen }" :aria-pressed="lanesOpen" :aria-label="t('Layers on the timeline')" title="Show each layer's data" @click="lanesOpen = !lanesOpen">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14v1.6H3zM3 9.2h9v1.6H3zM3 13.4h12v1.6H3z" /></svg>
        </button>
        <button type="button" class="wt-live" :class="{ 'is-live': time.live }" :disabled="time.live" :title="time.live ? 'Live' : 'Back to live · \\'" @click="goLive"><b class="wt-dot"></b>LIVE</button>
      </div>
    </div>
  </div>
</template>
