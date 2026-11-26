<script setup>
// PROTOTYPE of the world timeline's design, pass 2 (not for merging as is).
//
// The command dock never moves. Time stacks upward from it: the controls sit
// in the dock's own row (either side of it where there is room, a row above
// it where there is not), the track above them, the layers' lanes above that.
// A phone gets a row at rest and a sheet when time is touched.
//
// `?tl=` picks a variant: `deck` (the default), `under` (pass 1's bar under
// the dock) and `tape` (the time shown stays put and the time slides under it,
// which is also what a phone gets).
import {
  computed,
  nextTick,
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
import { journeyMoments } from '../../../time/journeyMoments.js';
import { createSoftFollow } from '../../../time/softFollow.js';
import {
  recordedJourney,
  setRecordedSubject,
  viewJourneyAt,
} from '../../../proto/recordedFlights.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const store = useWorldTimeStore();
const { time } = storeToRefs(store);
const cards = useEntityCardStore();

// Rendered on a server too (Core's tests): no window there.
const win0 = globalThis.window;
const query = new URLSearchParams(win0?.location?.search ?? '');
const variant = ['deck', 'under', 'tape'].includes(query.get('tl'))
  ? query.get('tl')
  : 'deck';

// ── What each layer's time is made of ───────────────────────────────────
// observed: positions a sensor reported. frames: pictures at a cadence.
// computed: worked out from orbital elements, not seen. events: moments.
const LANES = {
  flights: { label: 'FLIGHTS', kind: 'observed', order: 1, source: 'ADS-B positions' },
  military: { label: 'MILITARY', kind: 'observed', order: 2, source: 'ADS-B positions' },
  vessels: { label: 'VESSELS', kind: 'observed', order: 3, source: 'AIS positions' },
  'weather-radar': { label: 'RAIN RADAR', kind: 'frames', order: 4, source: 'Radar mosaics' },
  'weather-satellite': { label: 'CLOUDS', kind: 'frames', order: 5, source: 'Geostationary imagery' },
  'weather-lightning': { label: 'LIGHTNING', kind: 'frames', order: 6, source: 'Lightning mapper' },
  satellites: { label: 'SATELLITES', kind: 'computed', order: 7, source: 'Orbital elements' },
  earthquakes: { label: 'QUAKES', kind: 'events', order: 8, source: 'Seismic catalogue' },
  'gnss-integrity': { label: 'GPS JAMMING', kind: 'frames', order: 6.5, source: 'Aircraft navigation integrity, 6-hour windows' },
  'local-firms': { label: 'FIRES', kind: 'frames', order: 6.6, source: 'Satellite fire detections, hourly' },
  firms: { label: 'FIRES', kind: 'frames', order: 6.6, source: 'Satellite fire detections, hourly' },
  wind: { label: 'WIND', kind: 'frames', order: 6.7, source: 'Model runs, hourly steps' },
  'weather-cyclones': { label: 'CYCLONES', kind: 'events', order: 6.8, source: 'Advisories' },
  'ais-live-vessels': { label: 'VESSELS', kind: 'observed', order: 3, source: 'AIS positions' },
  'rocket-launches': { label: 'LAUNCHES', kind: 'events', order: 9, source: 'Launch schedule' },
};
const KINDS = {
  observed: 'Observed: positions a sensor reported',
  frames: 'Observed: one picture per tick',
  computed: 'Computed from orbits, not observed',
  events: 'Events: each mark is a moment',
};
const laneOf = (id) =>
  LANES[id] ?? {
    label: id.replace(/^weather-/, '').replaceAll('-', ' ').toUpperCase(),
    kind: 'observed',
    order: 20,
    source: '',
  };
// How far back the hosted archive is planned to reach for each layer. This
// build has not loaded it: the lanes draw it hollow, and say so.
const ARCHIVE = {
  flights: Date.UTC(2026, 5, 17),
  military: Date.UTC(2026, 5, 17),
  vessels: Date.UTC(2026, 5, 17),
  'weather-radar': Date.UTC(2020, 9, 14),
  'weather-satellite': Date.UTC(2026, 7, 9),
  'weather-lightning': () => Date.now() - 21 * DAY,
};
// The planned archive depths were the prototype's stand-in; a host reports real
// coverage, so they show only when asked for (`?archive=1`).
const showArchive = query.get('archive') === '1';
const archiveOf = (id) => {
  if (!showArchive) return null;
  const from = ARCHIVE[id];
  return typeof from === 'function' ? from() : (from ?? null);
};

// ── Speeds, in world time per real second ───────────────────────────────
const SPEEDS = [
  { rate: 1, label: '1×', name: 'Real time' },
  // Watching one aircraft land or one ship berth: fast enough to get there,
  // slow enough to see it happen.
  { rate: 10, label: '10×', name: 'Ten times real time' },
  { rate: 60, label: '1 MIN/S', name: '1 minute a second' },
  { rate: 300, label: '5 MIN/S', name: '5 minutes a second' },
  { rate: 900, label: '15 MIN/S', name: '15 minutes a second' },
  { rate: 3600, label: '1 H/S', name: '1 hour a second' },
  { rate: 21600, label: '6 H/S', name: '6 hours a second' },
  { rate: 86400, label: '1 D/S', name: '1 day a second' },
  { rate: 604800, label: '1 WK/S', name: '1 week a second' },
  { rate: 2592000, label: '1 MO/S', name: '1 month a second' },
];
// The speed that plays a stretch through in about a minute.
const autoSpeed = (length) => {
  const want = Math.log(length / 60_000);
  let best = 0;
  for (let index = 1; index < SPEEDS.length; index += 1)
    if (
      Math.abs(Math.log(SPEEDS[index].rate) - want) <
      Math.abs(Math.log(SPEEDS[best].rate) - want) - 1e-9
    )
      best = index;
  return best;
};
const RANGES = [
  { key: '1H', name: 'An hour', length: HOUR },
  { key: '1D', name: 'A day', length: DAY },
  { key: '1W', name: 'A week', length: 7 * DAY },
  { key: '1M', name: 'A month', length: 30 * DAY },
  { key: '1Y', name: 'A year', length: 365 * DAY },
];
const MIN_LENGTH = 10 * MIN;

const speedIndex = ref(autoSpeed(DAY));
const speedPinned = ref(false);
const speed = computed(() => SPEEDS[speedIndex.value]);
// -1 rewinding, 0 still, 1 playing on.
const direction = ref(0);
// The window: `length` long, ending at `end`, or at now while `end` is null.
const win = shallowRef({ length: DAY, end: null });
const lanesOpen = ref(false);
const touched = ref(false);
const menu = ref(null);
const laneMenu = ref(null);
const hover = shallowRef(null);
const trackEl = ref(null);
const trackW = ref(600);

const nowMs = () => worldClock.wallNow();
const past = computed(() => !time.value.live && time.value.timeMs < nowMs() - 5000);
const future = computed(() => !time.value.live && time.value.timeMs > nowMs() + 5000);
const tense = computed(() => (future.value ? 'future' : past.value ? 'past' : 'live'));

// ── The page: where the dock is, how much room there is ─────────────────
const media = (q) => Boolean(win0?.matchMedia?.(q).matches);
const vw = ref(win0?.innerWidth ?? 1440);
const vh = ref(win0?.innerHeight ?? 900);
const coarse = ref(media('(pointer: coarse)'));
const phone = ref(media('(max-width: 720px)'));
const dock = shallowRef(null);
function measure() {
  vw.value = window.innerWidth;
  vh.value = window.innerHeight;
  coarse.value = window.matchMedia('(pointer: coarse)').matches;
  phone.value = window.matchMedia('(max-width: 720px)').matches;
  const el = globalThis.document?.getElementById('command-dock');
  const box = el?.getBoundingClientRect();
  dock.value =
    box && box.width > 0
      ? { width: box.width, height: box.height, bottom: window.innerHeight - box.bottom }
      : null;
}
const width = computed(() => Math.min(1180, vw.value - 48));
const layout = computed(() => {
  if (phone.value) return 'phone';
  if (variant === 'under') return 'under';
  const need = coarse.value ? 392 : 344;
  if (dock.value && (width.value - dock.value.width - 24) / 2 >= need) return 'flank';
  return 'stack';
});
const tape = computed(() => variant === 'tape' || layout.value === 'phone');
// Where the time shown sits on a tape: most of the track is the past.
const HEAD = 0.72;

// ── The window on the track ─────────────────────────────────────────────
const view = computed(() => {
  // Read the time so a window pinned to now moves on with it.
  const at = time.value.timeMs;
  const length = win.value.length;
  if (tape.value) {
    const start = at - length * HEAD;
    return { start, end: start + length };
  }
  const end = win.value.end ?? nowMs() + length * 0.04;
  return { start: end - length, end };
});
const place = (ms) =>
  ((ms - view.value.start) / (view.value.end - view.value.start)) * 100;
const clampPct = (pct) => Math.min(100, Math.max(0, pct));
const timeAt = (clientX) => {
  const { left, width: wide } = trackEl.value.getBoundingClientRect();
  const share = wide > 0 ? (clientX - left) / wide : 1;
  return view.value.start + Math.min(1, Math.max(0, share)) * win.value.length;
};
function pinSpeed() {
  if (!speedPinned.value) speedIndex.value = autoSpeed(win.value.length);
  applyRate();
}
function setLength(length, anchorMs, share) {
  const next = Math.min(maxLength.value, Math.max(MIN_LENGTH, length));
  const end = anchorMs + (1 - share) * next;
  win.value = { length: next, end: end >= nowMs() + next * 0.04 && !future.value ? null : end };
  pinSpeed();
}
function setRange(key) {
  menu.value = null;
  touched.value = true;
  let length = RANGES.find((each) => each.key === key)?.length;
  if (key === 'ALL') length = maxLength.value;
  const at = time.value.timeMs;
  if (key === 'FIT' && journey.value) {
    // The flight around the time shown (an airframe's day holds several),
    // with a margin either side; pinned to now while it is still flying.
    const leg = legAt(time.value.live ? nowMs() : at);
    const span = Math.max(20 * MIN, leg.to - leg.from);
    length = Math.min(maxLength.value, span * 1.25);
    const end = leg.to + span * 0.1;
    win.value = { length, end: end >= nowMs() - MIN ? null : end };
    pinSpeed();
    return;
  }
  // Pinned to now while the time shown is within the window's reach of now.
  const pinned = time.value.live || nowMs() - at < length * 0.9;
  win.value = { length, end: pinned ? null : at + length * 0.3 };
  pinSpeed();
}
// Keep the time shown on the track: it pages on as play reaches an edge.
function keepInView(ms) {
  if (tape.value) return;
  const { start, end } = view.value;
  const length = win.value.length;
  if (ms >= start + length * 0.02 && ms <= end) return;
  const nextEnd = ms < start + length * 0.02 ? ms + length * 0.8 : ms + length * 0.2;
  // Past now (what orbits and forecasts predict) the track follows the time there.
  const ahead = ms > nowMs() + length * 0.04;
  win.value = { length, end: nextEnd >= nowMs() && !ahead ? null : nextEnd };
}
function zoomAround(ms, factor) {
  const share = tape.value ? HEAD : (ms - view.value.start) / win.value.length;
  setLength(win.value.length * factor, ms, share);
}
// The − and + keys: around the time shown when it is on the track.
function zoomBy(factor) {
  touched.value = true;
  const at = time.value.timeMs;
  const { start, end } = view.value;
  zoomAround(at >= start && at <= end ? at : (start + end) / 2, factor);
}
function pan(ms) {
  const end = view.value.end + ms;
  win.value = {
    length: win.value.length,
    end: end >= nowMs() + win.value.length * 0.04 && !hasFuture.value ? null : end,
  };
}
const spanLabel = (length) => {
  const preset = RANGES.find((each) => Math.abs(each.length - length) < each.length * 0.01);
  if (preset) return preset.key;
  if (Math.abs(length - maxLength.value) < length * 0.01 && length > 60 * DAY) return 'ALL';
  if (length < HOUR) return `${Math.round(length / MIN)}MIN`;
  if (length < 2 * DAY) return `${Math.round(length / HOUR)}H`;
  if (length < 60 * DAY) return `${Math.round(length / DAY)}D`;
  if (length < 700 * DAY) return `${Math.round(length / (30.4 * DAY))}MO`;
  return `${(length / (365.25 * DAY)).toFixed(1)}Y`;
};
const rangeLabel = computed(() => spanLabel(win.value.length));
// At rest the bar says what its strip is, in words.
const restLabel = computed(() => {
  if (subject.value) return `REPLAY ${subject.value.title} · ${spanLabel(nowMs() - subject.value.start)}`;
  const preset = RANGES.find((each) => each.key === rangeLabel.value);
  return preset ? `REPLAY THE LAST ${preset.name.replace(/^An? /, '').toUpperCase()}` : `REPLAY THE LAST ${rangeLabel.value}`;
});

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
      const archive = archiveOf(source.id);
      return {
        ...source,
        ...lane,
        end,
        spacing,
        archive: archive !== null && archive < source.start ? archive : null,
      };
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
const observed = computed(() => {
  const list = spans.value.filter((source) => source.kind !== 'computed');
  return list.length ? list : spans.value;
});
// As far back as anything on reaches, loaded or in the archive.
const floor = computed(() => {
  const list = observed.value.map((source) => source.archive ?? source.start);
  return list.length ? Math.min(...list) : nowMs() - 30 * DAY;
});
const maxAgo = computed(() => Math.max(30 * DAY, nowMs() - floor.value));
const maxLength = computed(() => maxAgo.value * 1.08);
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
    });
  }
  return out;
});
// The archive under the strip: where the hosted archive has the layers on.
const stripArchive = computed(() => {
  const list = spans.value.filter((source) => source.archive !== null);
  if (!list.length) return null;
  const { start, end } = view.value;
  const from = Math.max(start, Math.min(...list.map((source) => source.archive)));
  const to = Math.min(end, Math.max(...list.map((source) => source.start)));
  return to > from ? { left: place(from), width: place(to) - place(from) } : null;
});
const lanes = computed(() =>
  sources.value.map((source) => {
    const { start, end } = view.value;
    const from = Math.max(source.start, start);
    const to = Math.min(source.end, end);
    const pxPerMs = trackW.value / win.value.length;
    const at = time.value.timeMs;
    const missing = source.kind !== 'events' && (at < source.start || at > source.end);
    const archived = missing && source.archive !== null && at >= source.archive && at < source.start;
    const hollowTo = Math.min(source.start, end);
    const hollowFrom = Math.max(source.archive ?? Infinity, start);
    return {
      ...source,
      shown: to > from,
      left: place(from),
      width: place(to) - place(from),
      hollow:
        source.archive !== null && hollowTo > hollowFrom
          ? { left: place(hollowFrom), width: place(hollowTo) - place(hollowFrom) }
          : null,
      frames:
        source.spacing * pxPerMs >= 4
          ? (source.frames ?? []).filter((ms) => ms >= start && ms <= end).map((ms) => place(ms))
          : [],
      marks: (source.marks ?? [])
        .map((mark) => (typeof mark === 'number' ? mark : mark?.time))
        .filter((ms) => ms >= start && ms <= end)
        .map((ms) => place(ms)),
      missing,
      archived,
    };
  }),
);
// What a lane's name opens: what the layer is made of and what it shows now.
const laneInfo = computed(() => {
  const lane = lanes.value.find((each) => each.id === laneMenu.value);
  if (!lane) return null;
  const at = time.value.timeMs;
  const rows = [KINDS[lane.kind]];
  if (lane.source) rows.push(`Source: ${lane.source}`);
  const count = (lane.marks ?? []).length;
  if (lane.kind === 'events') rows.push(`${count} on the track`);
  else {
    rows.push(`Loaded from ${stamp(lane.start)}`);
    if (lane.spacing) rows.push(`A picture every ${Math.round(lane.spacing / MIN)} min`);
    if (lane.kind === 'frames' && !lane.missing && lane.frames) {
      const frame = (sources.value.find((each) => each.id === lane.id)?.frames ?? []).findLast(
        (ms) => ms <= at,
      );
      if (frame) rows.push(`Showing the ${clockOf(frame)} picture`);
    }
    if (lane.archive !== null)
      rows.push(`Hosted archive from ${dateOf(lane.archive)} (hollow bar): not loaded in this build`);
  }
  const nearest = lane.missing ? Math.min(Math.min(lane.end, nowMs()), Math.max(lane.start, at)) : null;
  return { ...lane, rows, nearest };
});
// What the bar says when the time shown has no data for a layer that is on:
// which layers, and the nearest time that has them all, one press away.
const gap = computed(() => {
  if (time.value.live) return null;
  const at = time.value.timeMs;
  const list = spans.value;
  const missing = list.filter((source) => at < source.start || at > source.end);
  // The thing selected has a first sighting: before it there is nothing of it to show.
  if (subject.value && at < subject.value.start - 30_000)
    return {
      text: `${subject.value.title} WAS NOT SEEN BEFORE ${stamp(subject.value.start)}`,
      nearest: subject.value.start + 1000,
      label: 'GO TO ITS FIRST SIGHTING',
    };
  const dark = subjectGapAt(at);
  if (dark?.parked)
    return {
      text: `${subject.value.title} ON THE GROUND ${stamp(dark.from)} – ${stamp(dark.to)}, NOT TRANSMITTING`,
      nearest: direction.value < 0 ? dark.from - 1000 : dark.to + 1000,
      label: direction.value < 0 ? 'BACK TO WHEN IT LANDED' : 'SKIP TO ITS NEXT FLIGHT',
    };
  if (dark)
    return {
      text: `${subject.value.title}: NO POSITIONS ${stamp(dark.from)} – ${stamp(dark.to)}, OUT OF RECEIVER RANGE`,
      nearest: direction.value < 0 ? dark.from - 1000 : dark.to + 1000,
      label: direction.value < 0 ? 'BACK TO ITS LAST POSITION' : 'SKIP TO WHERE IT IS SEEN AGAIN',
    };
  if (!missing.length) return null;
  if (at > nowMs() + 5000)
    return {
      text: `${missing.map((source) => source.label).join(', ')}: OBSERVED ONLY, NOTHING OF IT PAST NOW`,
      nearest: null,
      label: '',
    };
  const from = Math.max(...list.map((source) => source.start));
  const to = Math.min(...list.map((source) => source.end), nowMs());
  const nearest = from <= to ? Math.min(to, Math.max(from, at)) : null;
  const names = missing.map((source) => source.label).join(', ');
  const archived = missing.every(
    (source) => source.archive !== null && at >= source.archive && at < source.start,
  );
  return {
    text: archived
      ? `${names}: IN THE HOSTED ARCHIVE HERE, NOT LOADED IN THIS BUILD`
      : missing.length === list.length
        ? 'NOTHING RECORDED AT THIS TIME'
        : `NO ${names} AT THIS TIME`,
    nearest,
    label: nearest === null ? '' : `GO TO ${stamp(nearest)}`,
  };
});
const marks = computed(() => {
  const { start, end } = view.value;
  return (time.value.span?.markDetails ?? [])
    .filter((mark) => mark.time >= start && mark.time <= end)
    .map((mark) => ({ ...mark, left: place(mark.time) }));
});

// ── Saying a time ───────────────────────────────────────────────────────
// Local time first, as the person's own clock says it; UTC beside it.
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const two = (n) => String(n).padStart(2, '0');
const hourFormat = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
const secondFormat = new Intl.DateTimeFormat([], {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
});
const clockOf = (ms) => hourFormat.format(ms).toUpperCase().replace(':00', '');
const utcOf = (ms) => {
  const d = new Date(ms);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}Z`;
};
const dayOf = (ms) => {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};
const dateOf = (ms) => {
  const d = new Date(ms);
  const year = d.getFullYear() === new Date(nowMs()).getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${dayOf(ms)}${year}`;
};
const stamp = (ms) =>
  new Date(ms).toDateString() === new Date(nowMs()).toDateString()
    ? clockOf(ms)
    : `${dateOf(ms)}, ${clockOf(ms)}`;

// ── The ruler ───────────────────────────────────────────────────────────
const STEPS = [MIN, 5 * MIN, 15 * MIN, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR];
const MINORS = { [MIN]: 4, [5 * MIN]: 5, [15 * MIN]: 3, [HOUR]: 4, [3 * HOUR]: 3, [6 * HOUR]: 6, [12 * HOUR]: 4 };
const ruler = computed(() => {
  const { start, end } = view.value;
  const want = (win.value.length / Math.max(1, trackW.value)) * (coarse.value ? 112 : 96);
  const ticks = [];
  const fixed = STEPS.find((each) => each >= want);
  if (fixed) {
    // Whole steps of the person's own clock, not of UTC's.
    const offset = new Date(start).getTimezoneOffset() * MIN;
    const minor = fixed / MINORS[fixed];
    for (let ms = Math.ceil((start - offset) / minor) * minor + offset; ms <= end; ms += minor) {
      const local = ms - offset;
      const major = local % fixed === 0;
      const midnight = local % DAY === 0;
      ticks.push({
        ms,
        left: place(ms),
        major,
        midnight,
        label: major ? (midnight ? dayOf(ms) : clockOf(ms)) : '',
      });
    }
    return ticks;
  }
  const days = want / DAY;
  const from = new Date(start);
  if (days <= 14) {
    const every = days <= 1 ? 1 : days <= 2 ? 2 : days <= 7 ? 7 : 14;
    const each = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    const minors = (DAY / win.value.length) * trackW.value >= 5;
    for (; each.getTime() <= end; each.setDate(each.getDate() + 1)) {
      const ms = each.getTime();
      const count = Math.round((ms - each.getTimezoneOffset() * MIN) / DAY);
      const major = count % every === 0;
      if (ms < start || (!major && !minors)) continue;
      ticks.push({ ms, left: place(ms), major, midnight: major, label: major ? dayOf(ms) : '' });
    }
    return ticks;
  }
  if (days <= 183) {
    const every = days <= 31 ? 1 : days <= 92 ? 3 : 6;
    const each = new Date(from.getFullYear(), from.getMonth(), 1);
    for (; each.getTime() <= end; each.setMonth(each.getMonth() + 1)) {
      const ms = each.getTime();
      const major = each.getMonth() % every === 0;
      if (ms < start) continue;
      ticks.push({
        ms,
        left: place(ms),
        major,
        midnight: major,
        label: major ? (each.getMonth() === 0 ? String(each.getFullYear()) : MONTHS[each.getMonth()]) : '',
      });
    }
    return ticks;
  }
  const every = days <= 366 ? 1 : days <= 732 ? 2 : 5;
  const each = new Date(from.getFullYear(), 0, 1);
  for (; each.getTime() <= end; each.setFullYear(each.getFullYear() + 1)) {
    const ms = each.getTime();
    const major = each.getFullYear() % every === 0;
    if (ms < start) continue;
    ticks.push({ ms, left: place(ms), major, midnight: major, label: major ? String(each.getFullYear()) : '' });
  }
  return ticks;
});

// ── How far back: the whole reach of the layers on, on one short strip ──
// A day and a decade both have to fit, so the strip counts back from now in
// ratios: each labelled step is as wide as the one before it.
const NEAR = 10 * MIN;
const reachAt = (ms) => {
  const ago = Math.min(maxAgo.value, Math.max(NEAR, nowMs() - ms));
  return (1 - Math.log(ago / NEAR) / Math.log(maxAgo.value / NEAR)) * 100;
};
const reach = computed(() => {
  void time.value.timeMs;
  const now = nowMs();
  const steps = [
    ['1H', HOUR],
    ['1D', DAY],
    ['1W', 7 * DAY],
    ['1M', 30 * DAY],
    ['1Y', 365 * DAY],
    ['5Y', 5 * 365 * DAY],
  ];
  const loaded = Math.min(...observed.value.map((source) => source.start), now);
  const left = reachAt(view.value.start);
  const right = reachAt(Math.min(view.value.end, now));
  return {
    ticks: steps
      .filter(([, ago]) => ago < maxAgo.value * 0.92)
      .map(([label, ago]) => ({ label, left: reachAt(now - ago) })),
    loaded: reachAt(loaded),
    archive: showArchive && floor.value < loaded ? reachAt(floor.value) : null,
    window: { left, width: Math.max(1.2, right - left) },
    head: reachAt(time.value.timeMs),
    from: dateOf(floor.value),
  };
});
const reachEl = ref(null);
let reaching = false;
function reachTo(event) {
  const { left, width: wide } = reachEl.value.getBoundingClientRect();
  const share = Math.min(1, Math.max(0, (event.clientX - left) / wide));
  if (share > 0.985) return goLive(true);
  const ago = NEAR * (maxAgo.value / NEAR) ** (1 - share);
  seekTo(nowMs() - ago);
}
function reachDown(event) {
  reaching = true;
  touched.value = true;
  event.currentTarget.setPointerCapture?.(event.pointerId);
  reachTo(event);
}
const reachMove = (event) => reaching && reachTo(event);
const reachUp = () => (reaching = false);

// ── The clock ───────────────────────────────────────────────────────────
const clock = computed(() => {
  const ms = time.value.timeMs;
  const d = new Date(ms);
  const parts = Object.fromEntries(
    secondFormat.formatToParts(ms).map((part) => [part.type, part.value]),
  );
  const offset = ms - nowMs();
  const abs = Math.abs(offset);
  let ago = '';
  if (abs >= 5000) {
    if (abs < HOUR) ago = `${Math.floor(abs / MIN)}M ${two(Math.floor((abs % MIN) / 1000))}S`;
    else if (abs < 2 * DAY) ago = `${Math.floor(abs / HOUR)}H ${two(Math.floor((abs % HOUR) / MIN))}M`;
    else if (abs < 60 * DAY) ago = `${Math.floor(abs / DAY)}D ${Math.floor((abs % DAY) / HOUR)}H`;
    else if (abs < 730 * DAY) ago = `${Math.floor(abs / (30.44 * DAY))} MO`;
    else ago = `${(abs / (365.25 * DAY)).toFixed(1)} Y`;
  }
  return {
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    zone: `${parts.dayPeriod ?? ''} ${parts.timeZoneName ?? ''}`.trim().toUpperCase(),
    date: `${DAYS[d.getDay()]} ${dateOf(ms)}`,
    utc: utcOf(ms),
    ago: ago ? `${offset < 0 ? '−' : '+'}${ago}` : '',
    spoken: `${d.toLocaleString()} ${tense.value === 'live' ? 'live' : tense.value === 'past' ? 'replay' : 'predicted'}`,
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
// A replay that has caught up with the present is live again. A layer's last
// frame can hold the cursor a little short of now, so it counts as arrived
// once it stops moving within sight of it.
let heldAt = 0;
let heldSince = 0;
function arrive() {
  if (direction.value <= 0 || !startedBeforeNow || time.value.live) return;
  const ms = worldClock.now();
  if (ms !== heldAt) {
    heldAt = ms;
    heldSince = performance.now();
    return;
  }
  const behind = nowMs() - ms;
  const near = behind < MIN || (!time.value.buffering && behind < 15 * MIN);
  if (near && performance.now() - heldSince > 1400) goLive(true);
}
// Rewind runs out where the loaded data of the observed layers does.
const earliest = () =>
  observed.value.length
    ? Math.min(...observed.value.map((source) => source.start))
    : (time.value.span?.start ?? nowMs());
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
function rewindFrame(at) {
  frame = requestAnimationFrame(rewindFrame);
  const elapsed = Math.min(1000, at - lastFrame);
  lastFrame = at;
  const stop = earliest();
  const next = worldClock.now() - elapsed * speed.value.rate;
  if (next <= stop) {
    worldClock.seek(stop);
    still();
    return;
  }
  worldClock.seek(next);
}
function run(next) {
  if (next === 0) return still();
  stopRewind();
  touched.value = true;
  direction.value = next;
  if (next < 0) {
    if (worldClock.isPlaying()) worldClock.pause();
    if (worldClock.isLive()) worldClock.seek(nowMs() - 1000);
    lastFrame = performance.now();
    frame = requestAnimationFrame(rewindFrame);
    return;
  }
  if (worldClock.isLive()) {
    if (!hasFuture.value) return still();
    worldClock.seek(nowMs() + 6000);
  }
  startedBeforeNow = worldClock.now() < nowMs();
  applyRate();
  worldClock.play({ continuous: true });
}
function setSpeed(index) {
  menu.value = null;
  if (index === null) {
    speedPinned.value = false;
    speedIndex.value = autoSpeed(win.value.length);
  } else {
    speedPinned.value = true;
    speedIndex.value = index;
  }
  baseSpeed = null;
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
// The middle key says what the world is doing. Live, the world is running, so
// it pauses: the moment holds. Held in the past, it plays on from there. It
// never runs backward; that is the rewind key's.
function togglePlay() {
  if (direction.value !== 0) return still();
  if (time.value.live) {
    touched.value = true;
    worldClock.seek(nowMs() - 1000);
    return;
  }
  run(1);
}
// Play what the track shows from its start: the last day's weather, or the
// whole of a selected flight, in one press.
function replaySpan() {
  menu.value = null;
  touched.value = true;
  still();
  const from = Math.max(view.value.start, subject.value ? subject.value.start : earliest()) + 1000;
  if (from >= nowMs() - 5000) return;
  worldClock.seek(from);
  run(1);
}
function goLive(stay = false) {
  still();
  menu.value = null;
  if (stay !== true) {
    touched.value = false;
    lanesOpen.value = false;
  }
  store.goLive();
  win.value = { length: win.value.length, end: null };
}
// Play that reaches now goes live there; it does not run on into what the
// satellites' orbits predict unless it started there.
watch(
  () => time.value.timeMs,
  (ms) => {
    if (direction.value > 0 && startedBeforeNow && ms >= nowMs() - 500) goLive(true);
    // Whatever moved it (play, a date jump, a link, a search answer), the
    // time shown stays on the track, unless a finger or the pointer holds it.
    if (pointers.size === 0) keepInView(ms);
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
  menu.value = null;
  holdAt = performance.now();
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
// The keyboard's press of a held key: it latches.
function holdKey(way, event) {
  if (event.detail === 0) shuttle(way);
}

// ── Stepping ────────────────────────────────────────────────────────────
// A step is the finest frame of the layers on (radar's ten minutes), or with
// none, a two-hundredth of the window rounded to something a person says.
const stepMs = computed(() => {
  let finest = Infinity;
  for (const source of sources.value) if (source.spacing) finest = Math.min(finest, source.spacing);
  const fine = Number.isFinite(finest) ? Math.max(MIN, Math.round(finest / MIN) * MIN) : 0;
  const coarseStep = [...STEPS, DAY, 7 * DAY, 30 * DAY].find((each) => each >= win.value.length / 200) ?? 30 * DAY;
  return Math.max(fine, coarseStep);
});
function seekTo(ms) {
  still();
  menu.value = null;
  touched.value = true;
  store.scrub(Math.min(ms, hasFuture.value ? Infinity : nowMs()), win.value.length);
  keepInView(ms);
}
const step = (way) => seekTo(time.value.timeMs + way * stepMs.value);

// ── The thing selected, and the moments worth a pin ─────────────────────
// Selecting an aircraft gives the track its journey: the stretch it was
// observed over and the moments of it. An answer to a question puts its
// moments on the same pins.
const journey = shallowRef(null);
const answer = shallowRef(null);
const dismissed = ref(null);
const selected = computed(() => {
  const card = cards.card;
  if (!card) return null;
  const id = card.id ?? card.identity?.id ?? card.reference;
  return id
    ? {
        id: String(id),
        layerId: card.layerId ?? card.identity?.layerId ?? null,
        title: card.title ?? card.name ?? String(id),
      }
    : null;
});
// The selected contact's layer, when its source can read that one contact at
// any time (Hosted's archives): its journey, and a focus that keeps it in
// every snapshot wherever the view is. Else the prototype's recording.
// Stretches of a journey with no position: an aircraft past receiver range
// over an ocean, a vessel out of AIS reach. The timeline names them instead
// of showing an empty sky, and a replay steps over them.
const GAP_MS = { vessels: 3 * HOUR, 'ais-live-vessels': 3 * HOUR };
// An aircraft quiet on the ground (parked at a gate between flights) is not
// out of range: it is told apart by the fixes either side being on the ground.
const grounded = (fix) => !Number.isFinite(fix[3]) || fix[3] <= 30;
function journeyGaps(path, layerId) {
  const limit = GAP_MS[layerId] ?? 10 * MIN;
  const vessel = /vessel/.test(layerId ?? '');
  const gaps = [];
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1][0] * 1000;
    const to = path[index][0] * 1000;
    if (to - from > limit)
      gaps.push({
        from,
        to,
        parked: !vessel && grounded(path[index - 1]) && grounded(path[index]),
      });
  }
  return gaps;
}
let focused = null;
function focusSubject(next) {
  if (focused && focused.layer !== next?.layer) focused.layer.focusOn?.(null);
  focused = next;
  next?.layer.focusOn?.(next.id);
}
// A satellite is computed at any time from its orbit: its journey is the
// timeline's reach either side of now, and its flight is one orbit around the
// time shown, worked out from its height (a circular orbit's period).
const EARTH_MU = 3.986004418e14;
const EARTH_R = 6_371_000;
function orbitJourney(pick, layer) {
  const info = layer?.getTrackedInfo?.();
  const height = Number(info?.altitudeM ?? cards.card?.altitudeM);
  const radius = EARTH_R + (Number.isFinite(height) && height > 0 ? height : 500_000);
  const period = Math.min(DAY, 2 * Math.PI * Math.sqrt(radius ** 3 / EARTH_MU) * 1000);
  const now = nowMs();
  return {
    start: now - 14 * DAY,
    end: now + 14 * DAY,
    readFrom: now - 14 * DAY,
    readTo: now + 14 * DAY,
    callsign: '',
    period,
    computed: true,
    path: null,
    gaps: [],
    moments: [],
  };
}
async function readJourney(pick) {
  const layer = pick.layerId ? cards.layerModule(pick.layerId) : null;
  if (pick.layerId === 'satellites') {
    focusSubject(null);
    return orbitJourney(pick, layer);
  }
  if (typeof layer?.journeyOf === 'function') {
    focusSubject({ layer, id: pick.id });
    try {
      // Around the time shown: a plane picked while looking at last week
      // has last week's journey.
      const found = await layer.journeyOf(pick.id, {
        atMs: time.value.live ? undefined : worldClock.now(),
      });
      if (found && Number.isFinite(found.start) && found.path?.length) {
        return {
          start: found.start,
          end: found.end,
          callsign: found.title ?? '',
          readFrom: found.readFrom ?? found.start,
          readTo: found.readTo ?? found.end,
          path: found.path,
          gaps: journeyGaps(found.path, pick.layerId),
          moments: journeyMoments(found.path, {
            kind: /vessel/.test(pick.layerId) ? 'vessel' : 'aircraft',
            nowMs: worldClock.wallNow(),
          }),
        };
      }
    } catch (error) {
      console.warn('Journey unavailable', error);
    }
    return null;
  }
  focusSubject(null);
  return recordedJourney(pick.id);
}
let before = null;
watch(
  () => selected.value?.id,
  async (id) => {
    if (journey.value && before) {
      win.value = before;
      pinSpeed();
    }
    before = null;
    journey.value = null;
    dismissed.value = null;
    setRecordedSubject(id);
    if (!id) {
      focusSubject(null);
      return;
    }
    const found = await readJourney(selected.value);
    if (!found || selected.value?.id !== id) return;
    journey.value = { ...found, title: found.callsign || selected.value.title };
    // The track at rest is nobody's yet: it becomes the journey's.
    // At live the window is on nothing in particular, so it becomes the
    // journey's, whether or not time was touched earlier; it comes back after.
    // Selecting it makes the track its flight's, at live or in the past;
    // the window comes back when it is let go.
    const was = touched.value;
    before = win.value;
    setRange('FIT');
    touched.value = time.value.live ? was : true;
  },
  { immediate: true },
);
// The time moved to a stretch the journey was not read over (a date jump,
// a long rewind): it is read again around the time shown.
let rereading = null;
watch(
  () => [Math.round(time.value.timeMs / MIN), time.value.playing, time.value.live],
  () => {
    const current = journey.value;
    const pick = selected.value;
    if (!current?.readFrom || !pick || time.value.live || rereading) return;
    const at = worldClock.now();
    if (at >= current.readFrom && at <= current.readTo) return;
    rereading = readJourney(pick)
      .then((found) => {
        if (found && selected.value?.id === pick.id)
          journey.value = { ...found, title: found.callsign || pick.title };
      })
      .finally(() => (rereading = null));
  },
);
const subject = computed(() =>
  journey.value && dismissed.value !== selected.value?.id ? journey.value : null,
);
const journeyBar = computed(() => {
  if (!subject.value) return null;
  const { start, end } = view.value;
  const from = Math.max(subject.value.start, start);
  const to = Math.min(Math.max(subject.value.end, nowMs()), end);
  return to > from ? { left: place(from), width: Math.max(0.4, place(to) - place(from)) } : null;
});
// The flight of the journey that holds `ms`: from the takeoff before it to the
// landing after it, within the journey; the whole journey if it is on none.
function legAt(ms) {
  const current = journey.value;
  if (!current) return { from: ms - HOUR, to: ms };
  if (current.period) return { from: ms - current.period / 2, to: ms + current.period / 2 };
  const moments = current.moments ?? [];
  const off = moments.filter((m) => m.kind === 'departed' && m.time <= ms).at(-1);
  const down = moments.find((m) => m.kind === 'landed' && m.time >= ms);
  const landedBefore = moments.filter((m) => m.kind === 'landed' && m.time <= ms).at(-1);
  // On the ground between two flights: the day around it.
  if (landedBefore && (!off || landedBefore.time > off.time))
    return { from: current.start, to: Math.max(current.end, ms) };
  return {
    from: off ? off.time : current.start,
    to: down ? down.time : Math.max(current.end, Math.min(ms, nowMs())),
  };
}
function subjectGapAt(ms) {
  return subject.value?.gaps?.find((gap) => ms > gap.from && ms < gap.to) ?? null;
}
const journeyGapBars = computed(() => {
  if (!subject.value?.gaps?.length) return [];
  const { start, end } = view.value;
  return subject.value.gaps
    .filter((gap) => gap.to > start && gap.from < end)
    .map((gap) => {
      const from = Math.max(gap.from, start);
      const to = Math.min(gap.to, end);
      return {
        key: gap.from,
        parked: gap.parked,
        left: place(from),
        width: Math.max(0.4, place(to) - place(from)),
      };
    });
});
// A replay with something selected keeps the camera on it: the layer's own
// follow camera holds it wherever it was at the time shown, picked up again
// whenever it comes back into its feed; a replay running into a stretch with
// no positions skips over it, and says so.
// A contact the follow camera does not track (a vessel) is kept in frame by
// moving the camera as it moves along its journey.
const softFollow = createSoftFollow(() => globalThis.__godsEyeView?.viewer ?? null);
watch(
  // Two sources, each compared on its own: one array would be new every tick.
  [() => subject.value, () => time.value.live],
  ([current, live]) => {
    const soft = current?.path && !live && !cards.canFollow();
    softFollow.set(soft ? current.path : null, () => worldClock.now(), selected.value?.id);
  },
);
const skipped = shallowRef(null);
let skippedTimer = null;
let followLoop = null;
function keepOnSubject() {
  if (!subject.value || time.value.live) return;
  const at = worldClock.now();
  const dark = subjectGapAt(at);
  if (dark && direction.value !== 0 && pointers.size === 0) {
    const to = direction.value > 0 ? dark.to + 1000 : dark.from - 1000;
    worldClock.seek(to);
    skipped.value = {
      length: dark.to - dark.from,
      title: subject.value.title,
      parked: dark.parked,
    };
    clearTimeout(skippedTimer);
    skippedTimer = setTimeout(() => (skipped.value = null), 4000);
    return;
  }
  if (dark || at < subject.value.start) return;
  if (!cards.lost && !cards.isFollowing() && cards.canFollow()) {
    cards.follow();
    return;
  }
  // Not in its layer at this time yet (its track still loading): bring the
  // view to where its journey puts it, so it is drawn there when it lands.
  if (cards.lost && subject.value.path) viewJourneyAt(subject.value.path, at);
}
watch(
  () => Boolean(subject.value) && !time.value.live,
  (on) => {
    clearInterval(followLoop);
    followLoop = on ? setInterval(keepOnSubject, 400) : null;
  },
  { immediate: true },
);
const pinList = computed(() => answer.value?.pins ?? subject.value?.moments ?? []);
const pins = computed(() => {
  const { start, end } = view.value;
  const at = time.value.timeMs;
  const near = Math.max(1500, win.value.length / 300);
  return pinList.value.map((pin, index) => ({
    ...pin,
    n: index + 1,
    left: place(pin.time),
    shown: pin.time >= start && pin.time <= end,
    active: Math.abs(pin.time - at) <= near,
  }));
});
const pinsBefore = computed(() => pins.value.filter((pin) => pin.time < view.value.start).length);
const pinsAfter = computed(() => pins.value.filter((pin) => pin.time > view.value.end).length);
const activePin = computed(() => pins.value.find((pin) => pin.active) ?? null);
function fitPins() {
  const times = pinList.value.map((pin) => pin.time);
  if (!times.length) return;
  const from = Math.min(...times);
  const to = Math.max(...times);
  const length = Math.max(20 * MIN, (to - from) * 1.3);
  const end = to + length * 0.12;
  win.value = { length: Math.min(length, maxLength.value), end: end >= nowMs() ? null : end };
  pinSpeed();
}
// [ and ]: the mark or the pin before, or after, the time shown.
function toMark(way) {
  const list = [...(time.value.span?.marks ?? []), ...pinList.value.map((pin) => pin.time)].sort(
    (a, b) => a - b,
  );
  const at = time.value.timeMs;
  const to = way < 0 ? list.findLast((ms) => ms < at - 1000) : list.find((ms) => ms > at + 1000);
  if (to !== undefined) seekTo(to);
}
function toPin(way) {
  const list = pinList.value.map((pin) => pin.time);
  const at = time.value.timeMs;
  const to = way < 0 ? list.findLast((ms) => ms < at - 1000) : list.find((ms) => ms > at + 1000);
  seekTo(to ?? (way < 0 ? list.at(-1) : list[0]));
}
function setAnswer(next) {
  answer.value = next?.pins?.length
    ? { title: next.title ?? '', pins: [...next.pins].sort((a, b) => a.time - b.time) }
    : null;
  if (!answer.value) return;
  touched.value = true;
  fitPins();
  seekTo(answer.value.pins.at(-1).time);
}
function clearScope() {
  if (answer.value) answer.value = null;
  else if (subject.value) dismissed.value = selected.value?.id ?? null;
}

// ── The pointer on the track ────────────────────────────────────────────
// One pointer scrubs. Two pinch: the time under the fingers stays under
// them while the track takes in more time, or less.
const pointers = new Map();
let drag = null;
let pinch = null;
const snapPx = () => (coarse.value ? 18 : 8);
function snap(ms, event) {
  if (event.altKey) return ms;
  const px = trackW.value / win.value.length;
  let best = ms;
  let near = snapPx();
  for (const mark of [...(time.value.span?.marks ?? []), ...pinList.value.map((pin) => pin.time)]) {
    const off = Math.abs(mark - ms) * px;
    if (off < near) {
      near = off;
      best = mark;
    }
  }
  return best;
}
const scrub = (ms) =>
  store.scrub(Math.min(ms, hasFuture.value ? Infinity : nowMs()), win.value.length);
function onDown(event) {
  if (event.button > 0) return;
  event.currentTarget.setPointerCapture?.(event.pointerId);
  pointers.set(event.pointerId, event.clientX);
  menu.value = null;
  if (!engaged.value && (layout.value === 'stack' || layout.value === 'phone')) holding.value = true;
  else if (!holding.value) touched.value = true;
  hover.value = null;
  if (pointers.size === 2) {
    // A pinch is not a scrub: the time goes back to where the first finger found it.
    if (drag?.was) {
      if (drag.was.live) store.goLive();
      else scrub(drag.was.ms);
    }
    const [a, b] = [...pointers.values()];
    pinch = { spread: Math.max(8, Math.abs(a - b)), length: win.value.length, ms: timeAt((a + b) / 2) };
    drag = null;
    return;
  }
  still();
  const was = { live: time.value.live, ms: time.value.timeMs };
  if (tape.value) {
    drag = { x: event.clientX, ms: time.value.timeMs, moved: false, was };
    return;
  }
  // A finger waits to see whether it is a tap, a drag or half of a pinch.
  if (event.pointerType === 'touch') {
    drag = { x: event.clientX, moved: false, direct: true, was };
    return;
  }
  drag = { moved: true, direct: true, was };
  scrub(snap(timeAt(event.clientX), event));
}
function onMove(event) {
  if (event.pointerType === 'mouse' && pointers.size === 0) {
    const ms = timeAt(event.clientX);
    const px = trackW.value / win.value.length;
    const mark = marks.value.find((each) => Math.abs(each.time - ms) * px < snapPx());
    const pin = pins.value.find((each) => Math.abs(each.time - ms) * px < snapPx());
    hover.value = { pct: place(ms), ms, label: pin?.label ?? mark?.label ?? '' };
  }
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, event.clientX);
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const spread = Math.max(8, Math.abs(a - b));
    const { left, width: wide } = trackEl.value.getBoundingClientRect();
    const share = tape.value ? HEAD : Math.min(1, Math.max(0, ((a + b) / 2 - left) / wide));
    setLength((pinch.length * pinch.spread) / spread, tape.value ? time.value.timeMs : pinch.ms, share);
    return;
  }
  if (!drag) return;
  if (tape.value) {
    const dx = event.clientX - drag.x;
    if (Math.abs(dx) > 4) drag.moved = true;
    if (drag.moved) scrub(drag.ms - (dx / trackW.value) * win.value.length);
    return;
  }
  if (!drag.moved && Math.abs(event.clientX - drag.x) <= 4) return;
  drag.moved = true;
  scrub(snap(timeAt(event.clientX), event));
}
function onUp(event) {
  const x = pointers.get(event.pointerId);
  pointers.delete(event.pointerId);
  if (pointers.size === 0 && holding.value) {
    holding.value = false;
    touched.value = true;
    // A tap on the bar at rest opens it; it does not also go somewhere.
    if (drag && !drag.moved) drag = null;
  }
  if (pinch) {
    if (pointers.size === 0) pinch = null;
    drag = null;
    return;
  }
  // A tap on a tape goes to the time tapped.
  if (drag && !drag.moved && x !== undefined) seekTo(snap(timeAt(x), event));
  drag = null;
}
function onWheel(event) {
  event.preventDefault();
  touched.value = true;
  const unit = [1, 16, 400][event.deltaMode] ?? 1;
  const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
  if ((sideways || event.shiftKey) && !event.ctrlKey) {
    const pixels = (sideways ? event.deltaX : event.deltaY) * unit;
    const ms = (pixels / trackW.value) * win.value.length;
    if (tape.value) scrub(time.value.timeMs + ms);
    else pan(ms);
    return;
  }
  // A trackpad's pinch comes as a wheel with ctrl held, in finer steps.
  const factor = Math.exp(event.deltaY * unit * (event.ctrlKey ? 0.012 : 0.0025));
  zoomAround(tape.value ? time.value.timeMs : timeAt(event.clientX), factor);
}

// ── Jumping to a time ───────────────────────────────────────────────────
const jumpInput = ref('');
const inputValue = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
};
const jumps = computed(() => {
  if (menu.value !== 'jump') return [];
  const now = nowMs();
  const list = [
    { label: '15 minutes ago', ms: now - 15 * MIN },
    { label: 'An hour ago', ms: now - HOUR },
    { label: 'Yesterday, this time', ms: now - DAY },
    { label: 'A week ago', ms: now - 7 * DAY },
    { label: 'A year ago', ms: now - 365 * DAY },
  ].filter((each) => each.ms >= floor.value);
  if (subject.value)
    list.push({ label: `First sighting of ${subject.value.title}`, ms: subject.value.start + 1000 });
  const loaded = earliest();
  if (now - loaded > MIN) list.push({ label: 'Start of what is loaded', ms: loaded + 1000 });
  if (hasFuture.value)
    list.push({ label: 'In an hour (predicted)', ms: now + HOUR }, { label: 'Tomorrow, this time (predicted)', ms: now + DAY });
  return list.map((each) => ({ ...each, when: stamp(each.ms) }));
});
function openMenu(name) {
  menu.value = menu.value === name ? null : name;
  laneMenu.value = null;
  if (menu.value) touched.value = true;
  if (menu.value === 'jump') jumpInput.value = inputValue(time.value.timeMs);
}
function openLane(id) {
  laneMenu.value = laneMenu.value === id && menu.value === 'lane' ? null : id;
  menu.value = laneMenu.value ? 'lane' : null;
}
function jumpToInput() {
  const ms = new Date(jumpInput.value).getTime();
  if (Number.isFinite(ms)) seekTo(ms);
}

// ── Keys ────────────────────────────────────────────────────────────────
function onKey(event) {
  if (!time.value.span) return;
  if (event.key === 'Escape' && menu.value) {
    menu.value = null;
    return;
  }
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
  else if (key === '-') zoomBy(2);
  else if (key === '=' || key === '+') zoomBy(0.5);
  else if (key === 'r') replaySpan();
  else if (key === '\\') goLive();
  else return;
  event.preventDefault();
}
function onOutside(event) {
  const outside = !root.value?.contains(event.target);
  if (menu.value && outside) menu.value = null;
  else if (outside && coarse.value && layout.value !== 'phone' && time.value.live && direction.value === 0)
    touched.value = false;
}

// ── At rest, and engaged ────────────────────────────────────────────────
// At rest the bar is the clock and a thin strip of the track. Touching time
// (a rewind, a drag, a key, a menu) gives the track its ruler and its reach.
// Nothing else on the page moves either way.
// Where engaging moves the track (a row of its own above the dock, a phone's
// sheet), a gesture that began at rest finishes at rest: nothing moves under
// a finger or a held button.
const holding = ref(false);
const engaged = computed(
  () =>
    !holding.value &&
    (layout.value === 'under' ||
    !time.value.live ||
    lanesOpen.value ||
    direction.value !== 0 ||
    touched.value ||
    menu.value !== null),
);
let restTimer = null;
function onLeave() {
  hover.value = null;
  clearTimeout(restTimer);
  // A finger leaves the bar every time it lifts, so touch never rests on a
  // timer: it rests on LIVE, or on a touch anywhere else on the page.
  if (layout.value === 'phone' || coarse.value) return;
  restTimer = setTimeout(() => {
    if (time.value.live && !menu.value && pointers.size === 0) touched.value = false;
  }, 6000);
}
const onEnter = () => clearTimeout(restTimer);

// ── The page around the bar ─────────────────────────────────────────────
const root = ref(null);
const rootHeight = ref(0);
let sizes = null;
let dockTimer = null;
const rootStyle = computed(() => {
  const d = dock.value;
  if (layout.value === 'phone') return {};
  const style = { width: `${width.value}px` };
  if (layout.value === 'flank') {
    style.bottom = `${d.bottom}px`;
    style['--wt-dock-width'] = `${d.width + 20}px`;
    style['--wt-row'] = `${d.height}px`;
  } else if (layout.value === 'stack') {
    style.width = `${Math.min(900, vw.value - 24)}px`;
    style.bottom = d ? `${d.bottom + d.height + 8}px` : '2vh';
  }
  return style;
});
// The dock rises only where the bar is under it (pass 1's arrangement, and a
// phone's row at rest). Everywhere else nothing moves.
const lift = computed(() => {
  if (!time.value.span) return 0;
  if (layout.value === 'under') return rootHeight.value + 8;
  // A phone's row at rest is 52 px. Its open sheet is a mode of its own, with
  // the search put away while it is open (world-timeline.css), so the map
  // above keeps what room there is.
  if (layout.value === 'phone') return 52;
  return 0;
});
const top = computed(() => {
  if (!time.value.span || layout.value === 'phone') return 0;
  const bottom =
    layout.value === 'under'
      ? 74
      : layout.value === 'flank'
        ? (dock.value?.bottom ?? 74)
        : (dock.value ? dock.value.bottom + dock.value.height + 8 : 16);
  // The caption and the notice stand above the bar; the corners clear them too.
  const above = engaged.value && (answer.value || gap.value || skipped.value) ? 40 : 0;
  return bottom + rootHeight.value + above;
});
// The HUD's stamp says what the picture is: a recording being made (REC) is
// not a replay of one.
function stampHud() {
  const rec = document.querySelector('#intel-hud .hud-rec');
  if (!rec) return;
  for (const node of rec.childNodes) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const want = tense.value === 'past' ? 'REPLAY' : tense.value === 'future' ? 'PREDICTED' : 'REC';
    const next = node.textContent.replace(/REPLAY|PREDICTED|REC/, want);
    if (next !== node.textContent) node.textContent = next;
  }
}
watch(
  [lift, top, tense, layout, engaged, () => Boolean(time.value.span)],
  () => {
    const body = globalThis.document?.body;
    if (!body) return;
    body.style.setProperty('--world-timeline-lift', `${lift.value}px`);
    body.style.setProperty('--world-timeline-top', `${top.value}px`);
    body.dataset.worldTense = time.value.span ? tense.value : 'live';
    body.dataset.worldTimeline = time.value.span
      ? `${layout.value}${layout.value === 'phone' && engaged.value ? '-sheet' : ''}`
      : '';
    stampHud();
    nextTick(measure);
  },
  { immediate: true },
);
watch(root, (el) => {
  sizes?.disconnect();
  if (!el) return;
  sizes = new ResizeObserver(() => {
    rootHeight.value = el.offsetHeight;
    if (trackEl.value) trackW.value = trackEl.value.clientWidth || 600;
  });
  sizes.observe(el);
  if (trackEl.value) sizes.observe(trackEl.value);
});
onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', measure);
  document.addEventListener('pointerdown', onOutside, true);
  measure();
  // The dock mounts on its own time, and moves when the page's layout does.
  dockTimer = setInterval(() => {
    measure();
    arrive();
  }, 700);
  pinSpeed();
  window.__wt = { worldClock, cards, answer: setAnswer, layout, win, subject, softFollow };
});
onBeforeUnmount(() => {
  focusSubject(null);
  softFollow.stop();
  clearInterval(followLoop);
  clearTimeout(skippedTimer);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', measure);
  document.removeEventListener('pointerdown', onOutside, true);
  clearInterval(dockTimer);
  clearTimeout(restTimer);
  stopRewind();
  clearInterval(ramp);
  sizes?.disconnect();
  const body = document.body;
  body.style.removeProperty('--world-timeline-lift');
  body.style.removeProperty('--world-timeline-top');
  delete body.dataset.worldTense;
  delete body.dataset.worldTimeline;
});
// The speed the world actually runs at, whoever set it (these keys, a story,
// voice, an agent): the named speed when it is one, else the rate itself.
const rateLabel = (rate) => {
  const named = SPEEDS.find((each) => Math.abs(each.rate - rate) < 1e-6);
  if (named) return named.label;
  if (rate < 60) return `${Math.round(rate)}×`;
  if (rate < 3600) return `${Math.round(rate / 60)} MIN/S`;
  if (rate < 86400) return `${Math.round(rate / 3600)} H/S`;
  return `${Math.round(rate / 86400)} D/S`;
};
const speedLabel = computed(() => {
  void time.value.timeMs;
  const running = time.value.playing && !time.value.live && direction.value >= 0;
  const label = running ? rateLabel(worldClock.getRate()) : speed.value.label;
  return direction.value < 0 ? `◀ ${label}` : label;
});
const playing = computed(
  () => direction.value !== 0 || time.value.live || Boolean(time.value.playing),
);
</script>

<template>
  <div
    v-if="time.supported && time.span"
    id="world-timeline"
    ref="root"
    v-root-class="{ 'has-world-timeline': true }"
    class="wt"
    :class="[
      `is-${tense}`,
      `is-${layout}`,
      engaged ? 'is-engaged' : 'is-rest',
      menu ? 'has-menu' : '',
      { 'is-open': lanesOpen, 'is-running': direction !== 0, 'is-tape': tape, 'is-coarse': coarse },
    ]"
    :style="rootStyle"
    role="group"
    :aria-label="t('World time')"
    @pointerleave="onLeave"
    @pointerenter="onEnter"
  >
    <!-- Above the bar: what an answer's pins are, and a layer on that has
         nothing at the time shown, with the way out. -->
    <div v-if="engaged && !menu && (answer || gap || skipped)" class="wt-above">
      <span v-if="answer" class="wt-caption"><b>{{ pins.length }}</b>{{ answer.title }}</span>
      <p v-if="skipped && !gap" class="wt-notice is-skip"><span>{{ skipped.parked ? `SKIPPED ${spanLabel(skipped.length)} ON THE GROUND` : `SKIPPED ${spanLabel(skipped.length)} WITH NO POSITIONS OF ${skipped.title}` }}</span></p>
      <button v-if="gap" type="button" class="wt-notice" :disabled="gap.nearest === null" @click="seekTo(gap.nearest)">
        <span>{{ gap.text }}</span><b v-if="gap.label">{{ gap.label }} ›</b>
      </button>
    </div>

    <!-- Menus open upward from the control they belong to. -->
    <div v-if="menu === 'jump'" class="wt-menu wt-menu--jump" role="menu" :aria-label="t('Go to a time')">
      <button type="button" role="menuitem" :disabled="time.live" @click="goLive(true)"><span>Now</span><em>LIVE</em></button>
      <button v-for="each in jumps" :key="each.label" type="button" role="menuitem" @click="seekTo(each.ms)">
        <span>{{ each.label }}</span><em>{{ each.when }}</em>
      </button>
      <form class="wt-menu-date" @submit.prevent="jumpToInput">
        <label for="wt-jump-input">A date and time</label>
        <span><input id="wt-jump-input" v-model="jumpInput" type="datetime-local" :max="hasFuture ? undefined : inputValue(nowMs())" /><button type="submit">GO</button></span>
      </form>
    </div>
    <div v-if="menu === 'speed'" class="wt-menu wt-menu--speed" role="menu" :aria-label="t('Speed')">
      <button type="button" role="menuitemradio" :aria-checked="!speedPinned" @click="setSpeed(null)">
        <span>Fit the span</span><em>{{ SPEEDS[autoSpeed(win.length)].label }}</em>
      </button>
      <button v-for="(each, index) in SPEEDS" :key="each.rate" type="button" role="menuitemradio" :aria-checked="speedPinned && index === speedIndex" @click="setSpeed(index)">
        <span>{{ each.name }}</span><em>{{ each.label }}</em>
      </button>
    </div>
    <div v-if="menu === 'range'" class="wt-menu wt-menu--range" role="menu" :aria-label="t('Time shown')">
      <button type="button" role="menuitem" @click="replaySpan"><span>Replay this from its start</span><em>▶</em></button>
      <button v-if="subject" type="button" role="menuitem" @click="setRange('FIT')"><span>The whole flight</span><em>{{ subject.title }}</em></button>
      <button v-for="each in RANGES.filter((range) => range.length <= maxLength)" :key="each.key" type="button" role="menuitemradio" :aria-checked="rangeLabel === each.key" @click="setRange(each.key)">
        <span>{{ each.name }}</span><em>{{ each.key }}</em>
      </button>
      <button type="button" role="menuitemradio" :aria-checked="rangeLabel === 'ALL'" @click="setRange('ALL')"><span>Everything, from {{ reach.from }}</span><em>ALL</em></button>
    </div>
    <div v-if="menu === 'lane' && laneInfo" class="wt-menu wt-menu--lane" role="dialog" :aria-label="laneInfo.label">
      <strong>{{ laneInfo.label }}</strong>
      <p v-for="row in laneInfo.rows" :key="row">{{ row }}</p>
      <button v-if="laneInfo.nearest !== null" type="button" @click="seekTo(laneInfo.nearest)"><span>Go to its nearest data</span><em>{{ stamp(laneInfo.nearest) }}</em></button>
    </div>

    <div class="wt-body">
      <!-- The lanes: each layer's own stretch of data, opened on demand. The
           names keep to a gutter, so nothing is written over the data. -->
      <div v-if="lanesOpen" class="wt-lanes">
        <div v-for="lane in lanes" :key="lane.id" class="wt-lane" :class="[`is-${lane.kind}`, { 'is-missing': lane.missing }]">
          <button type="button" class="wt-gutter wt-lane-name" :aria-expanded="laneMenu === lane.id && menu === 'lane'" :title="lane.missing ? 'Nothing at this time' : KINDS[lane.kind]" @click="openLane(lane.id)">
            <i></i><span>{{ lane.label }}</span>
          </button>
          <span class="wt-lane-track">
            <span v-if="lane.hollow" class="wt-lane-hollow" :style="{ left: `${lane.hollow.left}%`, width: `${lane.hollow.width}%` }"></span>
            <span v-if="lane.shown && lane.kind !== 'events'" class="wt-lane-bar" :style="{ left: `${lane.left}%`, width: `${lane.width}%` }"></span>
            <span v-for="(at, index) in lane.frames" :key="`f${index}`" class="wt-lane-frame" :style="{ left: `${at}%` }"></span>
            <span v-for="(at, index) in lane.marks" :key="`m${index}`" class="wt-lane-mark" :style="{ left: `${at}%` }"></span>
            <span class="wt-lane-head" :style="{ left: `${clampPct(headPct)}%` }"></span>
          </span>
        </div>
      </div>

      <!-- How far back: the whole reach of the layers on, and where the track is in it. -->
      <div v-if="engaged" class="wt-reach">
        <span class="wt-gutter wt-reach-name">HOW FAR BACK</span>
        <span ref="reachEl" class="wt-reach-track" :title="`Everything on reaches back to ${reach.from}`" @pointerdown="reachDown" @pointermove="reachMove" @pointerup="reachUp" @pointercancel="reachUp">
          <span v-if="reach.archive !== null" class="wt-reach-archive" :style="{ left: `${reach.archive}%`, right: `${100 - reach.loaded}%` }"></span>
          <span class="wt-reach-loaded" :style="{ left: `${reach.loaded}%` }"></span>
          <span v-for="tick in reach.ticks" :key="tick.label" class="wt-reach-tick" :style="{ left: `${tick.left}%` }"><em>{{ tick.label }}</em></span>
          <span class="wt-reach-window" :style="{ left: `${reach.window.left}%`, width: `${reach.window.width}%` }"></span>
          <span class="wt-reach-head" :style="{ left: `${reach.head}%` }"></span>
        </span>
      </div>

      <div class="wt-trackrow">
        <!-- The gutter says what the track is about: the layers on, the thing selected, or an answer. -->
        <div class="wt-gutter wt-scope">
          <template v-if="answer">
            <button type="button" class="wt-scope-step" :aria-label="t('Previous')" @click="toPin(-1)">‹</button>
            <span class="wt-scope-name" :title="answer.title">{{ activePin ? activePin.n : '·' }}/{{ pins.length }}</span>
            <button type="button" class="wt-scope-step" :aria-label="t('Next')" @click="toPin(1)">›</button>
            <button type="button" class="wt-scope-x" :aria-label="t('Clear')" @click="clearScope">×</button>
          </template>
          <template v-else-if="subject">
            <button type="button" class="wt-scope-name is-subject" title="Fit the track to its journey" @click="setRange('FIT')">{{ subject.title }}</button>
            <button type="button" class="wt-scope-x" :aria-label="t('Clear')" @click="clearScope">×</button>
          </template>
          <button type="button" class="wt-scope-lanes" :aria-pressed="lanesOpen" :aria-label="t('Layers on the timeline')" title="Show each layer's data" @click="lanesOpen = !lanesOpen; touched = true">
            <span v-if="!answer && !subject">LAYERS · {{ lanes.length }}</span>
            <svg viewBox="0 0 12 12" aria-hidden="true"><path :d="lanesOpen ? 'M2 4.5l4 4 4-4' : 'M2 7.5l4-4 4 4'" /></svg>
          </button>
        </div>

        <!-- The track: a window of time, its ruler, where there is data, the marks and the time shown. -->
        <div
          ref="trackEl"
          class="wt-track"
          role="slider"
          tabindex="0"
          :aria-label="t('World time')"
          :aria-valuemin="Math.round(view.start)"
          :aria-valuemax="Math.round(view.end)"
          :aria-valuenow="Math.round(time.timeMs)"
          :aria-valuetext="clock.spoken"
          @pointerdown="onDown"
          @pointermove="onMove"
          @pointerup="onUp"
          @pointercancel="onUp"
          @pointerleave="hover = null"
          @wheel="onWheel"
          @dblclick="setRange('1D')"
          @keydown.left.prevent="step(-1)"
          @keydown.right.prevent="step(1)"
        >
          <span v-if="nowPct < 100" class="wt-ahead" :style="{ left: `${clampPct(nowPct)}%` }"></span>
          <span v-for="tick in ruler" :key="tick.ms" class="wt-tick" :class="{ 'is-major': tick.major, 'is-midnight': tick.midnight }" :style="{ left: `${tick.left}%` }"
            ><em v-if="tick.label">{{ tick.label }}</em></span
          >
          <span class="wt-strip">
            <span v-if="stripArchive" class="wt-strip-archive" :style="{ left: `${stripArchive.left}%`, width: `${stripArchive.width}%` }"></span>
            <span v-for="(part, index) in strip" :key="index" class="wt-strip-part" :class="{ 'is-all': part.all, 'is-future': part.future }" :style="{ left: `${part.left}%`, width: `${part.width}%` }"></span>
          </span>
          <span v-if="journeyBar" class="wt-journey" :class="{ 'is-computed': subject?.computed }" :style="{ left: `${journeyBar.left}%`, width: `${journeyBar.width}%` }"></span>
          <span v-for="dark in journeyGapBars" :key="`g${dark.key}`" class="wt-journey-gap" :class="{ 'is-parked': dark.parked }" :style="{ left: `${dark.left}%`, width: `${dark.width}%` }"></span>
          <span v-for="mark in marks" :key="`${mark.time}${mark.label}`" class="wt-mark" :style="{ left: `${mark.left}%` }"></span>
          <span v-if="nowPct >= 0 && nowPct <= 100" class="wt-now" :style="{ left: `${nowPct}%` }"><em>NOW</em></span>
          <template v-for="pin in pins" :key="`p${pin.n}`">
            <span v-if="pin.shown" class="wt-pin" :class="{ 'is-active': pin.active, 'is-answer': Boolean(answer) }" :style="{ left: `${pin.left}%` }"><b>{{ pin.n }}</b></span>
          </template>
          <span v-if="pinsBefore" class="wt-pins-off is-before">‹ {{ pinsBefore }}</span>
          <span v-if="pinsAfter" class="wt-pins-off is-after">{{ pinsAfter }} ›</span>
          <span v-if="hover && pointers.size === 0" class="wt-hover" :class="{ 'is-late': hover.pct > 70 }" :style="{ left: `${hover.pct}%` }"
            ><em>{{ hover.label ? `${hover.label} · ` : '' }}{{ stamp(hover.ms) }} · {{ utcOf(hover.ms) }}</em></span
          >
          <span v-if="headPct >= 0 && headPct <= 100" class="wt-head" :class="{ 'is-late': headPct > 70 }" :style="{ left: `${headPct}%` }"
            ><i></i><em v-if="activePin">{{ activePin.n }} · {{ activePin.label }}</em></span
          >
          <span v-if="time.buffering" class="wt-wait" :style="{ left: `${clampPct(headPct)}%` }"></span>
        </div>
      </div>

      <div class="wt-controls">
        <div class="wt-left">
          <!-- The clock: one place to read the time. It opens the ways to another. -->
          <button type="button" class="wt-clock" :aria-expanded="menu === 'jump'" :aria-label="`${clock.spoken}. ${t('Go to a time')}`" title="Go to a time" @click="openMenu('jump')">
            <span class="wt-clock-main">
              <span class="wt-clock-time">{{ clock.time }}<i>{{ clock.zone }}</i></span>
              <span class="wt-clock-sub">{{ clock.date }} · {{ clock.utc }}</span>
            </span>
            <span class="wt-tense">
              <template v-if="tense === 'live'"><b class="wt-dot"></b>LIVE</template>
              <template v-else><b>{{ tense === 'past' ? 'REPLAY' : 'PREDICTED' }}</b><span>{{ clock.ago }}</span></template>
            </span>
          </button>
          <div class="wt-shuttle">
            <button type="button" class="wt-key" :class="{ 'is-on': direction < 0 }" :aria-label="t('Rewind')" :aria-pressed="direction < 0" title="Rewind · tap to run, hold to rewind while held · J" @pointerdown="holdStart(-1, $event)" @pointerup="holdEnd" @pointercancel="holdEnd" @click="holdKey(-1, $event)">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11L2.5 10zM17.5 4.5v11L10 10z" /></svg>
            </button>
            <button type="button" class="wt-key wt-key--play" :aria-label="playing ? t('Pause') : t('Play')" :title="time.live ? 'Hold this moment · K' : playing ? 'Pause · K' : 'Play on from here · K'" @click="togglePlay">
              <svg v-if="playing" viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 4h3v12h-3zM11.5 4h3v12h-3z" /></svg>
              <svg v-else viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4l10 6-10 6z" /></svg>
            </button>
            <button type="button" class="wt-key wt-key--fwd" :class="{ 'is-on': direction > 0 }" :disabled="time.live && !hasFuture" :aria-label="t('Fast forward')" :aria-pressed="direction > 0" title="Forward · tap to run, hold to run while held · L" @pointerdown="holdStart(1, $event)" @pointerup="holdEnd" @pointercancel="holdEnd" @click="holdKey(1, $event)">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11l7.5-5.5zM2.5 4.5v11L10 10z" /></svg>
            </button>
          </div>
          <!-- The speed reads with the clock and the keys it modifies: what time
               it is, whether it moves, and how fast, in one glance. -->
          <button type="button" class="wt-chip wt-speed" :class="{ 'is-auto': !speedPinned }" :aria-expanded="menu === 'speed'" title="Speed" @click="openMenu('speed')">{{ speedLabel }}</button>
        </div>
        <div class="wt-dockroom" aria-hidden="true"></div>
        <div class="wt-right">
          <div class="wt-zoom" role="group" :aria-label="t('Time shown')">
            <button type="button" :aria-label="t('Show more time')" title="Show more time · −" :disabled="win.length >= maxLength * 0.999" @click="zoomBy(2)">−</button>
            <button type="button" class="wt-zoom-span" :aria-expanded="menu === 'range'" title="How much time the track shows" @click="openMenu('range')">{{ rangeLabel }}</button>
            <button type="button" :aria-label="t('Show less time')" title="Show less time · +" :disabled="win.length <= MIN_LENGTH" @click="zoomBy(0.5)">+</button>
          </div>
          <button type="button" class="wt-resting" title="Play it from the start" @click="replaySpan"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4l10 6-10 6z" /></svg>{{ restLabel }}</button>
          <!-- How far from now, beside the way back to it. -->
          <span v-if="tense !== 'live'" class="wt-tense wt-tense--side"><b>{{ tense === 'past' ? 'REPLAY' : 'PREDICTED' }}</b><span>{{ clock.ago }}</span></span>
          <button type="button" class="wt-live" :class="{ 'is-live': time.live }" :disabled="time.live && !engaged" :title="time.live ? 'Live' : 'Back to live · \\'" @click="goLive()"><b class="wt-dot"></b>{{ time.live && layout === 'phone' ? 'DONE' : 'LIVE' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
