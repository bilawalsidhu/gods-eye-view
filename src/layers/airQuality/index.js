import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import { greatCircleKm } from '../../geoDistance.js';
import {
  canvasOf,
  drawOf,
  findCamera,
  findFrame,
  findQuery,
} from '../../render/rendererOf.js';
import { replaceDynamicCredit } from '../../data/dataCredits.js';
import { worldClock, isWorldTime } from '../../time/worldClock.js';
import { globeImageryHost } from '../weather/shellPlacement.js';
import {
  fieldCoverage,
  fieldIdOf,
  fieldLayout,
  fieldStepAt,
  fieldStepTime,
  fieldStrength,
  gridFingerprint,
  paintField,
  readFieldManifest,
  readFieldStep,
  sampleField,
} from './field.js';
import { createFieldDrawing } from './fieldDrawing.js';
import {
  isTrackingClickGesture,
  isTrackingSelectionGesture,
} from '../../data/trackingClickGesture.js';
import { keyRequirementText } from '../../ui/keyGuidance.js';
import { formatQuantity } from '../../ui/unitLabels.js';
import {
  isRatedReading,
  mergeObservations,
  mergeStationValues,
} from './merge.js';
import {
  EEA_HOURLY_BANDS,
  EEA_HOURLY_LIMITS,
  hourlyBandIndex,
  interpretHourly,
} from './interpretation.js';
import {
  cellDegAt,
  groupStations,
  groupTarget,
  nearestItem,
} from './groups.js';
import {
  AQI_PARAMETERS,
  AQI_POLLUTANTS,
  US_AQI_BANDS,
  US_AQI_LIMITS,
  aqiStations,
  stationIndex,
  usAqiBand,
} from './usAqi.js';
import { concentrationIn, layerUnits } from './units.js';
import {
  onLocaleChange,
  formatNumber,
  formatUtcDayMonth,
  msg,
  t,
  tn,
} from '../../i18n/index.js';
import {
  AIR_QUALITY_UNRATED_COLOR,
  AIR_QUALITY_UNKNOWN_COLOR,
  AIR_QUALITY_OVERLAY_SOURCE_ID,
  AIR_QUALITY_OVERLAY_COHORT_LIMIT,
  AIR_QUALITY_OVERLAY_COLLISION_CAPACITY,
  OBSERVATION_MAX_AGE_MS,
  createAirQualityOverlayEntry,
  mapAnalystRecord,
  newestObservation,
  readingsAreStale,
  isInRectangle,
  selectAirQualityOverlayCohort,
  STALE_AFTER_MS,
} from './model.js';
export * from './model.js';
export { createAirQualitySource } from './providers.js';

/** Picking source ID for station and group clicks. */
const STATION_CLICK_SOURCE = 'air-quality-stations';
/** A label's claim for the selected station: above any reading's. */
const SELECTED_LABEL_VALUE = 1e7;
/** Time on either side of now for which stations can accompany the current step. */
const STATIONS_NOW_MS = 3600_000;
const HOUR_MS = 3600_000;
/** Bidi controls a source's text may carry: marks, embeddings, overrides, isolates. */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** A station name on its map label: without bidi controls, isolated so it cannot reorder the value after it. */
const labelName = (name) =>
  `\u2068${String(name ?? '').replace(BIDI_CONTROLS, '')}\u2069`;
/** A failure as a fixed reason for the console: its code, its HTTP status, or its kind. */
const failureReason = (error) =>
  error?.code ||
  (Number.isInteger(error?.status)
    ? `HTTP ${error.status}`
    : error?.name || 'error');
/** Readings listed in the readout card. */
const READOUT_LIMIT = 5;
/** Station dots, CSS pixels: plain and selected. */
const STATION_PX = 7;
const SELECTED_STATION_PX = 13;
/** The selected station's ring: the UI accent, not a group's white. */
const SELECTED_OUTLINE = '#36dcff';
const SELECTED_OUTLINE_WIDTH = 2;
/** A group's light outline, which tells it from a station's dark one. */
const GROUP_OUTLINE = Object.freeze([1, 1, 1, 0.85]);
const GROUP_OUTLINE_WIDTH = 1.5;
/** A click on a group flies to its stations in this many seconds. */
const GROUP_FLIGHT_S = 1.4;
/**
 * A provider that answered "no key" is asked again after this long. Saving a
 * key in Provider Settings restarts the server and reloads the page, which
 * starts the layer afresh; a host that adds a key without a reload is caught
 * here.
 */
const NO_KEY_RETRY_MS = 10 * 60_000;
/** An update resolves on the first provider's answer, or after this long. */
const FIRST_ANSWER_CAP_MS = 5_000;
/** Remembered AQI-view values fill other views' tiles for this long. */
const REMEMBERED_MS = 3600_000;
/** The layer's id on the world clock. */
const CLOCK_ID = 'air-quality';
/** At now a model field's manifest is asked again this often, for a newer run. */
const FIELD_MANIFEST_MS = 10 * 60_000;
/** A model field request that failed is tried again after this long. */
const FIELD_RETRY_MS = 60_000;
/** Away from now, the run covering a time is asked once per this much of it. */
const FIELD_ASK_BUCKET_MS = 3 * 3600_000;
/** Playing, the clock waits at most this long for the next step. */
const FIELD_WAIT_MS = 20_000;
/** Farthest a station's reading stands for a point, in kilometres. */
export const AIR_QUALITY_VALUE_RADIUS_KM = 50;

export const AIR_QUALITY_MARKER_SET_ID = 'air-quality';
let instances = 0;

/** Pollutant views, as the providers' parameter ids; each on its own scale. */
export const AIR_QUALITY_POLLUTANT_VIEWS = Object.freeze([
  'PM2.5',
  'PM10',
  'O3',
  'NO2',
  'SO2',
  'CO',
]);
/**
 * A source that names no providers (no `definitions`) is one station network
 * of its own, offering every view.
 */
const SOURCE_DEFINITION = Object.freeze({
  id: 'air-quality',
  title: msg('Air quality'),
  label: msg('Air quality'),
  network: 'Air quality',
  parameters: AIR_QUALITY_POLLUTANT_VIEWS,
});
/** The index's name: the same text in every language. */
const AQI_NAME = 'US AQI';
/** Pollutant names on the tiles, chemical formulas as written. */
const POLLUTANT_TILE_LABELS = Object.freeze({
  'PM2.5': 'PM2.5',
  PM10: 'PM10',
  O3: 'O₃',
  NO2: 'NO₂',
  SO2: 'SO₂',
  CO: 'CO',
});
/** The pollutant tiles' units, said once in their heading. */
const POLLUTANT_UNITS = 'µg/m³ · CO mg/m³';
/** A tile with no value. */
const NO_VALUE = '—';
/**
 * The US AQI has no upper limit (`usAqi.js`), but its table ends at 500:
 * above it an index is shown as "500+", and a station adds at most 500 to its
 * group's mean. The computed value stays in the data.
 */
const AQI_SHOWN_MAX = 500;
/** A US AQI as the card and the map show it. */
const aqiText = (index) =>
  index > AQI_SHOWN_MAX ? `${AQI_SHOWN_MAX}+` : String(index);
/** Why a station value is not part of its index (`stationIndex`). */
const EXCLUSION_REASONS = Object.freeze({
  units: msg('unrated units'),
  flagged: msg('flagged by the source'),
  implausible: msg('implausible'),
  'above-pm10': msg('above PM10'),
  'too-old': msg('too old'),
  nowcast: msg('too few hours for a NowCast'),
  hours: msg('too few hours for an 8-hour average'),
  incomplete: msg('incomplete hour'),
  averaging: msg('averaging period not rated'),
  sensor: msg('low-cost sensor'),
});
/**
 * What a station's value stands for: the NowCast of its recent hourly
 * means, or its averaging period in minutes.
 */
function averagingText(method, minutes) {
  if (method === 'nowcast') return t('NowCast of recent hourly means');
  if (minutes === 60) return t('Hourly average');
  if (minutes === 480) return t('8-hour average');
  if (minutes === 1440) return t('24-hour average');
  return t('Source averaging period unspecified');
}
/** A concentration in the layer's units as a number, without its unit. */
function concentrationText(parameter, value) {
  const onLimit = EEA_HOURLY_LIMITS[parameter]?.some(
    (limit) => value > limit && Math.round(value) === limit,
  );
  const digits = parameter === 'CO' ? 2 : value < 10 || onLimit ? 1 : 0;
  return formatNumber(value, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  });
}

/** One station value as text, in the layer's units. */
function valueText(key, value) {
  const parameter = AQI_PARAMETERS[key];
  return `${parameter} ${concentrationText(parameter, value)} ${layerUnits(parameter)}`;
}

/**
 * How fresh `ms` is at `from` (now unless given), in the card's short form
 * ("5m ago", "3h ago").
 */
function shortAgo(ms, from = Date.now()) {
  const minutes = Math.max(0, Math.floor((from - ms) / 60_000));
  if (minutes < 1) return t('just now');
  if (minutes < 60) return t('{minutes}m ago', { minutes });
  return t('{count}h ago', { count: Math.floor(minutes / 60) });
}

/** One station across views: its provider and the provider's station id. */
const stationKey = (reading) =>
  `${reading.provider}:${reading.stationId ?? reading.id}`;

/** A time on the card, "11-24 12:00 UTC" in English. */
const utcText = (ms) =>
  `${formatUtcDayMonth(ms)} ${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** The bands and limits a view's values are coloured on. */
const scaleOf = (view) =>
  view === 'aqi'
    ? { bands: US_AQI_BANDS, limits: US_AQI_LIMITS }
    : { bands: EEA_HOURLY_BANDS, limits: EEA_HOURLY_LIMITS[view] };

/**
 * Own one air-quality display, its refresh lifecycle, and its readout card.
 *
 * The layer shows one `view` at a time: the US AQI (`'aqi'`, the default) or
 * one pollutant (`'PM2.5'`, `'NO2'`, ...). Every provider of
 * `source.definitions` is a station network (a source without definitions is
 * one network of its own, `SOURCE_DEFINITION`): those offering the view are
 * asked in parallel and drawn as one de-duplicated set (`merge.js`). A
 * provider that fails or needs a key keeps its own state and never blanks the
 * others.
 *
 * Each view has one scale, for colour, ranking and legend: the US AQI view
 * the EPA categories of an index computed per station from all its
 * pollutants (`usAqi.js`; providers are asked with `mode: 'aqi'`), and a
 * pollutant view the EEA hourly bands of the concentration. No network's own
 * index is used or shown: the computed US AQI is the one index.
 *
 * At far zoom, stations that would overlap on screen draw as one group
 * (`groups.js`) in the band colour of their members' mean; a click on a group
 * flies in until its stations separate, or selects the highest if they cannot separate
 * or that flight would zoom out. A click on a station selects it (`station`).
 * Without `input` (the input dispatcher's `inputFor`) the layer takes no
 * clicks. `picking` is the pick
 * registry (`src/data/pickRegistry.js`): the drawn stations and groups are
 * registered as this layer's picks while it is on, and a card painted on top
 * of a click (`clickCard`) takes it. `pointer.isPointerFree` holds clicks
 * off while a tool has the pointer.
 *
 * A host may give a model field (`fieldSource`, its contract in `field.js`):
 * a forecast grid of the six pollutants and the US AQI. The layer then draws
 * the view's field under the stations (`fieldDrawing.js`,
 * through the weather imagery host the shell attaches), puts the forecast on
 * the world clock's timeline (`clock.register`, the run's first step to its
 * last) and follows the clock while the field is on (`clock.hold`), drawing
 * the step nearest the clock's time. Stations are measurements of now: away
 * from now they are hidden. The tiles then read the model at the view centre
 * (said so: "model at view centre"), a selected station's own values at now,
 * and the card's time line names the model and the time it shows. Without a
 * field, or when the source says none is configured, nothing is registered
 * and the layer shows stations only.
 */
export function createAirQualityLayer({
  source,
  overlayHost,
  input = null,
  picking = null,
  pointer = null,
  fieldSource = null,
  clock = worldClock,
  registerCredit = replaceDynamicCredit,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Air quality requires a snapshot source');
  if (!overlayHost) throw new TypeError('Air quality requires an overlay host');
  const definitions = source.definitions ?? [SOURCE_DEFINITION];
  if (!Array.isArray(definitions) || !definitions.length)
    throw new TypeError('Air quality requires providers');
  if (
    fieldSource != null &&
    (typeof fieldSource.getManifest !== 'function' ||
      typeof fieldSource.getStep !== 'function')
  )
    throw new TypeError(
      'An air-quality field source needs getManifest and getStep',
    );
  let _viewer = null;
  let _points = null;
  /**
   * Each drawn point by item id, with
   * where it is drawn and its size; the readings drawn on their own, which
   * keep their labels.
   */
  let _drawn = new Map();
  let _labelled = new Set();
  let _offClick = null;
  let _readings = [];
  let _lastUpdate = null;
  let _enabled = false;
  /** @type {{ invalidate: () => void } | null} the panels' handle, from init */
  let _panel = null;
  /** Views this source can answer, the default first. */
  const views = Object.freeze([
    'aqi',
    ...AIR_QUALITY_POLLUTANT_VIEWS.filter((id) =>
      definitions.some((entry) => entry.parameters.includes(id)),
    ),
  ]);
  let view = views[0];
  let showStations = true;
  let selectedStation = null;
  /** The selected station across views (`stationKey`), once it is known. */
  let selectedKey = null;
  /**
   * Providers that answered that they have no key (`'no-key'`), or that this
   * server leaves them switched off (`'disabled'`), by provider id: the
   * answer and when it came. Either is guidance, never a failure.
   */
  const parked = new Map();
  /**
   * Each provider's latest AQI-view station readings and when they came:
   * the tiles of the other views read them, without asking again.
   */
  const aqiMemory = new Map();
  /**
   * The selected station as last seen (its reading and its network): it
   * heads the card in every view, also one where it has no reading.
   */
  let selectedSeen = null;
  /** The nearest-station result the tiles last read, kept while a new view loads. */
  let lastNearest = null;
  /** The providers the current view asks. */
  const asked = () =>
    view === 'aqi'
      ? definitions
      : definitions.filter((entry) => entry.parameters.includes(view));
  /**
   * The request for the current view: one pollutant, or every one, and away
   * from now the hour the stations are asked for (`atMs`, see `stationsAt`).
   */
  const requestFor = () => {
    const atMs = stationsAt();
    return {
      ...(view === 'aqi' ? { mode: 'aqi' } : { parameter: view }),
      ...(atMs === null ? {} : { atMs }),
    };
  };
  const freshState = () => ({
    status: 'idle',
    readings: [],
    coverage: null,
    error: null,
    retryAt: null,
    request: null,
    requestedView: null,
    /** The hour last asked for, null for now (`stationsAt`). */
    requestedAt: null,
    /**
     * The hour its readings are for, null for now: the time asked, once the
     * source said it answered for it (`getCoverage().atMs`).
     */
    answeredAt: null,
    /** Whether it answered in this view: data, a failure, or no key. */
    settled: false,
    /** Whether its last failure was the network refusing the key. */
    keyRejected: false,
    /** Whether its last failure was the network's request budget. */
    rateLimited: false,
  });
  /** Per-provider acquisition state, keyed by provider id. */
  let states = new Map();
  const stateOf = (entry) => {
    if (!states.has(entry.id)) states.set(entry.id, freshState());
    return states.get(entry.id);
  };
  /** Which provider a drawn reading came from (ids may be reused by hosts). */
  let owners = new WeakMap();
  let replacedBy = new Map();
  const ownerOf = (reading) =>
    owners.get(reading) ?? asked()[0] ?? definitions[0];
  let overlayEntries = [];
  let removeMoveEnd = null;
  let moveTimer = null;
  let retryTimer = null;
  /** The stations' time last asked for (`timeKey`). */
  let stationsKey = null;
  /** Merges the drawn set again when its next reading turns too old. */
  let ageTimer = null;
  /**
   * The model field: the run held (`manifest`, read by `readFieldManifest`),
   * the step loaded (`data`), what is being asked, and whether the host has
   * no field to give (`absent`). See `syncField`.
   */
  const field = {
    manifest: null,
    /** What the request in flight asks for: 'now', or a time's three-hour bucket. */
    manifestWant: null,
    /** The clock's jump count when that request was made. */
    manifestJumps: 0,
    /** A run the host said it no longer has: it covers no time asked for. */
    goneRun: null,
    /** Whether the source explicitly reported that the forecast is unavailable. */
    manifestUnavailable: false,
    data: null,
    absent: !fieldSource,
    /** The last manifest ask failed. */
    manifestFailed: false,
    /**
     * A manifest was read at least once: before that a failure may only mean
     * nobody configured a field, and the card says nothing of it.
     */
    everRead: false,
    /** What the run held was asked for: 'now', or a time's three hours. */
    heldFor: null,
    /** Whether the layer drew the present when last in step with the clock. */
    wasLive: true,
    manifestRequest: null,
    stepRequest: null,
    aheadRequest: null,
    ahead: null,
    failedAhead: null,
    /** When each ask may be made again: 'now', or a time's three hours. */
    asks: new Map(),
    /** The step that failed to load, `run|step`, and when to try again. */
    failedStep: null,
    retryStepAt: 0,
  };
  /** The run and view of the field drawn, while one is. */
  let drawnField = null;
  /** The time the layer draws at: the world clock's while it follows it. */
  const layerTime = clock.timeFor(CLOCK_ID);
  let releaseHold = null;
  let releaseWait = null;
  let aheadIdle = null;
  let uncover = null;
  let offClock = null;
  let offMapStack = null;
  let offCameraChange = null;
  let offVisibility = null;
  let coverageKey = 'null';
  let clockKey = null;
  let syncing = false;
  let imageryHost = null;
  let offLocale = null;
  let runNavigation = null;
  let fieldDrawing = null;

  /**
   * The networks the view asks, as the Layers row names them; one this server
   * leaves switched off (`'disabled'`) is left out.
   */
  const sourceLabel = () => {
    const on = asked().filter(
      (entry) =>
        stateOf(entry).status !== 'disabled' &&
        parkedStatus(entry) !== 'disabled',
    );
    return (on.length ? on : asked())
      .map((entry) => entry.sourceLabel || entry.network)
      .join(' · ');
  };
  /** Networks in the order the card names them: a worldwide one first. */
  const worldwideFirst = (entries) => [
    ...entries.filter((entry) => entry.worldwide === true),
    ...entries.filter((entry) => entry.worldwide !== true),
  ];
  const isLoading = () =>
    asked().some((entry) => stateOf(entry).status === 'loading');
  /** Whether a provider's answer counts: it answered, or drew readings. */
  const answered = (entry) => {
    const state = stateOf(entry);
    return state.status === 'ok' || state.readings.length > 0;
  };
  /**
   * A provider's "no key" or "disabled" answer while it still stands (asked
   * less than `NO_KEY_RETRY_MS` ago), else null.
   */
  const parkedStatus = (entry) => {
    const item = parked.get(entry.id);
    return item && Date.now() - item.at < NO_KEY_RETRY_MS ? item.status : null;
  };
  /** Whether a provider's state is a "no key" or "disabled" answer. */
  const isParked = (state) =>
    state.status === 'no-key' || state.status === 'disabled';
  /**
   * Whether the source offers a view that asks other providers than this
   * one does (the US AQI asks every network, a pollutant view those
   * measuring it).
   */
  const otherViewOnOffer = () => {
    const current = asked();
    return definitions.some((entry) => !current.includes(entry));
  };
  /**
   * A layer error only when no asked provider answered. A network that needs
   * its key, or that this server leaves off, is guidance, not an error: the
   * keys the networks lack are the layer's key-required stat.
   */
  const lastError = () => {
    const list = asked().map(stateOf);
    if (list.some((state) => ['ok', 'loading'].includes(state.status)))
      return null;
    return list.find((state) => state.error && !isParked(state))?.error ?? null;
  };
  /** The registry ids of the keys the asked networks lack, worldwide first. */
  const missingKeys = () => [
    ...new Set(
      worldwideFirst(asked())
        .filter(
          (entry) => entry.requiresKeyId && stateOf(entry).status === 'no-key',
        )
        .map((entry) => entry.requiresKeyId),
    ),
  ];
  /** Whether a key is all that stands between the layer and its stations. */
  const keyRequired = () =>
    _enabled && missingKeys().length > 0 && !asked().some(answered);
  const nextRetryAt = () => {
    const at = Math.min(
      ...asked().map((entry) => stateOf(entry).retryAt ?? Infinity),
    );
    return Number.isFinite(at) ? at : null;
  };
  /** Whether every asked provider that reported coverage calls it stale. */
  const coverageStale = () => {
    const list = asked()
      .map((entry) => stateOf(entry).coverage)
      .filter(Boolean);
    return list.length > 0 && list.every((item) => item.stale === true);
  };

  const notify = () => _panel?.invalidate();
  /**
   * Whether the page is hidden (a background tab): the retry loop, OpenAQ's
   * discovery every few seconds among it, waits until it is shown again.
   */
  const pageHidden = () => globalThis.document?.visibilityState === 'hidden';
  const armRetry = () => {
    clearTimeout(retryTimer);
    retryTimer = null;
    const at = _enabled && !pageHidden() ? nextRetryAt() : null;
    if (at === null) return;
    retryTimer = setTimeout(
      () => {
        retryTimer = null;
        // Only the providers whose cooldown has ended.
        const now = Date.now();
        void refresh(
          asked().filter((entry) => {
            const at = stateOf(entry).retryAt;
            return at !== null && at <= now;
          }),
        );
      },
      at - Date.now() + 100,
    );
  };
  const setRetry = (entry, at) => {
    stateOf(entry).retryAt =
      entry.viewDriven && _enabled && Number.isFinite(at)
        ? Math.min(Date.now() + 24 * 3600_000, Math.max(Date.now() + 1000, at))
        : null;
  };
  /** Abort every request and timer; loading states return to idle. */
  const halt = () => {
    for (const state of states.values()) {
      state.request?.abort();
      state.request = null;
      state.retryAt = null;
      if (state.status === 'loading') state.status = 'idle';
    }
    clearTimeout(retryTimer);
    retryTimer = null;
    clearTimeout(moveTimer);
    moveTimer = null;
    clearTimeout(ageTimer);
    ageTimer = null;
  };

  /** The camera's lon/lat rectangle in degrees, or null when unresolvable. */
  const viewRectangle = () =>
    _viewer ? (findCamera(_viewer)?.viewRectangle() ?? null) : null;

  const currentView = () => {
    const rect = viewRectangle();
    if (!rect) return null;
    const width = (rect.east - rect.west + 360) % 360 || 360;
    const lon = ((rect.west + width / 2 + 540) % 360) - 180;
    const canvas = canvasOf(_viewer);
    const focus =
      canvas &&
      findQuery(_viewer)?.pickEllipsoid(
        canvas.clientWidth / 2,
        canvas.clientHeight / 2,
      );
    const center = focus ? toLonLatH(focus) : null;
    const values = [
      rect.west,
      rect.south,
      rect.east,
      rect.north,
      center ? center.lon : lon,
      center ? center.lat : (rect.south + rect.north) / 2,
    ];
    const rounded = values.map((v) => Number(v.toFixed(4)));
    return rounded[0] === rounded[2] || rounded[1] >= rounded[3]
      ? values
      : rounded;
  };

  /**
   * Whether an observation time is recent enough to draw: no older than
   * `OBSERVATION_MAX_AGE_MS`, judged at the stations' time (now, or the past
   * hour asked, after which no reading is drawn), whether or not a fetch
   * succeeded since. A reading without a time is not aged.
   */
  const isCurrent = (ms) => {
    if (!Number.isFinite(ms)) return true;
    const at = stationsAt();
    return at === null
      ? Date.now() - ms <= OBSERVATION_MAX_AGE_MS
      : ms <= at && at - ms <= OBSERVATION_MAX_AGE_MS;
  };
  /** The time the stations' readings are aged at: now, or the past hour asked. */
  const readingsNow = () => stationsAt() ?? Date.now();
  /** An AQI-view station with its values too old to draw left out. */
  const currentValuesOf = (station) => {
    const times = station.valueTimes ?? {};
    const old = Object.keys(station.values ?? {}).filter(
      (key) => !isCurrent(times[key]),
    );
    if (!old.length)
      return station.valueTimes ? station : { ...station, valueTimes: times };
    const values = { ...station.values };
    const excluded = { ...station.excluded };
    for (const key of old) {
      delete values[key];
      excluded[key] = 'too-old';
    }
    return { ...station, values, excluded };
  };
  /**
   * One reading as the current view presents it. In the AQI view a station
   * gets its index from its plausible, recent values (`stationIndex`); its
   * time is then that of the pollutant
   * leading the index, and its averaging that of the values used. In every
   * view `band` is the reading's category on the view's scale (the US AQI
   * category, or the pollutant's EEA band), null when unrated.
   */
  const present = (reading) => {
    if (view !== 'aqi')
      return {
        ...reading,
        band: isRatedReading(reading, view) ? reading.assessment.label : null,
      };
    const result = stationIndex(currentValuesOf(reading));
    const aqi = result.aqi ?? null;
    const band = usAqiBand(aqi?.index);
    const used = result.used ?? {};
    const averaging = new Set(
      Object.keys(used).map((key) => reading.valueAveraging?.[key] ?? null),
    );
    return {
      ...reading,
      aqi: aqi ? { ...aqi, category: band.label } : null,
      aqiValues: used,
      aqiExcluded: result.excluded ?? {},
      observedMs: result.observedMs ?? reading.observedMs,
      averagingMinutes:
        reading.valueAveraging && averaging.size
          ? averaging.size === 1
            ? [...averaging][0]
            : null
          : reading.averagingMinutes,
      value: aqi?.index ?? null,
      band: aqi ? band.label : null,
      color: band?.color ?? AIR_QUALITY_UNRATED_COLOR,
      label: aqi ? aqiText(aqi.index) : '—',
    };
  };
  /** A reading's category on the view's scale, translated; '' if unrated. */
  const categoryText = (reading) => {
    if (!isRatedReading(reading, view)) return '';
    if (view === 'aqi')
      return bandLabel(usAqiBand(reading.aqi.index).label, 'US AQI category');
    return bandLabel(reading.assessment.label, 'EEA hourly quality');
  };
  /**
   * A station's US AQI for its details in the AQI view: the index, the
   * values it used, and the values left out and why.
   */
  const aqiDetails = (reading) => {
    const leading = reading.aqi?.leading;
    const index = !reading.aqi
      ? t('Index unavailable')
      : reading.valueMethods?.[leading] === 'nowcast'
        ? t('Calculated US AQI (NowCast) · main pollutant {pollutant}', {
            pollutant: AQI_PARAMETERS[leading],
          })
        : t('Calculated US AQI · main pollutant {pollutant}', {
            pollutant: AQI_PARAMETERS[leading],
          });
    const used = Object.entries(reading.aqiValues ?? {})
      .filter(([key, value]) => AQI_PARAMETERS[key] && Number.isFinite(value))
      .map(([key, value]) => {
        // A value pooled from another network at the site names it.
        const source = reading.valueSources?.[key];
        return source && source.provider !== reading.provider
          ? `${valueText(key, value)} (${
              source.network ||
              definitions.find((entry) => entry.id === source.provider)
                ?.network ||
              source.provider
            })`
          : valueText(key, value);
      })
      .join(', ');
    const excluded = Object.entries(reading.aqiExcluded ?? {})
      .filter(
        ([key, reason]) => AQI_PARAMETERS[key] && EXCLUSION_REASONS[reason],
      )
      .map(
        ([key, reason]) =>
          `${AQI_PARAMETERS[key]} (${t(EXCLUSION_REASONS[reason])})`,
      )
      .join(', ');
    return [
      index,
      used,
      excluded ? t('Not used: {values}', { values: excluded }) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  };
  /** A reading's comparison on the EEA hourly bands, or why it has none. */
  const pollutantDetails = (reading) =>
    reading.assessment?.label
      ? `${t('Calculated comparison')} · ${t(reading.assessment.method)} · ${reading.assessment.range}`
      : reading.assessment?.reason
        ? t(reading.assessment.reason)
        : t('Index unavailable');
  /**
   * Where a station's data comes from, for its tooltips: the originating
   * `network` and, where its source states them, the station's licences and
   * their holders (OpenAQ names them per station).
   */
  const licenceText = (reading) => {
    const names = new Set();
    for (const item of Array.isArray(reading?.licenses) ? reading.licenses : [])
      if (typeof item?.name === 'string' && item.name)
        names.add(
          item.attribution ? `${item.name} (${item.attribution})` : item.name,
        );
    // Three named; any more counted.
    return [
      ...[...names].slice(0, 3),
      ...(names.size > 3 ? [`+${names.size - 3}`] : []),
    ].join(', ');
  };
  const originText = (reading, network) => {
    const licences = licenceText(reading);
    return licences
      ? `${network} · ${t('Licence: {licence}', { licence: licences })}`
      : network;
  };
  /** Highest first on the view's scale: category, then the value itself. */
  const rankOf = (reading) =>
    !isRatedReading(reading, view)
      ? [-1, -1]
      : view === 'aqi'
        ? [reading.aqi.index, 0]
        : [
            reading.assessment.severity ?? -1,
            reading.assessment.concentration ?? 0,
          ];

  /**
   * A reading's number on the view's scale, for its group's mean: the index
   * in the AQI view, the concentration in a pollutant view; null unrated.
   */
  const scaleValue = (reading) =>
    !isRatedReading(reading, view)
      ? null
      : view === 'aqi'
        ? reading.aqi.index
        : (reading.assessment.concentration ?? null);
  /** The band colour of a value on the view's scale; unrated without one. */
  const bandColor = (value) => {
    if (!Number.isFinite(value)) return AIR_QUALITY_UNRATED_COLOR;
    if (view === 'aqi')
      return usAqiBand(value)?.color ?? AIR_QUALITY_UNRATED_COLOR;
    return (
      EEA_HOURLY_BANDS[hourlyBandIndex(view, value)]?.color ??
      AIR_QUALITY_UNRATED_COLOR
    );
  };
  /**
   * A reading's number on the view's scale as text; unrated, its value in
   * the view's unit when that converts, else a dash.
   */
  const scaleText = (reading) => {
    const value = scaleValue(reading);
    if (value !== null)
      return view === 'aqi' ? aqiText(value) : concentrationText(view, value);
    const converted =
      view === 'aqi'
        ? null
        : concentrationIn(view, reading.value, reading.units);
    return converted !== null ? concentrationText(view, converted) : NO_VALUE;
  };
  /**
   * A reading's value on its map label: in a pollutant view in the view's
   * unit, as the card gives it (µg/m³, CO mg/m³); otherwise, or when its
   * units do not convert, its own label.
   */
  const mapLabelValue = (reading) => {
    if (!AIR_QUALITY_POLLUTANT_VIEWS.includes(view)) return reading.label;
    const text = scaleText(reading);
    return text === NO_VALUE ? reading.label : `${text} ${layerUnits(view)}`;
  };
  /** The view centre in degrees, or null when the camera has no view. */
  const viewCentre = () => {
    const values = currentView();
    return values ? { lon: values[4], lat: values[5] } : null;
  };
  /**
   * Return the nearest station, preferring rated candidates, and whether a
   * nearer unrated station was passed over (`skippedCloser`). Without a
   * view centre or a candidate, return null.
   */
  const nearestStation = (candidates) => {
    const centre = viewCentre();
    if (!centre) return null;
    const cos = Math.cos((centre.lat * Math.PI) / 180);
    let best = null;
    let closest = null;
    for (const reading of candidates) {
      const rated = isRatedReading(reading, view);
      const dLon = ((reading.lon - centre.lon + 540) % 360) - 180;
      const distance = (reading.lat - centre.lat) ** 2 + (dLon * cos) ** 2;
      if (!closest || distance < closest.distance)
        closest = { reading, distance };
      if (
        !best ||
        (rated && !best.rated) ||
        (rated === best.rated && distance < best.distance)
      )
        best = { reading, rated, distance };
    }
    return best
      ? {
          reading: best.reading,
          skippedCloser: best.distance > closest.distance,
        }
      : null;
  };
  /**
   * Values at the view centre from the model field, as the map shows them
   * (`sampleField`), `{ aqi, values }` with `values` by pollutant view id;
   * null without a field step for the time shown, without a view, or where
   * the field has no value at all.
   */
  const fieldValues = () => {
    if (!fieldSource || !fieldReady()) return null;
    const centre = viewCentre();
    if (!centre) return null;
    const read = (id) => {
      const value = sampleField(
        field.manifest,
        field.data.grids,
        id,
        centre.lon,
        centre.lat,
      );
      return Number.isFinite(value) ? value : null;
    };
    const aqi = read('aqi');
    const values = Object.fromEntries(
      AIR_QUALITY_POLLUTANT_VIEWS.map((id) => [id, read(fieldIdOf(id))]),
    );
    if (aqi === null && Object.values(values).every((value) => value === null))
      return null;
    return { aqi: aqi === null ? null : Math.round(aqi), values };
  };
  /** The remembered AQI-view stations no older than `REMEMBERED_MS`. */
  const rememberedStations = () =>
    [...aqiMemory.values()]
      .filter(({ at }) => Date.now() - at <= REMEMBERED_MS)
      .flatMap(({ readings }) => readings);
  /**
   * A station's latest AQI-view reading (`aqiMemory`) with its index as the
   * AQI view computes it, or null: not remembered, remembered too long or
   * unrated. A value measured more than `OBSERVATION_MAX_AGE_MS` ago is left
   * out, as the AQI view leaves it out (`currentValuesOf`).
   */
  const rememberedStation = (reading) => {
    if (!reading) return null;
    const key = stationKey(reading);
    const station = rememberedStations().find(
      (item) => stationKey(item) === key,
    );
    if (!station) return null;
    const result = stationIndex(currentValuesOf(station));
    return { station, aqi: result.aqi?.index ?? null, used: result.used };
  };
  /**
   * A pollutant value's EEA hourly band by the map's own rule
   * (`interpretHourly`): only a one-hour average, complete and unflagged;
   * otherwise null.
   */
  const tileBand = (parameter, value, facts) => {
    const { assessment } = interpretHourly({
      parameter,
      value,
      units: layerUnits(parameter),
      averagingMinutes: facts.averagingMinutes ?? null,
      coveragePercent: facts.coveragePercent,
      qualityFlagged: facts.qualityFlagged === true,
    });
    return assessment?.label ? EEA_HOURLY_BANDS[assessment.severity] : null;
  };
  /**
   * One pollutant at a station: its value in the layer's units and the
   * facts its band needs, from the station's reading in this view (`live`)
   * or else its latest AQI-view values (`remembered`); null when neither
   * has it.
   */
  const pollutantAt = (id, live, remembered) => {
    const key = AQI_POLLUTANTS[id];
    // A pollutant's tile reads its newest hourly mean, as its own view
    // does, where the index used one of its values; the index itself may
    // rest on a NowCast or a longer average.
    if (
      live?.aqiValues &&
      Number.isFinite(live.aqiValues[key]) &&
      Number.isFinite(live.hourValues?.[key])
    )
      return {
        value: live.hourValues[key],
        averagingMinutes: 60,
      };
    if (live?.aqiValues && Number.isFinite(live.aqiValues[key]))
      return {
        value: live.aqiValues[key],
        averagingMinutes: live.valueAveraging?.[key],
        coveragePercent: live.valueCoverage?.[key],
      };
    if (live && live.parameter === id) {
      // The view's own reading decides its tile, as it decides its row: a
      // flagged value shows unbanded.
      const value = concentrationIn(id, live.value, live.units);
      if (value === null) return null;
      return {
        value,
        averagingMinutes: live.averagingMinutes,
        coveragePercent: live.coveragePercent,
        qualityFlagged: live.qualityFlagged === true,
      };
    }
    const value = remembered?.used?.[key];
    if (!Number.isFinite(value)) return null;
    const hour = remembered.station.hourValues?.[key];
    if (Number.isFinite(hour)) return { value: hour, averagingMinutes: 60 };
    return {
      value,
      averagingMinutes: remembered.station.valueAveraging?.[key],
      coveragePercent: remembered.station.valueCoverage?.[key],
    };
  };
  /**
   * The card's two groups of tiles: the index (the US AQI, the one index),
   * then the pollutants. Each tile is a view: its value at the selected
   * station, else from a model field at the view centre, else at the
   * station in view nearest the centre (`candidates`); a click puts that view
   * on the map. A station's reading in this view comes first, its latest
   * AQI-view values fill the rest. While a view loads, the station shown
   * before stays.
   */
  const tileGroups = (selected, candidates, loading) => {
    const model = selected ? null : fieldValues();
    let station = selected;
    let skippedCloser = false;
    if (!station && !model) {
      let nearest = nearestStation(candidates);
      if (!nearest && loading) nearest = lastNearest;
      lastNearest = nearest;
      station = nearest?.reading ?? null;
      skippedCloser = nearest?.skippedCloser === true;
    }
    const live = station && _readings.includes(station) ? station : null;
    const remembered = rememberedStation(station);
    const tile = (id, label, value, band, context, text) => {
      const category = band ? bandLabel(band.label, context) : '';
      return {
        id,
        value: value === null ? NO_VALUE : text(value),
        // The band in words rides beside the value; long names shortened.
        note: band ? bandLabel(band.short ?? band.label, context) : '',
        label,
        title: category ? `${label} · ${category}` : label,
        accent:
          band?.color ??
          (value === null
            ? AIR_QUALITY_UNKNOWN_COLOR
            : AIR_QUALITY_UNRATED_COLOR),
        active: view === id,
        params: { view: id },
      };
    };
    // The US AQI keeps its latest-value method (`usAqi.js`).
    const aqi = model
      ? (model.aqi ?? null)
      : view === 'aqi' && Number.isFinite(live?.aqi?.index)
        ? live.aqi.index
        : (remembered?.aqi ?? null);
    const indexTiles = [
      tile('aqi', AQI_NAME, aqi, usAqiBand(aqi), 'US AQI category', aqiText),
    ];
    const pollutantTiles = AIR_QUALITY_POLLUTANT_VIEWS.filter((id) =>
      views.includes(id),
    ).map((id) => {
      const text = (number) => concentrationText(id, number);
      if (model) {
        // A model's value is an hourly field: banded as it stands.
        const value = model.values?.[id] ?? null;
        return tile(
          id,
          POLLUTANT_TILE_LABELS[id],
          value,
          value === null
            ? null
            : (EEA_HOURLY_BANDS[hourlyBandIndex(id, value)] ?? null),
          'EEA hourly quality',
          text,
        );
      }
      const at = pollutantAt(id, live, remembered);
      return tile(
        id,
        POLLUTANT_TILE_LABELS[id],
        at?.value ?? null,
        at ? tileBand(id, at.value, at) : null,
        'EEA hourly quality',
        text,
      );
    });
    return [
      {
        id: 'index',
        title: t('Index'),
        // Where the numbers come from: a station's instruments, a model at
        // the middle of the view, or the station nearest it.
        subtitle: selected
          ? t('calculated from the station')
          : model
            ? t('model at view centre')
            : station
              ? skippedCloser
                ? t('nearest rated station · {name}', { name: station.name })
                : t('nearest station · {name}', { name: station.name })
              : '',
        tiles: indexTiles,
      },
      {
        id: 'pollutants',
        title: t('Pollutants'),
        // The units live here once, not on every tile.
        subtitle: POLLUTANT_UNITS,
        tiles: pollutantTiles,
      },
    ];
  };
  /** The view's size and ellipsoid pick, or null when it cannot be measured. */
  const screen = () => {
    const canvas = _viewer ? canvasOf(_viewer) : null;
    const query = _viewer ? findQuery(_viewer) : null;
    if (!canvas || typeof query?.pickEllipsoid !== 'function') return null;
    return {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      pickEllipsoid: (x, y) => query.pickEllipsoid(x, y),
    };
  };

  /**
   * Draw the stations: where they would overlap on screen, one group each
   * (`groups.js`), worked out again after every camera move. A scene that
   * cannot be measured draws every station on its own.
   */
  const drawPoints = () => {
    if (!_points) return;
    _drawn = new Map();
    _labelled = new Set();
    const measured = screen();
    /** A station's part in its group's mean: an index counts up to 500. */
    const groupValue = (reading) => {
      const value = scaleValue(reading);
      return view === 'aqi' && value !== null
        ? Math.min(AQI_SHOWN_MAX, value)
        : value;
    };
    const groups = measured
      ? groupStations(
          _readings.map((reading) => ({
            id: reading.id,
            lat: reading.lat,
            lon: reading.lon,
            value: groupValue(reading),
            reading,
          })),
          cellDegAt(measured),
          { selectedId: selectedStation },
        )
      : _readings.map((reading) => ({ members: [{ reading }] }));
    const items = [];
    for (const group of groups) {
      if (group.members.length === 1) {
        const { reading } = group.members[0];
        const selected = reading.id === selectedStation;
        const id = `air-quality:${reading.id}`;
        const px = selected ? SELECTED_STATION_PX : STATION_PX;
        _drawn.set(id, { id, reading, lon: reading.lon, lat: reading.lat, px });
        _labelled.add(reading.id);
        items.push({
          id,
          pos: { lon: reading.lon, lat: reading.lat, height: 0 },
          pixelSize: px,
          color: reading.color,
          outlineColor: selected ? SELECTED_OUTLINE : '#000000',
          outlineWidth: selected ? SELECTED_OUTLINE_WIDTH : 1,
          height: 'clampGround',
          meta: {
            value: reading.value,
            label: reading.label,
            observedMs: reading.observedMs,
            aqiExcluded: reading.aqiExcluded,
            id: reading.id,
            provider: reading.provider,
            stationId: reading.stationId,
            name: reading.name,
            parameter: reading.parameter,
            aqi: reading.aqi,
            assessment: reading.assessment,
          },
        });
        continue;
      }
      // One bubble: the band colour of its members' mean, its size growing
      // with their number.
      const id = `air-quality-group:${group.members[0].id}:${group.members.length}`;
      const px = Math.round(12 + 6 * Math.log10(group.members.length));
      _drawn.set(id, { id, group, lon: group.lon, lat: group.lat, px });
      items.push({
        id,
        pos: { lon: group.lon, lat: group.lat, height: 0 },
        pixelSize: px,
        color: bandColor(group.mean),
        outlineColor: GROUP_OUTLINE,
        outlineWidth: GROUP_OUTLINE_WIDTH,
        height: 'clampGround',
      });
    }
    _points.set(items);
  };

  /**
   * Fly in to where a group's stations come apart, selecting nothing; when
   * that would zoom out, or they never come apart, select the highest of
   * them instead (`groupTarget`).
   */
  const openGroup = (group) => {
    const target = groupTarget(group.members, viewRectangle());
    if (target.rect) {
      const fly = () =>
        findCamera(_viewer)?.flyTo(
          { rect: target.rect },
          { durationS: GROUP_FLIGHT_S },
        );
      // Through the shell's navigation handoff when there is one, so a
      // tracked entity lets the camera go.
      if (runNavigation) runNavigation(() => (_enabled ? fly() : undefined));
      else fly();
    } else layer.setParams({ station: target.station.id });
  };

  /** One of this layer's drawn points, by a hit on it. */
  const drawnOf = (hit) =>
    hit && !hit.surface && hit.set === _points?.id
      ? (_drawn.get(hit.id) ?? null)
      : null;
  /** The drawn point within its radius and a few pixels of a click. */
  const drawnNear = (event) => {
    const at = event.position ?? event.screenPosition;
    const query = findQuery(_viewer);
    if (!at || typeof query?.pickEllipsoid !== 'function') return null;
    const here = query.pickEllipsoid(at.x, at.y);
    const side = here ? query.pickEllipsoid(at.x + 10, at.y) : null;
    return nearestItem(
      [..._drawn.values()],
      here && toLonLatH(here),
      side && toLonLatH(side),
    );
  };
  /**
   * A click on open map within a few pixels of a drawn station or group,
   * claimed so other layers leave it alone (`registerClickClaim`).
   */
  const claimNear = (click) => {
    if (!_enabled || !showStations || !_points || !_viewer) return null;
    if (!click?.surface || !stationsShown()) return null;
    if (pointer && !pointer.isPointerFree()) return null;
    if (!isTrackingSelectionGesture(click.gesture)) return null;
    const item = drawnNear(click);
    return item ? { sourceId: STATION_CLICK_SOURCE, entryId: item.id } : null;
  };

  /**
   * A click on a group flies to it; on a station, selects it; on open map,
   * lets go of the selected station. A card painted on top takes the click.
   */
  const onClick = (event) => {
    if (!_enabled || !showStations || !_points || !_viewer) return;
    // With no station drawn at the layer's time, none takes a click.
    if (!stationsShown()) return;
    if (pointer && !pointer.isPointerFree()) return;
    if (!isTrackingSelectionGesture(event?.gesture)) return;
    const card = picking?.clickCard?.(event);
    if (card && card.sourceId !== STATION_CLICK_SOURCE) return;
    // The renderer's exact pick, a touch's widened one, then, over open map,
    // a station or group within a few pixels: a 7 px dot is a small target.
    const item =
      drawnOf(event.drawHit) ??
      drawnOf(event.hit) ??
      (event.surface ? drawnNear(event) : null);
    if (item?.group) {
      openGroup(item.group);
      return;
    }
    if (item?.reading) {
      layer.setParams({ station: item.reading.id });
      return;
    }
    if (
      event.surface &&
      selectedStation !== null &&
      isTrackingClickGesture(event.gesture)
    )
      layer.setParams({ station: null });
  };

  /**
   * Keep the selected station selected across views: its reading id names
   * the view, so it is found again by its station (`stationKey`).
   */
  const followSelection = () => {
    if (selectedStation === null) {
      selectedSeen = null;
      return;
    }
    const seen = (reading) => {
      selectedKey = stationKey(reading);
      selectedSeen = {
        reading,
        network: reading.network || ownerOf(reading).network,
      };
    };
    const current = _readings.find((reading) => reading.id === selectedStation);
    if (current) {
      seen(current);
      return;
    }
    const same =
      selectedKey &&
      _readings.find((reading) => stationKey(reading) === selectedKey);
    if (same) {
      selectedStation = same.id;
      seen(same);
      return;
    }
    // Another network's copy of the site won the merge: the selection moves to it.
    for (const [dropped, kept] of replacedBy)
      if (
        dropped.id === selectedStation ||
        (selectedKey && stationKey(dropped) === selectedKey)
      ) {
        selectedStation = kept.id;
        seen(kept);
        return;
      }
  };

  /**
   * Merge every asked provider's readings into the drawn set. A reading (in
   * the AQI view, a value) older than `OBSERVATION_MAX_AGE_MS` is left out,
   * and the set is merged again when the next one turns that old
   * (`armAgeOut`), so nothing stale stays drawn while no fetch succeeds.
   */
  const apply = () => {
    owners = new WeakMap();
    const at = stationsAt();
    const lists = asked().map((entry) => ({
      provider: entry.id,
      direct: entry.direct === true,
      // Only readings answered for the stations' time are drawn.
      readings: (stateOf(entry).answeredAt === at
        ? stateOf(entry).readings
        : []
      ).flatMap((raw) => {
        const reading = present(raw);
        if (!isCurrent(reading.observedMs)) return [];
        owners.set(reading, entry);
        return [reading];
      }),
    }));
    replacedBy = new Map();
    _readings = mergeObservations(lists, {
      view,
      replaced: replacedBy,
      // In the AQI view a site's networks pool their pollutants, each the
      // freshest one, and its index is computed from them.
      combine:
        view === 'aqi'
          ? (kept, others) => {
              const station = present(mergeStationValues(kept, others));
              owners.set(station, owners.get(kept));
              return station;
            }
          : undefined,
    });
    followSelection();
    syncVisibility();
    layer._render();
    armAgeOut();
  };

  /** Merge again when the next drawn reading or value turns too old. */
  const armAgeOut = () => {
    clearTimeout(ageTimer);
    ageTimer = null;
    // At a past hour readings are aged against the hour, not the wall
    // clock: nothing ages out while it is shown.
    if (!_enabled || stationsAt() !== null) return;
    let next = Infinity;
    for (const entry of asked())
      for (const raw of stateOf(entry).readings) {
        const times = [
          raw.observedMs,
          ...Object.keys(raw.values ?? {}).map((key) => raw.valueTimes?.[key]),
        ];
        for (const ms of times)
          if (Number.isFinite(ms) && isCurrent(ms))
            next = Math.min(next, ms + OBSERVATION_MAX_AGE_MS);
      }
    if (!Number.isFinite(next)) return;
    ageTimer = setTimeout(
      () => {
        ageTimer = null;
        if (_enabled) {
          apply();
          notify();
        }
      },
      Math.max(0, next - Date.now()) + 1000,
    );
    // Under Node (tests, tools) a pending age-out keeps no process alive.
    ageTimer?.unref?.();
  };

  /** Ask one provider; its answer lands in its own state only. */
  const run = async (entry, state, request, rect) => {
    const asking = requestFor();
    try {
      const readings = await source.getSnapshot({
        signal: request.signal,
        provider: entry.id,
        ...asking,
        ...(rect ? { view: rect } : {}),
      });
      // A superseded or aborted request must not touch the scene, and neither
      // must one that lands after the layer was switched off.
      if (request.signal.aborted || state.request !== request || !_enabled)
        // A newer request owns acquisition. This is not a failed layer
        // enable: the lifecycle manager must keep the layer and its refresh
        // loop on.
        return _enabled;
      const list = Array.isArray(readings) ? readings : [];
      // The AQI view draws one reading per station with all its values.
      const rows = asking.mode === 'aqi' ? aqiStations(list) : list;
      // A row the layer cannot present is left out, so it never stops this
      // provider's other rows, or another provider's, being drawn.
      const usable = rows.filter((row) => {
        try {
          present(row);
          return true;
        } catch {
          return false;
        }
      });
      if (usable.length < rows.length)
        console.warn(
          `[Data:AirQuality] Left out ${rows.length - usable.length} malformed rows (${entry.id})`,
        );
      const coverage = source.getCoverage?.(entry.id) ?? null;
      state.request = null;
      state.status = 'ok';
      state.settled = true;
      state.keyRejected = false;
      state.rateLimited = false;
      state.error = null;
      parked.delete(entry.id);
      state.readings = usable;
      // Answered for the hour asked only when the source says so: one that
      // answers only now draws nothing away from it.
      state.answeredAt =
        asking.atMs === undefined
          ? null
          : coverage?.atMs === asking.atMs
            ? asking.atMs
            : undefined;
      if (asking.mode === 'aqi' && asking.atMs === undefined)
        aqiMemory.set(entry.id, { at: Date.now(), readings: usable });
      state.coverage = coverage;
      setRetry(entry, coverage?.retryAt);
      _lastUpdate = Date.now();
      apply();
      return true;
    } catch (error) {
      if (request.signal.aborted || state.request !== request) return _enabled;
      state.request = null;
      state.settled = true;
      // A key the network refused: the card says to check it.
      state.keyRejected = error?.code === 'key_rejected';
      state.rateLimited = error?.code === 'rate_limited';
      // Earlier readings stay drawn: a failed refresh is degraded, not empty.
      state.status =
        error?.code === 'no_key'
          ? 'no-key'
          : error?.code === 'not_configured'
            ? 'disabled'
            : 'failed';
      if (isParked(state))
        parked.set(entry.id, { status: state.status, at: Date.now() });
      // A network this server leaves off says nothing on the card.
      state.error =
        state.status === 'disabled'
          ? null
          : (error?.code === 'no_key'
              ? keyRequirementText(entry.requiresKeyId)
              : '') ||
            error?.message ||
            msg('Air quality request failed');
      setRetry(entry, error?.retryAt);
      if (!isParked(state))
        console.warn(
          `[Data:AirQuality] Refresh failed (${entry.id}):`,
          state.error,
        );
      // "No key" and "disabled" are guidance, not a failure: the layer stays
      // on and says so (`firstAnswer`).
      if (isParked(state)) return 'parked';
      return state.retryAt !== null;
    } finally {
      armRetry();
      notify();
    }
  };

  /** Whether a model field may show: a run held, or one being asked for. */
  const fieldAnswering = () =>
    !field.absent &&
    (field.manifest !== null || field.manifestRequest !== null);
  /**
   * True as soon as one provider answers (`run` resolves true), or after
   * `FIRST_ANSWER_CAP_MS` while some are still asking; otherwise, once all
   * have settled, true when one of them needs a key or is off on this server
   * (`run` resolves `'parked'`: guidance, not a failure), else whether the
   * layer may still show something (`fallback()`, read once all have settled).
   */
  const firstAnswer = (jobs, fallback) =>
    new Promise((resolve) => {
      if (!jobs.length) {
        resolve(fallback());
        return;
      }
      let left = jobs.length;
      let guided = false;
      const timer = setTimeout(() => resolve(true), FIRST_ANSWER_CAP_MS);
      const settle = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      for (const job of jobs)
        job.then((ok) => {
          if (ok === true) settle(true);
          else {
            if (ok === 'parked') guided = true;
            if (--left === 0) settle(guided || fallback());
          }
        });
    });

  /**
   * Ask the given providers in parallel. Resolves on the first answer, or
   * after a few seconds while all are still asking; the others keep loading
   * and land in their own state.
   */
  const refresh = async (entries) => {
    if (!_enabled || !_points) return false;
    if (moveTimer) {
      // A pending camera refresh is folded into this one.
      clearTimeout(moveTimer);
      moveTimer = null;
      entries = [
        ...new Set([
          ...entries,
          ...asked().filter((e) => e.viewDriven && !parkedStatus(e)),
        ]),
      ];
    }
    const rect = currentView();
    const requestedView = JSON.stringify(rect);
    stationsKey = timeKey();
    let waiting = false;
    const jobs = [];
    for (const entry of entries) {
      const state = stateOf(entry);
      state.request?.abort();
      state.request = null;
      state.retryAt = null;
      state.status = 'loading';
      state.error = null;
      state.requestedAt = stationsAt();
      if (entry.viewDriven) {
        state.requestedView = requestedView;
        // A camera that is still restoring its share-link position has no
        // useful viewport yet. Never turn that transient state into a global
        // API sweep; the provider waits, idle, for the camera's next move.
        if (!rect) {
          state.status = 'idle';
          waiting = true;
          continue;
        }
      }
      const request = new AbortController();
      state.request = request;
      jobs.push(run(entry, state, request, entry.viewDriven ? rect : null));
    }
    armRetry();
    notify();
    // A provider still waiting for a view may yet answer; a network left
    // alone because it needs its key (or is off here) is guidance, not a
    // failure; and while another view is on offer, a layer whose networks all
    // failed stays on, saying so.
    const guided = asked().some(
      (entry) => !entries.includes(entry) && isParked(stateOf(entry)),
    );
    return firstAnswer(
      jobs,
      () =>
        !entries.length ||
        waiting ||
        guided ||
        otherViewOnOffer() ||
        fieldAnswering(),
    );
  };

  // ── the model field ─────────────────────────────────────────────────────

  /** Whether the layer draws the present: the clock is live, or it does not follow it. */
  const liveTime = () => !clock.follows(CLOCK_ID) || clock.isLive();
  /** The step drawn at the layer's time, or null (no run, or outside it). */
  const shownStep = () =>
    field.manifest ? fieldStepAt(field.manifest, layerTime()) : null;
  /** The three hours of the layer's time, for asks outside the run. */
  const bucketOf = (ms) => Math.floor(ms / FIELD_ASK_BUCKET_MS);
  /**
   * Whether the layer shows now: the stations' time. Following the clock, the
   * step it shows must be the one nearest now.
   */
  const atNow = () => {
    if (liveTime()) return true;
    const step = shownStep();
    return (
      step !== null &&
      step === fieldStepAt(field.manifest, clock.wallNow()) &&
      Math.abs(layerTime() - clock.wallNow()) <= STATIONS_NOW_MS
    );
  };
  /**
   * The hour the stations are asked for: null for now (the clock live, the
   * layer not following it, or its time within the current hour or ahead of
   * it); otherwise the start of the layer time's hour, whose readings are the
   * hourly means ending by then.
   */
  const stationsAt = () => {
    if (liveTime()) return null;
    const hour = Math.floor(layerTime() / HOUR_MS) * HOUR_MS;
    return hour < Math.floor(clock.wallNow() / HOUR_MS) * HOUR_MS ? hour : null;
  };
  /**
   * Whether stations belong at the layer's time: a past hour, or now (with a
   * field, the step nearest now; without one, any time of this hour up to
   * now). Ahead of now nothing is measured yet.
   */
  const stationsTimely = () =>
    stationsAt() !== null ||
    atNow() ||
    (!fieldOn() && layerTime() <= clock.wallNow());
  /**
   * Whether the stations show: at a time they belong to, and away from now
   * once a provider answered for that hour.
   */
  const stationsShown = () => {
    if (!stationsTimely()) return false;
    const at = stationsAt();
    return at === null || asked().some((e) => stateOf(e).answeredAt === at);
  };
  /** The stations' time as the clock moves: the hour asked, or none. */
  const timeKey = () => (stationsTimely() ? String(stationsAt()) : 'none');
  /**
   * The clock moved the stations to another hour (or to now, or to a time
   * with none): drop what no longer belongs and ask for the new hour.
   */
  const followTime = () => {
    const key = timeKey();
    if (key === stationsKey) return;
    stationsKey = key;
    apply();
    // Ahead of now nothing is asked; what is in flight lands unshown.
    if (key !== 'none')
      void refresh(asked().filter((entry) => !isParked(stateOf(entry))));
    notify();
  };
  /** Whether the model field is on the map: a run held. */
  const fieldOn = () => _enabled && field.manifest !== null;
  /** The loaded step, when it is the one the layer's time shows. */
  const fieldReady = () => {
    const step = shownStep();
    return (
      step !== null &&
      field.data?.run === field.manifest.run &&
      field.data.step === step &&
      field.data.layout === fieldLayout(field.manifest)
    );
  };
  /** A loaded step's painted images of `id`, known by what they are painted from. */
  const paintKey = (data, id) =>
    `${data.run}|${data.step}|${id}|${data.layout}|${gridFingerprint(
      data.grids.global[id],
    )}|${gridFingerprint(data.grids.europe?.[id])}`;
  /** Whether the step the layer's time shows failed to load. */
  const shownStepFailed = () =>
    field.manifest !== null &&
    field.failedStep === `${field.manifest.run}|${shownStep()}`;
  /** Whether the card speaks for the model: a step of its run at this time. */
  const modelShown = () => fieldOn() && shownStep() !== null;
  /** The span the timeline can show: the run's first step to its last. */
  const coverage = () => (fieldOn() ? fieldCoverage(field.manifest) : null);

  /** Follow the clock while the field is on; tell it of a new span. */
  const syncClock = () => {
    const on = fieldOn();
    // Registered once a field is first on the map; off, it covers no time.
    if (on && !uncover) uncover = clock.register({ id: CLOCK_ID, coverage });
    if (on && !releaseHold) releaseHold = clock.hold(CLOCK_ID);
    else if (!on && releaseHold) {
      releaseHold();
      releaseHold = null;
    }
    const key = JSON.stringify(coverage());
    if (key === coverageKey) return;
    coverageKey = key;
    clock.coverageChanged();
  };

  /**
   * A host's model field carries its own credit (its licence may ask for
   * exact wording): it joins the data credits once a run is read and stays
   * for the session; a new wording from the same source replaces it.
   */
  const creditField = (manifest) => {
    if (!manifest.credit || !_viewer) return;
    const html = manifest.credit
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    registerCredit(_viewer, {
      key: `air-quality-field|${manifest.sourceShort || manifest.source || 'model'}`,
      html,
    });
  };

  /** Let go of the run held, and of its step. */
  const dropRun = () => {
    cancelAhead();
    fieldDrawing?.forget();
    field.manifest = null;
    field.data = null;
    field.failedStep = null;
    cancelStep();
  };
  /**
   * Back at now holding a run asked for another time, the newest run is
   * asked for at once, whether or not the run held covers now (an older one
   * may, with a shorter forecast). Keep a run that covers now or starts later.
   * An expired run also stays while the clock is away from live at a time
   * the run covers.
   */
  const expireRun = () => {
    const live = liveTime();
    const returned = live && !field.wasLive;
    field.wasLive = live;
    const held = field.manifest;
    if (!held || !live) return;
    if (returned && field.heldFor !== 'now') field.asks.delete('now');
    const wallNow = clock.wallNow();
    if (fieldStepAt(held, wallNow) !== null) return;
    // A run that starts later stays: its span is on the timeline until now reaches it.
    if (wallNow < fieldCoverage(held).start) return;
    // The clock is away from live (paused or playing) at a time the run covers:
    // the layer follows it there (`syncClock` holds the clock) instead.
    if (!clock.isLive() && fieldStepAt(held, clock.now()) !== null) return;
    if (field.heldFor !== 'now') field.asks.delete('now');
    dropRun();
  };

  /**
   * Ask the host for the run to show: at now the newest, asked again every
   * `FIELD_MANIFEST_MS`; away from now, when the run held does not cover the
   * layer's time, the run covering it (`atMs`), once per three hours of it.
   * A failed ask is tried again after `FIELD_RETRY_MS`.
   */
  const askManifest = () => {
    if (field.absent || !_enabled) return;
    const live = liveTime();
    const time = layerTime();
    const held = field.manifest;
    const covered =
      held !== null &&
      held.run !== field.goneRun &&
      fieldStepAt(held, time) !== null;
    // Nothing to ask away from now inside the run held.
    const want = live ? 'now' : covered ? null : bucketOf(time);
    if (field.manifestRequest) {
      if (field.manifestWant === want) return;
      // Playing on, an ask for an earlier time stays: an archive may answer
      // after more than three hours of play. A seek lets it go.
      if (
        typeof want === 'number' &&
        typeof field.manifestWant === 'number' &&
        clock.isPlaying() &&
        clock.getState().jumps === field.manifestJumps
      )
        return;
      // An ask for another time is let go: its answer would replace the run
      // this time needs. Its span may be asked again later.
      field.manifestRequest.abort();
      field.manifestRequest = null;
      field.asks.delete(field.manifestWant);
    }
    if (want === null) return;
    if (Date.now() < (field.asks.get(want) ?? 0)) return;
    // Only the recent spans are remembered.
    if (field.asks.size > 64) field.asks.clear();
    field.asks.set(want, Infinity);
    const request = new AbortController();
    field.manifestRequest = request;
    field.manifestWant = want;
    field.manifestJumps = clock.getState().jumps;
    Promise.resolve()
      .then(() =>
        fieldSource.getManifest({
          signal: request.signal,
          ...(live ? {} : { atMs: time }),
        }),
      )
      .then((raw) => {
        if (field.manifestRequest !== request) return;
        const manifest = readFieldManifest(raw);
        // A span the world clock cannot hold is not put on the timeline.
        const span = fieldCoverage(manifest);
        if (!isWorldTime(span.start) || !isWorldTime(span.end))
          throw Object.assign(
            new Error('Air-quality field run outside the clock'),
            {
              code: 'malformed',
            },
          );
        // Played past the time asked for, a run that does not cover the time
        // now is not taken; the time now is asked for.
        if (
          typeof want === 'number' &&
          bucketOf(layerTime()) !== want &&
          fieldStepAt(manifest, layerTime()) === null
        ) {
          field.asks.delete(want);
          return;
        }
        const replaced = field.manifest?.run !== manifest.run;
        // Grids read under other scales or geometry are loaded again.
        const relaid =
          !replaced && fieldLayout(field.manifest) !== fieldLayout(manifest);
        field.manifest = manifest;
        if (relaid) cancelAhead();
        // A span answered by the run let go may be asked again; a failed one keeps its wait.
        if (replaced) {
          cancelAhead();
          fieldDrawing?.forget();
          for (const [key, at] of field.asks)
            if (at === Infinity && key !== want) field.asks.delete(key);
        }
        creditField(manifest);
        field.heldFor = want;
        field.manifestFailed = false;
        field.manifestUnavailable = false;
        field.everRead = true;
        // At now the newest run is asked again later; a span away from now
        // is not asked again.
        if (want === 'now')
          field.asks.set(want, Date.now() + FIELD_MANIFEST_MS);
        // A step of another run or layout is not drawn once this run is held.
        if (
          field.stepRequest &&
          (relaid || field.stepRequest.run !== manifest.run)
        )
          cancelStep();
      })
      .catch((error) => {
        if (field.manifestRequest !== request) return;
        if (error?.code === 'not_configured') {
          // The host has no field (any more): the layer is as without one.
          field.absent = true;
          dropRun();
          return;
        }
        field.manifestFailed = true;
        field.manifestUnavailable = error?.code === 'unavailable';
        field.asks.set(want, Date.now() + FIELD_RETRY_MS);
        console.warn(
          '[Data:AirQuality] Model field manifest failed:',
          failureReason(error),
        );
      })
      .finally(() => {
        if (field.manifestRequest !== request) return;
        field.manifestRequest = null;
        syncField();
        notify();
      });
  };

  const cancelStep = () => {
    field.stepRequest?.controller.abort();
    field.stepRequest = null;
    releaseWait?.();
    releaseWait = null;
  };

  /**
   * Playing, hold the clock until the step it is about to show has loaded,
   * as weather does, but never longer than `FIELD_WAIT_MS`.
   */
  const waitForStep = () => {
    if (!clock.follows(CLOCK_ID) || !clock.isPlaying()) return false;
    const release = clock.wait(CLOCK_ID);
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      release();
      if (releaseWait === done) releaseWait = null;
    };
    timer = setTimeout(done, FIELD_WAIT_MS);
    releaseWait = done;
    return true;
  };

  /** The request may become the shown step while a prefetch is in flight. */
  const startStep = (manifest, step) => {
    const key = `${manifest.run}|${step}`;
    const request = {
      run: manifest.run,
      step,
      held: false,
      controller: new AbortController(),
    };
    Promise.resolve()
      .then(() =>
        fieldSource.getStep(step, {
          signal: request.controller.signal,
          run: request.run,
        }),
      )
      .then((raw) => {
        if (field.stepRequest !== request && field.aheadRequest !== request)
          return;
        const data = {
          run: request.run,
          step,
          layout: fieldLayout(manifest),
          grids: readFieldStep(manifest, step, raw),
        };
        if (field.stepRequest === request) {
          field.data = data;
          if (field.failedStep === key) field.failedStep = null;
        } else field.ahead = data;
      })
      .catch((error) => {
        const shown = field.stepRequest === request;
        if (field.aheadRequest === request) field.failedAhead = key;
        if (
          error?.code === 'run_changed' &&
          (shown || field.aheadRequest === request)
        ) {
          // The host no longer has the run held: the run for the layer's
          // time is asked for at once, even where the old one covered it.
          field.goneRun = request.run;
          field.asks.delete('now');
          field.asks.delete(bucketOf(layerTime()));
          if (!shown) askManifest();
        }
        if (!shown) return;
        field.failedStep = key;
        field.retryStepAt = Date.now() + FIELD_RETRY_MS;
        console.warn(
          '[Data:AirQuality] Model field step failed:',
          failureReason(error),
        );
      })
      .finally(() => {
        if (field.aheadRequest === request) {
          field.aheadRequest = null;
          paintAheadLater();
          return;
        }
        if (field.stepRequest !== request) return;
        field.stepRequest = null;
        releaseWait?.();
        releaseWait = null;
        syncField();
        notify();
      });
    return request;
  };

  const cancelAhead = () => {
    field.aheadRequest?.controller.abort();
    field.aheadRequest = null;
    field.ahead = null;
    field.failedAhead = null;
    aheadIdle?.();
    aheadIdle = null;
  };

  const paintAheadLater = () => {
    const ahead = field.ahead;
    if (!ahead || aheadIdle || ahead.paintedId === fieldIdOf(view)) return;
    const paint = () => {
      aheadIdle = null;
      const id = fieldIdOf(view);
      if (
        ahead !== field.ahead ||
        ahead.run !== field.manifest?.run ||
        !clock.follows(CLOCK_ID) ||
        !clock.isPlaying() ||
        !fieldDrawing?.visible() ||
        !id
      )
        return;
      if (
        fieldDrawing.prepare(paintKey(ahead, id), () =>
          paintField(field.manifest, ahead.grids, id, scaleOf(view)),
        )
      )
        ahead.paintedId = id;
    };
    if (typeof globalThis.requestIdleCallback === 'function') {
      const handle = globalThis.requestIdleCallback(paint, { timeout: 1000 });
      aheadIdle = () => globalThis.cancelIdleCallback(handle);
    } else {
      const handle = setTimeout(paint, 50);
      aheadIdle = () => clearTimeout(handle);
    }
  };

  const askAhead = () => {
    const manifest = field.manifest;
    if (
      !_enabled ||
      !fieldDrawing?.visible() ||
      !manifest ||
      !fieldReady() ||
      !fieldIdOf(view) ||
      !clock.follows(CLOCK_ID) ||
      !clock.isPlaying()
    ) {
      cancelAhead();
      return;
    }
    const current = field.data.step;
    const next = manifest.global.steps.find((step) => step > current);
    if (next === undefined) {
      cancelAhead();
      return;
    }
    if (field.ahead?.run === manifest.run && field.ahead.step === next) {
      paintAheadLater();
      return;
    }
    if (
      field.aheadRequest?.run === manifest.run &&
      field.aheadRequest.step === next
    )
      return;
    const key = `${manifest.run}|${next}`;
    if (
      field.failedAhead === key ||
      (field.failedStep === key && Date.now() < field.retryStepAt)
    )
      return;
    cancelAhead();
    field.aheadRequest = startStep(manifest, next);
  };

  /** Load the step the layer's time shows, adopting a prefetch if available. */
  const askStep = () => {
    const manifest = field.manifest;
    if (!_enabled || !manifest) return;
    const step = shownStep();
    if (step === null || fieldReady()) {
      cancelStep();
      return;
    }
    const pending = field.stepRequest;
    if (pending?.run === manifest.run && pending.step === step) return;
    cancelStep();
    if (field.ahead?.run === manifest.run && field.ahead.step === step) {
      field.data = field.ahead;
      if (field.failedStep === `${manifest.run}|${step}`)
        field.failedStep = null;
      cancelAhead();
      return;
    }
    const early = field.aheadRequest;
    if (early?.run === manifest.run && early.step === step) {
      field.aheadRequest = null;
      field.stepRequest = early;
    } else {
      if (
        field.failedStep === `${manifest.run}|${step}` &&
        Date.now() < field.retryStepAt
      )
        return;
      field.stepRequest = startStep(manifest, step);
    }
    field.stepRequest.held = waitForStep();
  };

  /** The field's strength for the camera's height now (`FIELD_FADE`). */
  const syncStrength = () => {
    if (!fieldDrawing || !_viewer) return;
    fieldDrawing.setStrength(
      fieldStrength(findCamera(_viewer)?.pose?.().height),
    );
  };

  /**
   * Draw the view's field for the step the card names. While that step
   * loads, the field drawn stays only if it is of the same run and view;
   * a step that failed, another view's colours, a time outside the run, or
   * the field off: nothing is drawn.
   */
  const drawField = () => {
    if (!fieldDrawing) return;
    const id = fieldIdOf(view);
    const step = shownStep();
    const clear = () => {
      fieldDrawing.remove();
      drawnField = null;
    };
    if (!fieldOn() || !id || step === null) {
      clear();
      return;
    }
    // Another view's images go, with a paint of it left for when the field
    // shows again, before the strength could show them.
    if (drawnField && drawnField.id !== id) clear();
    syncStrength();
    const { manifest, data } = field;
    if (fieldReady()) {
      // Another run's or view's images go at once: only a new step of the
      // same field waits under the old one.
      if (drawnField && (drawnField.run !== data.run || drawnField.id !== id))
        clear();
      // A paint left for later uses this view's colours, whatever the view then.
      const colours = scaleOf(view);
      if (
        fieldDrawing.show(paintKey(data, id), () =>
          paintField(manifest, data.grids, id, colours),
        )
      ) {
        drawnField = { run: data.run, id };
        findFrame(_viewer)?.requestRender?.('air-quality');
      } else drawnField = null;
      return;
    }
    const pending =
      field.stepRequest?.run === manifest.run &&
      field.stepRequest.step === step;
    if (pending && drawnField?.run === manifest.run && drawnField.id === id)
      return;
    clear();
  };

  /** What the clock's moves change for the layer: a step, a span, now. */
  const clockState = () =>
    `${shownStep() ?? `out:${bucketOf(layerTime())}`}|${atNow()}|${liveTime()}`;

  /**
   * Bring the field in step with the layer and the clock: the run held (let
   * go once expired), the clock's registration and hold, the run and step to
   * load, what is drawn, and whether the stations show (only at now).
   */
  const syncField = () => {
    if (!fieldSource || syncing) return;
    syncing = true;
    try {
      expireRun();
      syncClock();
      askManifest();
      askStep();
      drawField();
      askAhead();
      clockKey = clockState();
      syncVisibility();
      layer._publishOverlays();
    } finally {
      syncing = false;
    }
  };

  /**
   * The clock moved: a new step, a new span outside the run, or leaving or
   * reaching now.
   */
  const onClock = () => {
    if (!_enabled || syncing) return;
    followTime();
    if (field.absent) return;
    // Play began while the step was loading: hold the clock for it too, once.
    if (field.stepRequest && !field.stepRequest.held)
      field.stepRequest.held = waitForStep();
    if (clockState() === clockKey) {
      askAhead();
      return;
    }
    // A new step must adopt its prefetch before askAhead chooses its successor.
    syncField();
    followView();
    notify();
  };

  /**
   * Let go of the field's requests, hold, drawing and loaded step (a switched
   * off layer keeps no grids or images); the run is kept.
   */
  const haltField = () => {
    field.manifestRequest?.abort();
    field.manifestRequest = null;
    field.asks.clear();
    cancelStep();
    field.data = null;
    cancelAhead();
    fieldDrawing?.dispose();
    drawnField = null;
    if (releaseHold) {
      releaseHold();
      releaseHold = null;
    }
    const key = JSON.stringify(null);
    if (coverageKey !== key) {
      coverageKey = key;
      clock.coverageChanged();
    }
  };

  /**
   * The card's one line of time with a field: the model (its short name),
   * and how old its run is at now, the forecast time ahead of now, or the
   * time behind it.
   */
  const modelLine = () => {
    const { manifest } = field;
    const step = shownStep();
    const ms = fieldStepTime(manifest, step);
    const text = atNow()
      ? t('updated {age}', { age: shortAgo(manifest.runMs) })
      : ms > clock.wallNow()
        ? t('forecast for {time}', { time: utcText(ms) })
        : utcText(ms);
    return [manifest.sourceShort || manifest.source, text]
      .filter(Boolean)
      .join(' · ');
  };

  /** Ask view-driven providers again after the camera stops, while stations show. */
  const followView = () => {
    if (!stationsTimely()) return;
    const key = JSON.stringify(currentView());
    // Only providers that fetch per view follow the camera; one still
    // waiting for a key is asked again by a scheduled refresh, once
    // NO_KEY_RETRY_MS has passed.
    const moved = asked().filter(
      (entry) =>
        entry.viewDriven &&
        !isParked(stateOf(entry)) &&
        (stateOf(entry).requestedView !== key ||
          stateOf(entry).requestedAt !== stationsAt()),
    );
    if (moved.length) {
      for (const entry of moved) {
        const state = stateOf(entry);
        state.request?.abort();
        state.request = null;
        state.status = 'loading';
        state.coverage = null;
        state.error = null;
        state.retryAt = null;
      }
      armRetry();
      clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        moveTimer = null;
        void refresh(
          asked().filter(
            (entry) => entry.viewDriven && !isParked(stateOf(entry)),
          ),
        );
      }, 400);
    }
  };
  /** A station's claim on a map label: the selected one first, then by `rankOf`. */
  const labelValue = (reading) => {
    if (reading.id === selectedStation) return SELECTED_LABEL_VALUE;
    const [band, amount] = rankOf(reading);
    return band < 0
      ? 0
      : 1 +
          Math.min(band, 999) * 1000 +
          Math.min(999, Math.max(0, Math.round(amount)));
  };
  const syncVisibility = () => {
    const shown = _enabled && showStations && stationsShown();
    if (_points) _points.show = shown;
    overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, shown);
  };

  const layer = {
    id: 'air-quality',
    name: 'Air quality',
    icon: '◍',
    get source() {
      return sourceLabel();
    },
    updateInterval: 60_000,

    init(viewer, { panel = null } = {}) {
      if (_viewer) throw new Error('Air quality layer is already initialized');
      _panel = panel;
      _points = drawOf(viewer).points({
        id: `${AIR_QUALITY_MARKER_SET_ID}:points:${++instances}`,
        show: false,
      });
      _viewer = viewer;
      offLocale = onLocaleChange(() => layer._render());
      try {
        _offClick = input?.(viewer)?.onClick?.(onClick) ?? null;
      } catch {
        // A scene with no renderer input takes no clicks.
        _offClick = null;
      }
      // Hidden, the retry loop waits; shown again, it resumes (`armRetry`).
      const page = globalThis.document;
      if (typeof page?.addEventListener === 'function') {
        const onVisibility = () => {
          if (_enabled) armRetry();
        };
        page.addEventListener('visibilitychange', onVisibility);
        offVisibility = () =>
          page.removeEventListener('visibilitychange', onVisibility);
      }
      // The stations and the forecast move with the timeline: another hour,
      // a new step, or leaving now.
      offClock = clock.subscribe(onClock);
      if (fieldSource) {
        fieldDrawing = createFieldDrawing({
          getViewer: () => _viewer,
          getHost: () => imageryHost?.() ?? globeImageryHost(_viewer),
        });
        // The field fades in and out with the camera's height.
        const offChange = findCamera(viewer)?.on('changed', () => {
          if (_enabled) {
            const visible = fieldDrawing?.visible();
            syncStrength();
            if (visible !== fieldDrawing?.visible()) askAhead();
          }
        });
        offCameraChange = typeof offChange === 'function' ? offChange : null;
        // A new map source may move the field to another surface.
        const target = globalThis.window;
        if (typeof target?.addEventListener === 'function') {
          const onMapStack = () => {
            if (_enabled) drawField();
          };
          target.addEventListener('gev:map-stack-changed', onMapStack);
          offMapStack = () =>
            target.removeEventListener('gev:map-stack-changed', onMapStack);
        }
      }
      removeMoveEnd = findCamera(viewer)?.on('moveEnd', () => {
        if (!_enabled) return;
        drawPoints();
        this._publishOverlays();
        // The surface may have changed (globe imagery or 3D tiles).
        drawField();
        followView();
        notify();
      });
      _readings = [];
      _lastUpdate = null;
      _enabled = false;
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      // Other layers' clicks leave a station or group alone (pickRegistry).
      picking?.registerPickOwner?.(layer.id, (id) => _drawn.has(id));
      picking?.registerClickClaim?.(layer.id, claimNear);
      // Readings kept while off are drawn again, unless they have aged out.
      apply();
      syncVisibility();
      syncField();
      notify();
    },

    /** The shell's imagery host (globe or 3D tiles), where the field drapes. */
    attachShellServices(services) {
      runNavigation =
        typeof services?.runNavigation === 'function'
          ? services.runNavigation
          : null;
      imageryHost =
        typeof services?.imageryHost === 'function'
          ? services.imageryHost
          : null;
      if (_enabled) drawField();
    },

    disable() {
      // Abort in flight: a response arriving after disable must not redraw.
      halt();
      _enabled = false;
      haltField();
      picking?.unregisterPickOwner?.(layer.id);
      picking?.unregisterClickClaim?.(layer.id);
      // The click and moveEnd listeners stay until destroy: each returns at
      // once while the layer is off, so enable needs no new subscriptions.
      if (_points) _points.show = false;
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
      notify();
    },

    /** Only `view` is saved and shared; the others are session state. */
    getParams() {
      return { view };
    },

    /** A scene shot also keeps the stations switch, never the station selected. */
    getSceneParams() {
      return { view, stations: showStations };
    },

    setParams(params = {}) {
      const nextView = params.view ?? view;
      if (!views.includes(nextView)) return false;
      let changed = false;
      if (
        typeof params.stations === 'boolean' &&
        params.stations !== showStations
      ) {
        showStations = params.stations;
        changed = true;
      }
      if (params.station !== undefined) {
        const station =
          typeof params.station === 'string' && params.station
            ? params.station
            : null;
        if (station !== selectedStation) {
          selectedStation = station;
          selectedKey = null;
          selectedSeen = null;
          followSelection();
          changed = true;
        }
      }
      if (nextView === view) {
        if (changed) {
          this._render();
          syncVisibility();
          notify();
        }
        return;
      }
      halt();
      view = nextView;
      states = new Map();
      _lastUpdate = null;
      apply();
      syncVisibility();
      notify();
      if (_enabled) void this.update();
    },

    async update() {
      if (!_enabled || !_points) return false;
      // The field's run (a newer one now and then) and step.
      syncField();
      // A provider that said it has no key, or that this server leaves it
      // off, is left alone for a while; the card keeps saying what it needs.
      const entries = asked().filter((entry) => {
        const status = parkedStatus(entry);
        if (!status) return true;
        const state = stateOf(entry);
        if (state.status !== status) {
          state.status = status;
          state.error =
            status === 'no-key'
              ? keyRequirementText(entry.requiresKeyId) || null
              : null;
        }
        return false;
      });
      // Nothing to ask because every provider lacks its key or is off: as
      // when they said so, that is guidance and the layer stays on.
      if (!entries.length && asked().length) {
        notify();
        return true;
      }
      return refresh(entries);
    },

    /**
     * The registry ids of the keys the networks of this view lack (for the
     * Layers row's guidance, with `getStats().keyRequired`), or null.
     */
    get requiresKeyId() {
      const keys = missingKeys();
      return keys.length ? keys : null;
    },

    /**
     * Each asked provider's state, for the card: ok, loading, failed, no-key,
     * or disabled (this server leaves the network off).
     */
    getProviderStates() {
      return asked().map((entry) => {
        const state = stateOf(entry);
        return {
          id: entry.id,
          title: entry.title,
          network: entry.network,
          requiresKeyId: entry.requiresKeyId || null,
          status: state.status,
          error: state.error,
          count: state.readings.length,
        };
      });
    },

    /** Redraw the station points and overlay labels from the current readings. */
    _render() {
      if (!_points) return;
      overlayEntries = _readings.map((reading) => {
        const category = categoryText(reading);
        return createAirQualityOverlayEntry({
          id: reading.id,
          position: fromDegrees(reading.lon, reading.lat),
          title: `${labelName(reading.name)} ${mapLabelValue(reading)}${category ? ` · ${category}` : ''}`,
          accent: reading.color,
          value: labelValue(reading),
        });
      });
      drawPoints();
      this._publishOverlays();
    },

    _publishOverlays() {
      if (!_enabled) return;
      // Hidden with the stations, and at a time they have no answer for.
      if (!showStations || !stationsShown()) {
        overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
        return;
      }
      // A station inside a group has no label of its own: only the stations
      // drawn on their own (and the selected one) keep theirs.
      const rect = viewRectangle();
      const visibleIds = new Set(
        _readings
          .filter((r) => _labelled.has(r.id) && isInRectangle(r, rect))
          .map((r) => r.id),
      );
      overlayHost.setEntries(
        AIR_QUALITY_OVERLAY_SOURCE_ID,
        selectAirQualityOverlayCohort(
          overlayEntries.filter((entry) => visibleIds.has(entry.id)),
        ),
        {
          cohortLimit: AIR_QUALITY_OVERLAY_COHORT_LIMIT,
          collisionCapacity: AIR_QUALITY_OVERLAY_COLLISION_CAPACITY,
          moving: false,
        },
      );
    },

    destroy() {
      halt();
      _enabled = false;
      haltField();
      fieldDrawing?.dispose();
      fieldDrawing = null;
      uncover?.();
      uncover = null;
      offClock?.();
      offClock = null;
      offMapStack?.();
      offMapStack = null;
      offCameraChange?.();
      offCameraChange = null;
      field.manifest = null;
      field.data = null;
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
      _points?.dispose();
      _points = null;
      _offClick?.();
      _offClick = null;
      offVisibility?.();
      offVisibility = null;
      picking?.unregisterPickOwner?.(layer.id);
      picking?.unregisterClickClaim?.(layer.id);
      offLocale?.();
      offLocale = null;
      _drawn = new Map();
      _labelled = new Set();
      removeMoveEnd?.();
      removeMoveEnd = null;
      _viewer = null;
      overlayEntries = [];
      states = new Map();
      aqiMemory.clear();
      selectedSeen = null;
      lastNearest = null;
      owners = new WeakMap();
      _readings = [];
      replacedBy = new Map();
      _lastUpdate = null;
      _panel = null;
    },

    /**
     * The Weather panel's readout card. The tiles read the selected station,
     * else the model at the view centre, else the nearest station
     * (`tileGroups`); station details are in the tooltips.
     */
    getRowControls() {
      const entries = asked();
      const single = entries.length === 1 ? entries[0] : null;
      // The networks drawn on the map, and whether any network answered.
      const drawing = entries.filter(
        (entry) => stateOf(entry).readings.length > 0,
      );
      const covering = entries.filter(answered);
      const error = lastError();
      // The card says Loading only until the first network answers (or
      // while a network waits for the camera's first view and none failed).
      const waitingForView = entries.some(
        (entry) =>
          entry.viewDriven &&
          stateOf(entry).status === 'idle' &&
          stateOf(entry).requestedView === 'null',
      );
      const loading =
        !covering.length && (isLoading() || (waitingForView && !error));
      const rectangle = viewRectangle();
      const query = findQuery(_viewer);
      const canvas = _viewer ? canvasOf(_viewer) : null;
      const width = canvas?.clientWidth;
      const height = canvas?.clientHeight;
      // A tilted or turned view's lon/lat box takes in ground off screen: where
      // the renderer projects, a station must land on the canvas.
      const onScreen =
        typeof query?.project === 'function' && width > 0 && height > 0
          ? (position) => {
              const xy = query.project(position);
              return (
                Boolean(xy) &&
                xy.x >= 0 &&
                xy.x <= width &&
                xy.y >= 0 &&
                xy.y <= height
              );
            }
          : () => true;
      /** Of `list`, the readings on screen: inside the view, this side of the globe. */
      const inViewNow = (list) =>
        list.filter((reading) => {
          if (!isInRectangle(reading, rectangle)) return false;
          const position = fromDegrees(reading.lon, reading.lat);
          return !query?.isOccluded?.(position) && onScreen(position);
        });
      const visible = inViewNow(_readings);
      // Stations are readings of their hour: ahead of now (a forecast), or
      // at a past hour no provider answered for, they are hidden, and the
      // card leaves them out too.
      const now = stationsShown();
      const past = stationsAt() !== null;
      // The stations the tiles may read: the stations in view.
      const candidates = now ? visible : [];
      const inView = visible
        .map((reading) => ({ reading, rank: rankOf(reading) }))
        .sort(
          (a, b) =>
            b.rank[0] - a.rank[0] ||
            b.rank[1] - a.rank[1] ||
            a.reading.name.localeCompare(b.reading.name),
        )
        .map(({ reading }) => reading)
        .slice(0, READOUT_LIMIT);
      // How fresh the newest drawn reading is; with all aged out, the newest
      // kept, so the time line still says how old the network's data is.
      const newestOf = (list) =>
        list.reduce(
          (max, reading) => Math.max(max, reading.observedMs || 0),
          0,
        );
      const newest =
        newestOf(_readings) ||
        newestOf(drawing.flatMap((entry) => stateOf(entry).readings));
      // One short line for each network that needs a key, had its key
      // refused, failed, is out of requests for now, serves cached data, or
      // is still discovering the stations in view; a worldwide network's
      // first, so a collapsed card shows it.
      const providerLines = worldwideFirst(entries).flatMap((entry) => {
        const state = stateOf(entry);
        const { coverage: covered } = state;
        const discovering =
          covered?.partial === true &&
          Number.isFinite(covered.checked) &&
          Number.isFinite(covered.eligible) &&
          covered.eligible > 0 &&
          covered.checked < covered.eligible;
        const text =
          state.status === 'no-key'
            ? t('{network}: add a key in Provider Settings', {
                network: entry.network,
              })
            : state.status === 'failed' && state.keyRejected
              ? t('{network}: key rejected — check Provider Settings', {
                  network: entry.network,
                })
              : state.status === 'failed' && !state.rateLimited
                ? t('{network} unavailable', { network: entry.network })
                : state.rateLimited || covered?.failureStatus === 429
                  ? t(
                      '{network}: request budget reached; cached data will refresh later',
                      { network: entry.network },
                    )
                  : covered?.stale === true
                    ? t('{network}: showing cached data', {
                        network: entry.network,
                      })
                    : discovering
                      ? t('{network}: loading stations, {n} of {m}', {
                          network: entry.network,
                          n: covered.checked,
                          m: covered.eligible,
                        })
                      : '';
        return text ? [{ id: `provider-${entry.id}`, muted: true, text }] : [];
      });
      // A model field the host gives but could not be read: its run, or the
      // step the time shows. Before any manifest was read, nothing: nobody
      // may have configured one.
      if (
        fieldSource &&
        !field.absent &&
        ((field.manifestFailed &&
          (field.everRead || field.manifestUnavailable)) ||
          shownStepFailed())
      )
        providerLines.push({
          id: 'model-field',
          muted: true,
          text: t('Model field unavailable'),
        });
      // The timeline is outside the run held, and no run covering the time
      // is on its way: the map shows no field there.
      if (
        fieldOn() &&
        !liveTime() &&
        shownStep() === null &&
        !field.manifestRequest
      )
        providerLines.push({
          id: 'model-time',
          muted: true,
          text: t('{source}: no forecast for this time', {
            source: field.manifest.sourceShort || field.manifest.source,
          }),
        });
      const model = modelShown();
      // The next step of the field is on its way.
      const fieldLoading =
        fieldOn() && !fieldReady() && field.stepRequest !== null;
      // The view's scale: a ramp from the first band to the open top one
      // (the US AQI, or the pollutant's EEA hourly bands).
      const { bands, limits } = scaleOf(view);
      const legend = limits
        ? bands.map((band, position) => ({
            color: band.color,
            label: !position
              ? '0'
              : `${limits[position - 1]}${position === limits.length ? '+' : ''}`,
          }))
        : [];
      // The selected station as last seen: it stays while views change. At a
      // time with no stations it is not shown, and comes back with them.
      const selected =
        selectedStation === null || !now
          ? null
          : (selectedSeen?.reading ?? null);
      const selectedNetwork = selected
        ? selected.network || selectedSeen.network
        : '';
      // Its index or comparison, the station's owner and where its data comes
      // from: what its row's tooltip says.
      const selectedTitle = selected
        ? [
            selected.parameter === 'aqi'
              ? aqiDetails(selected)
              : pollutantDetails(selected),
            selected.owner && selected.owner !== selectedNetwork
              ? selected.owner
              : '',
            originText(selected, selectedNetwork),
          ]
            .filter(Boolean)
            .join(' · ')
        : '';
      /** A row's category on the view's scale, in its short form; '' unrated. */
      const rowCategory = (reading) => {
        if (!isRatedReading(reading, view)) return '';
        const band =
          view === 'aqi'
            ? usAqiBand(reading.aqi.index)
            : EEA_HOURLY_BANDS[reading.assessment.severity];
        return band
          ? bandLabel(
              band.short ?? band.label,
              view === 'aqi' ? 'US AQI category' : 'EEA hourly quality',
            )
          : '';
      };
      const licence = licenceText(selected);
      return {
        readout: true,
        summary: {
          label: single ? t(single.label) : t('Air quality'),
          // Where the drawn stations are: worldwide, or the networks'
          // countries. A worldwide field is global.
          coverage:
            (model && field.manifest.global.wrap) ||
            drawing.some((entry) => entry.worldwide === true)
              ? t('Global')
              : drawing.map((entry) => t(entry.title)).join(' · '),
          validTime: newest ? new Date(newest).toISOString() : undefined,
          // With a field: the model and the time it shows. Without one: who
          // measured what is drawn, and how fresh the newest reading is;
          // away from now, with no step of the run there, nothing.
          detail: model
            ? modelLine()
            : !now
              ? ''
              : drawing.length && newest
                ? `${drawing.map((entry) => entry.network).join(', ')} · ${
                    past
                      ? utcText(newest)
                      : t('updated {age}', { age: shortAgo(newest) })
                  }`
                : '',
          status:
            loading || fieldLoading
              ? t('Loading')
              : covering.length && showStations && now
                ? tn(visible.length, '{count} station', '{count} stations')
                : '',
          // A collapsed card with no status shows what needs doing.
          compact: providerLines[0]?.text,
          units: view === 'aqi' ? '' : layerUnits(view),
          unitsVerbatim: true,
          lines: providerLines,
          toggles: [
            {
              id: 'stations',
              label: t('STATIONS', { context: 'air quality monitors' }),
              on: showStations,
              params: { stations: !showStations },
            },
          ],
          // The selected station heads the card: its name, who measures it
          // and how old the reading is, with a close button to let it go.
          result: selected
            ? {
                id: 'station',
                key: selected.id,
                lead: true,
                label: selected.name,
                title: selectedTitle,
                clear: {
                  label: t('Deselect station'),
                  params: { station: null },
                },
                lines: [
                  {
                    id: 'station-source',
                    muted: true,
                    // A low-cost sensor says so: it has no US AQI.
                    text: t(
                      selected.monitor === false
                        ? msg('Low-cost sensor · {provider} · {age}')
                        : msg('Measured · {provider} · {age}'),
                      {
                        provider: selectedNetwork,
                        age: Number.isFinite(selected.observedMs)
                          ? shortAgo(selected.observedMs, readingsNow())
                          : t('Unavailable'),
                      },
                    ),
                  },
                  ...(licence
                    ? [
                        {
                          id: 'station-licence',
                          muted: true,
                          text: t('Licence: {licence}', { licence }),
                        },
                      ]
                    : []),
                ],
              }
            : null,
        },
        legend,
        legendCategorical: false,
        sublists: tileGroups(selected, candidates, loading && now),
        list: {
          singleLine: true,
          title: t('HIGHEST IN VIEW'),
          ariaLabel: t('Observations in view'),
          // One line a row: rank, band colour, value, name. The station's
          // details are the row's tooltip.
          // Hidden with the stations.
          items: (showStations && now ? inView : []).map((reading, index) => {
            const owner = ownerOf(reading);
            // A host's reading may come without a time: said so, not thrown.
            const timed = Number.isFinite(reading.observedMs);
            const observed = timed
              ? new Date(reading.observedMs).toISOString()
              : t('Unavailable');
            const older =
              timed && readingsNow() - reading.observedMs > 2 * 3600_000;
            const rated = isRatedReading(reading, view);
            const category = categoryText(reading);
            return {
              id: reading.id,
              ordinal: rated ? index + 1 : null,
              unranked: !rated,
              note: rowCategory(reading),
              swatch: reading.color,
              lead: scaleText(reading),
              // A low-cost sensor is marked in its row, beside monitors.
              text:
                reading.monitor === false
                  ? t('{name} · sensor', { name: reading.name })
                  : reading.name,
              title: `${category ? category + ' · ' : ''}${reading.name} · ${reading.zone} · ${reading.owner || owner.network}${reading.monitor === false ? ' · ' + t('Low-cost sensor') : reading.monitor === true ? ' · ' + t('Reference monitor') : ''} · ${view === 'aqi' && reading.aqi ? averagingText(reading.valueMethods?.[reading.aqi.leading], reading.valueAveraging?.[reading.aqi.leading]) : averagingText(null, reading.averagingMinutes)} · ${observed} · ${view === 'aqi' ? aqiDetails(reading) : pollutantDetails(reading)} · ${older ? `${t('Older observation')} · ` : ''}${t('Provisional data')} · ${originText(reading, reading.network || owner.network)}`,
              accent: reading.color,
              active: reading.id === selectedStation,
              params: { station: reading.id },
            };
          }),
        },
      };
    },

    /**
     * Snapshot readings as JSON-safe records for the analyst query engine.
     * @param {number} [maxCount=500]
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 500) {
      if (!_enabled || !_readings.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      return _readings
        .slice(0, limit)
        .map((reading, index) => mapAnalystRecord(reading, index));
    },

    /**
     * The nearest station's reading to a point, from the readings the layer
     * draws, as the card shows it in the current view: `{value: "US AQI 85 ·
     * Moderate", detail: "Paris · 4 km", at}`, with `stale: true` when the
     * observation is older than `STALE_AFTER_MS`. Returns null while off, with
     * no readings, or for invalid coordinates. Returns `{value: null, reason}`
     * when no station is within AIR_QUALITY_VALUE_RADIUS_KM.
     */
    getValueAt(lat, lon) {
      if (!_enabled || !_readings.length) return null;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      let nearest = null;
      let nearestKm = Infinity;
      for (const reading of _readings) {
        if (!Number.isFinite(reading?.lat) || !Number.isFinite(reading?.lon))
          continue;
        const km = greatCircleKm({ lat, lon }, reading);
        if (km < nearestKm) {
          nearest = reading;
          nearestKm = km;
        }
      }
      if (!nearest || nearestKm > AIR_QUALITY_VALUE_RADIUS_KM)
        return {
          value: null,
          reason: t('No station within {n} km', {
            n: formatNumber(AIR_QUALITY_VALUE_RADIUS_KM),
          }),
        };
      const number = scaleText(nearest);
      const shown =
        view === 'aqi'
          ? `${AQI_NAME} ${number}`
          : number === NO_VALUE
            ? `${view} ${number}`
            : `${view} ${number} ${layerUnits(view)}`;
      const category = categoryText(nearest);
      return {
        value: category ? `${shown} · ${category}` : shown,
        detail: `${nearest.name} · ${formatQuantity(Math.round(nearestKm), 'km')}`,
        ...(Number.isFinite(nearest.observedMs)
          ? {
              at: nearest.observedMs,
              ...(readingsNow() - nearest.observedMs > STALE_AFTER_MS && {
                stale: true,
              }),
            }
          : {}),
      };
    },

    getStats() {
      // `lastUpdate` is when a response was received; `observedAt` is when the
      // network actually measured. Freshness is judged on the latter, so a feed
      // that keeps answering with hours-old observations reports STALE rather
      // than being narrated as live by the HUD and voice provenance envelope.
      // An empty set is a view without stations, not a stale feed, when no network
      // kept a row and one that answered vouches for its answer (coverage not
      // stale). With rows that all aged out, or nothing to go by, it reads stale.
      const emptyAnswer =
        !_readings.length &&
        asked().every((entry) => stateOf(entry).readings.length === 0) &&
        asked().some((entry) => {
          const state = stateOf(entry);
          return (
            state.status === 'ok' &&
            state.coverage &&
            state.coverage.stale !== true
          );
        });
      return {
        count: _readings.length,
        source: sourceLabel(),
        lastUpdate: _lastUpdate,
        // Until the first network answers in this view the Layers row shows
        // progress; a refresh in flight after that does not flicker it.
        loading:
          _enabled &&
          isLoading() &&
          !asked().some((entry) => stateOf(entry).settled),
        error: lastError(),
        // A network that needs its key is guidance: the Layers row says so
        // and names the keys (`requiresKeyId`) instead of reading the layer
        // unavailable. English data: the row translates it.
        keyRequired: keyRequired(),
        ...(keyRequired() ? { loadingLabel: msg('KEY REQUIRED') } : {}),
        // A model step on the map is a feed, with or without stations.
        fieldShown: modelShown(),
        // Networks still discovering the stations in view, with the counts
        // the card's line shows: until done, counts are a floor.
        discovery: asked().flatMap((entry) => {
          const covered = stateOf(entry).coverage;
          return covered?.partial === true &&
            Number.isFinite(covered.checked) &&
            Number.isFinite(covered.eligible) &&
            covered.eligible > 0 &&
            covered.checked < covered.eligible
            ? [
                {
                  network: entry.network,
                  checked: covered.checked,
                  eligible: covered.eligible,
                },
              ]
            : [];
        }),
        observedAt: newestObservation(_readings),
        // Only a completed refresh can be stale; before one there is no feed.
        stale:
          _lastUpdate !== null &&
          (coverageStale() || (!emptyAnswer && readingsAreStale(_readings))),
      };
    },
  };
  return layer;
}

/** Translate each scale in its own grammatical context, only when rendered. */
function bandLabel(label, context) {
  if (context === 'EEA hourly quality') {
    switch (label) {
      case 'Good':
        return t('Good', { context: 'EEA hourly quality' });
      case 'Fair':
        return t('Fair', { context: 'EEA hourly quality' });
      case 'Moderate':
        return t('Moderate', { context: 'EEA hourly quality' });
      case 'Poor':
        return t('Poor', { context: 'EEA hourly quality' });
      case 'Very poor':
        return t('Very poor', { context: 'EEA hourly quality' });
      case 'Extremely poor':
        return t('Extremely poor', { context: 'EEA hourly quality' });
      case 'Extreme':
        return t('Extreme', { context: 'EEA hourly quality' });
    }
  } else if (context === 'US AQI category') {
    switch (label) {
      case 'Good':
        return t('Good', { context: 'US AQI category' });
      case 'Moderate':
        return t('Moderate', { context: 'US AQI category' });
      case 'Unhealthy for Sensitive Groups':
        return t('Unhealthy for Sensitive Groups', {
          context: 'US AQI category',
        });
      case 'Sensitive groups':
        return t('Sensitive groups', { context: 'US AQI category' });
      case 'Unhealthy':
        return t('Unhealthy', { context: 'US AQI category' });
      case 'Very Unhealthy':
        return t('Very Unhealthy', { context: 'US AQI category' });
      case 'Hazardous':
        return t('Hazardous', { context: 'US AQI category' });
    }
  }
  return t(label);
}
