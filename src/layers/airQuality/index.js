import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import { cssColor } from '../../render/color.js';
import {
  canvasOf,
  drawOf,
  findCamera,
  findFrame,
  findQuery,
  rendererOf,
} from '../../render/rendererOf.js';
import { registerDynamicCredit } from '../../data/dataCredits.js';
import { worldClock } from '../../time/worldClock.js';
import { globeImageryHost } from '../weather/shellPlacement.js';
import {
  fieldCoverage,
  fieldIdOf,
  fieldStepAt,
  fieldStepTime,
  fieldStrength,
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
import { ECCC_DEFINITION } from './providers.js';
import { isRatedReading, mergeObservations } from './merge.js';
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
import { formatUtcDayMonth, msg, t, tn } from '../../i18n/index.js';
import {
  AIR_QUALITY_UNKNOWN_COLOR,
  AIR_QUALITY_OVERLAY_SOURCE_ID,
  AIR_QUALITY_OVERLAY_COHORT_LIMIT,
  AIR_QUALITY_OVERLAY_COLLISION_CAPACITY,
  OBSERVATION_MAX_AGE_MS,
  createAirQualityOverlayEntry,
  mapAnalystRecord,
  newestObservation,
  readingsAreStale,
  readingsInView,
  selectAirQualityOverlayCohort,
} from './model.js';
export * from './model.js';
export { createEcccAirQualitySource } from './source.js';
export { createAirQualitySource } from './providers.js';

/** Station markers are a point reading, not an extent. */
const STATION_MARKER_RADIUS_M = 6_000;
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

export const AIR_QUALITY_MARKER_SET_ID = 'air-quality';
let instances = 0;

/** A reading's colour at `alpha`; an unreadable colour falls back to white. */
function withAlpha(css, alpha) {
  const [r, g, b] = cssColor(css) ?? [1, 1, 1];
  return [r, g, b, alpha];
}

/** Pollutant views, as the providers' parameter ids; each on its own scale. */
export const AIR_QUALITY_POLLUTANT_VIEWS = Object.freeze([
  'PM2.5',
  'PM10',
  'O3',
  'NO2',
  'SO2',
  'CO',
]);
/** The colour of a station no index rates. */
const UNRATED_COLOR = '#8cb4ce';
/** Index acronyms: the same text in every language. */
const INDEX_VIEW_NAMES = Object.freeze({ aqi: 'US AQI', aqhi: 'AQHI' });
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
});
/** A concentration in the layer's units as a number, without its unit. */
function concentrationText(parameter, value) {
  return value.toFixed(parameter === 'CO' ? 2 : value < 10 ? 1 : 0);
}

/** One station value as text, in the layer's units. */
function valueText(key, value) {
  const parameter = AQI_PARAMETERS[key];
  return `${parameter} ${concentrationText(parameter, value)} ${layerUnits(parameter)}`;
}

/** How fresh `ms` is, in the card's short form ("5m ago", "3h ago"). */
function shortAgo(ms) {
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60_000));
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
 * The layer shows one `view` at a time: the US AQI (`'aqi'`, the default), one
 * pollutant (`'PM2.5'`, `'NO2'`, ...), or Canada's AQHI (`'aqhi'`). Every
 * observation provider (`observation: true`) is asked in parallel for the
 * station views and drawn as one de-duplicated set (`merge.js`); the AQHI view
 * asks the index providers (`observation: false`: ECCC) only. A provider that
 * fails or needs a key keeps its own state and never blanks the others.
 *
 * Each view has one scale, for colour, ranking and legend: the US AQI view
 * the EPA categories of an index computed per station from all its
 * pollutants (`usAqi.js`; providers are asked with `mode: 'aqi'`), a
 * pollutant view the EEA hourly bands of the concentration, and the AQHI
 * view ECCC's own bands. A network's own index stays in a station's details.
 *
 * At far zoom, stations that would overlap on screen draw as one group
 * (`groups.js`) in the band colour of their members' mean; a click on a group
 * flies in to its stations, a click on a station selects it (`station`).
 * Canada's AQHI discs are never grouped. Without `input` (the input
 * dispatcher's `inputFor`) the layer takes no clicks. `picking` is the pick
 * registry (`src/data/pickRegistry.js`): the drawn stations and groups are
 * registered as this layer's picks while it is on, and a card painted on top
 * of a click (`clickCard`) takes it. `pointer.isPointerFree` holds clicks
 * off while a tool has the pointer.
 *
 * A host may give a model field (`fieldSource`, its contract in `field.js`):
 * a forecast grid of the six pollutants and the US AQI. In a station view
 * the layer then draws the view's field under the stations (`fieldDrawing.js`,
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
  registerCredit = registerDynamicCredit,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Air quality requires a snapshot source');
  if (!overlayHost) throw new TypeError('Air quality requires an overlay host');
  if (
    fieldSource != null &&
    (typeof fieldSource.getManifest !== 'function' ||
      typeof fieldSource.getStep !== 'function')
  )
    throw new TypeError(
      'An air-quality field source needs getManifest and getStep',
    );
  let _viewer = null;
  let _markers = null;
  let _points = null;
  /**
   * Observation readings drawn as points; each drawn point by item id, with
   * where it is drawn and its size; the readings drawn on their own, which
   * keep their labels.
   */
  let _stations = [];
  let _drawn = new Map();
  let _labelled = new Set();
  let _offClick = null;
  let _readings = [];
  let _count = 0;
  let _lastUpdate = null;
  let _enabled = false;
  let rowControlsListener = null;
  const definitions = source.definitions ?? [ECCC_DEFINITION];
  const observationProviders = definitions.filter(
    (entry) => entry.observation === true,
  );
  const indexProviders = definitions.filter(
    (entry) => entry.observation !== true,
  );
  /** Views this source can answer, the default first. */
  const views = Object.freeze([
    ...(observationProviders.length ? ['aqi'] : []),
    ...(indexProviders.length ? ['aqhi'] : []),
    ...AIR_QUALITY_POLLUTANT_VIEWS.filter((id) =>
      observationProviders.some((entry) => entry.parameters.includes(id)),
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
  /** The station the tiles last read, kept while a new view loads. */
  let lastNearest = null;
  /** The providers the current view asks. */
  const asked = () =>
    view === 'aqhi'
      ? indexProviders
      : view === 'aqi'
        ? observationProviders
        : observationProviders.filter((entry) =>
            entry.parameters.includes(view),
          );
  /** The request for the current view: one pollutant, or every one. */
  const requestFor = () =>
    view === 'aqi'
      ? { mode: 'aqi' }
      : AIR_QUALITY_POLLUTANT_VIEWS.includes(view)
        ? { parameter: view }
        : {};
  const freshState = () => ({
    status: 'idle',
    readings: [],
    coverage: null,
    error: null,
    retryAt: null,
    request: null,
    requestedView: null,
    /** Whether it answered in this view: data, a failure, or no key. */
    settled: false,
    /** Whether its last failure was the network refusing the key. */
    keyRejected: false,
  });
  /** Per-provider acquisition state, keyed by provider id. */
  let states = new Map(asked().map((entry) => [entry.id, freshState()]));
  const stateOf = (entry) => {
    if (!states.has(entry.id)) states.set(entry.id, freshState());
    return states.get(entry.id);
  };
  /** Which provider a drawn reading came from (ids may be reused by hosts). */
  let owners = new WeakMap();
  const ownerOf = (reading) =>
    owners.get(reading) ?? asked()[0] ?? definitions[0];
  let overlayEntries = [];
  let removeMoveEnd = null;
  let moveTimer = null;
  let retryTimer = null;
  /** Merges the drawn set again when its next reading turns too old. */
  let ageTimer = null;
  /**
   * The model field: the run held (`manifest`, read by `readFieldManifest`),
   * the step loaded (`data`), what is being asked, and whether the host has
   * no field to give (`absent`). See `syncField`.
   */
  const field = {
    manifest: null,
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
  let uncover = null;
  let offClock = null;
  let offMapStack = null;
  let offCameraChange = null;
  let offVisibility = null;
  let coverageKey = 'null';
  let clockKey = null;
  let syncing = false;
  let imageryHost = null;
  let fieldDrawing = null;

  const isObservationView = () => view !== 'aqhi';
  const sourceLabel = () =>
    asked()
      .map((entry) => entry.sourceLabel || entry.network)
      .join(' · ');
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
   * one does (Canada's AQHI beside the station views, or the other way).
   */
  const otherViewOnOffer = () => {
    const current = asked();
    return definitions.some((entry) => !current.includes(entry));
  };
  /** A layer error only when no asked provider answered. */
  const lastError = () => {
    const list = asked().map(stateOf);
    if (list.some((state) => ['ok', 'loading'].includes(state.status)))
      return null;
    return list.find((state) => state.error)?.error ?? null;
  };
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

  const notify = () => rowControlsListener?.();
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
    const canvas = rendererOf(_viewer)?.canvas;
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
   * `OBSERVATION_MAX_AGE_MS`, judged now, whether or not a fetch succeeded
   * since. A reading without a time is not aged.
   */
  const isCurrent = (ms) =>
    !Number.isFinite(ms) || Date.now() - ms <= OBSERVATION_MAX_AGE_MS;
  /** An AQI-view station with its values too old to draw left out. */
  const currentValuesOf = (station) => {
    const times = station.valueTimes ?? {};
    const old = Object.keys(station.values ?? {}).filter(
      (key) => !isCurrent(times[key]),
    );
    if (!old.length) return station;
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
   * gets its index from its plausible, recent values (`stationIndex`), unless
   * its provider leaves it unrated; its time is then that of the pollutant
   * leading the index, and its averaging that of the values used.
   */
  const present = (reading) => {
    if (view !== 'aqi') return reading;
    const result =
      reading.rated === false ? null : stationIndex(currentValuesOf(reading));
    const aqi = result?.aqi ?? null;
    const band = usAqiBand(aqi?.index);
    const used = result?.used ?? {};
    const averaging = new Set(
      Object.keys(used).map((key) => reading.valueAveraging?.[key] ?? null),
    );
    return {
      ...reading,
      aqi: aqi ? { ...aqi, category: band.label } : null,
      aqiValues: used,
      aqiExcluded: result?.excluded ?? {},
      observedMs: result?.observedMs ?? reading.observedMs,
      averagingMinutes:
        reading.valueAveraging && averaging.size
          ? averaging.size === 1
            ? [...averaging][0]
            : null
          : reading.averagingMinutes,
      value: aqi?.index ?? null,
      color: band?.color ?? UNRATED_COLOR,
      label: aqi ? aqiText(aqi.index) : '—',
    };
  };
  /** A reading's category on the view's scale, translated; '' if unrated. */
  const categoryText = (reading) => {
    if (!isRatedReading(reading, view)) return '';
    if (view === 'aqi')
      return bandLabel(usAqiBand(reading.aqi.index).label, 'US AQI category');
    return bandLabel(
      reading.assessment.label,
      view === 'aqhi' ? ownerOf(reading).bandContext : 'EEA hourly quality',
    );
  };
  /**
   * A station's US AQI for its details in the AQI view: the index, the
   * values it used, the values left out and why, and a network's own index.
   */
  const aqiDetails = (reading, owner) => {
    const index = reading.aqi
      ? t('Calculated US AQI · main pollutant {pollutant}', {
          pollutant: AQI_PARAMETERS[reading.aqi.leading],
        })
      : reading.rated === false
        ? t(
            'The units or averaging period of this network are not confirmed; no health category is assigned.',
          )
        : t('Index unavailable');
    const used = Object.entries(reading.aqiValues ?? {})
      .filter(([key, value]) => AQI_PARAMETERS[key] && Number.isFinite(value))
      .map(([key, value]) => valueText(key, value))
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
    const ratings = Object.entries(reading.ratings ?? {})
      .filter(([key, rating]) => AQI_PARAMETERS[key] && rating?.label)
      .map(
        ([key, rating]) =>
          `${AQI_PARAMETERS[key]} ${rating.score}/10 · ${bandLabel(rating.label, owner.bandContext)}`,
      )
      .join(', ');
    return [
      index,
      used,
      excluded ? t('Not used: {values}', { values: excluded }) : '',
      ratings ? `${t(owner.indexLabel || 'Index unavailable')} ${ratings}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  };
  /** A reading's comparison, then its network's own index if it has one. */
  const pollutantDetails = (reading, owner) => {
    const comparison = reading.assessment?.label
      ? `${t('Calculated comparison')} · ${t(reading.assessment.method)} · ${reading.assessment.range}`
      : reading.assessment?.reason
        ? t(reading.assessment.reason)
        : t('Index unavailable');
    return reading.rating
      ? `${comparison} · ${t(owner.indexLabel || 'Index unavailable')} ${reading.rating.score}/10 · ${bandLabel(reading.rating.label, owner.bandContext)}`
      : comparison;
  };
  /**
   * Where a station's data comes from, for its tooltips: the originating
   * `network` and, where its source states them, the station's licences and
   * their holders (OpenAQ names them per station).
   */
  const originText = (reading, network) => {
    const licences = (Array.isArray(reading?.licenses) ? reading.licenses : [])
      .map((item) =>
        typeof item?.name === 'string' && item.name
          ? item.attribution
            ? `${item.name} (${item.attribution})`
            : item.name
          : '',
      )
      .filter((text, index, all) => text && all.indexOf(text) === index)
      .slice(0, 3)
      .join(', ');
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
    if (!Number.isFinite(value)) return UNRATED_COLOR;
    if (view === 'aqi') return usAqiBand(value)?.color ?? UNRATED_COLOR;
    return (
      EEA_HOURLY_BANDS[hourlyBandIndex(view, value)]?.color ?? UNRATED_COLOR
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
    if (view === 'aqhi') return reading.label;
    const converted =
      view === 'aqi'
        ? null
        : concentrationIn(view, reading.value, reading.units);
    return converted === null ? NO_VALUE : concentrationText(view, converted);
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
   * Of `candidates` (the stations in view), the one nearest the view
   * centre, one rated on the view's scale before any unrated one; null
   * without a view or a candidate.
   */
  const nearestStation = (candidates) => {
    const centre = viewCentre();
    if (!centre) return null;
    const cos = Math.cos((centre.lat * Math.PI) / 180);
    let best = null;
    for (const reading of candidates) {
      const rated = isRatedReading(reading, view);
      const dLon = ((reading.lon - centre.lon + 540) % 360) - 180;
      const distance = (reading.lat - centre.lat) ** 2 + (dLon * cos) ** 2;
      if (
        !best ||
        (rated && !best.rated) ||
        (rated === best.rated && distance < best.distance)
      )
        best = { reading, rated, distance };
    }
    return best?.reading ?? null;
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
   * AQI view computes it, or null: not remembered, too old or unrated.
   */
  const rememberedStation = (reading) => {
    if (!reading) return null;
    const key = stationKey(reading);
    const station = rememberedStations().find(
      (item) => stationKey(item) === key,
    );
    if (!station || station.rated === false) return null;
    const result = stationIndex(station);
    return { station, aqi: result.aqi?.index ?? null, used: result.used };
  };
  /**
   * A pollutant value's EEA hourly band by the map's own rule
   * (`interpretHourly`): only a one-hour average, complete, unflagged and
   * from a network that vouches for it; otherwise null.
   */
  const tileBand = (parameter, value, facts) => {
    const { assessment } = interpretHourly({
      parameter,
      value,
      units: layerUnits(parameter),
      averagingMinutes: facts.averagingMinutes ?? null,
      coveragePercent: facts.coveragePercent,
      qualityFlagged: facts.qualityFlagged === true,
      rated: facts.rated,
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
    if (live?.aqiValues && Number.isFinite(live.aqiValues[key]))
      return {
        value: live.aqiValues[key],
        averagingMinutes: live.valueAveraging?.[key],
        coveragePercent: live.valueCoverage?.[key],
        rated: live.rated,
      };
    if (live && live.parameter === id && !live.qualityFlagged) {
      const value =
        live.rated === false
          ? null
          : concentrationIn(id, live.value, live.units);
      if (value !== null)
        return {
          value,
          averagingMinutes: live.averagingMinutes,
          coveragePercent: live.coveragePercent,
          rated: live.rated,
        };
    }
    const value = remembered?.used?.[key];
    if (!Number.isFinite(value)) return null;
    return {
      value,
      averagingMinutes: remembered.station.valueAveraging?.[key],
      coveragePercent: remembered.station.valueCoverage?.[key],
      rated: remembered.station.rated,
    };
  };
  /**
   * The card's two groups of tiles: the indices, then the pollutants. Each
   * tile is a view: its value at the selected station, else from a model
   * field at the view centre, else at the station in view nearest the
   * centre (`candidates`); a click puts that view on the map. A station's
   * reading in this view comes first, its latest AQI-view values fill the
   * rest. While a view loads, the station shown before stays.
   */
  const tileGroups = (selected, candidates, loading) => {
    const model = selected ? null : fieldValues();
    let station = selected;
    if (!station && !model) {
      station = nearestStation(candidates);
      if (!station && loading) station = lastNearest;
      lastNearest = station;
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
          (value === null ? AIR_QUALITY_UNKNOWN_COLOR : UNRATED_COLOR),
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
      ...(views.includes('aqi')
        ? [
            tile(
              'aqi',
              INDEX_VIEW_NAMES.aqi,
              aqi,
              usAqiBand(aqi),
              'US AQI category',
              aqiText,
            ),
          ]
        : []),
      ...(views.includes('aqhi')
        ? [
            {
              id: 'aqhi',
              value: t('Canada'),
              note: '',
              label: INDEX_VIEW_NAMES.aqhi,
              title: t('Air Quality Health Index, Canada only'),
              accent: AIR_QUALITY_UNKNOWN_COLOR,
              active: view === 'aqhi',
              params: { view: 'aqhi' },
            },
          ]
        : []),
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
          ? t('measured at the station')
          : model
            ? t('model at view centre')
            : station
              ? t('nearest station · {name}', { name: station.name })
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
   * Draw the observation stations: where they would overlap on screen, one
   * group each (`groups.js`), worked out again after every camera move. A
   * scene that cannot be measured draws every station on its own.
   */
  const drawPoints = () => {
    if (!_points) return;
    _drawn = new Map();
    _labelled = new Set();
    const measured = view === 'aqhi' ? null : screen();
    /** A station's part in its group's mean: an index counts up to 500. */
    const groupValue = (reading) => {
      const value = scaleValue(reading);
      return view === 'aqi' && value !== null
        ? Math.min(AQI_SHOWN_MAX, value)
        : value;
    };
    const groups = measured
      ? groupStations(
          _stations.map((reading) => ({
            id: reading.id,
            lat: reading.lat,
            lon: reading.lon,
            value: groupValue(reading),
            reading,
          })),
          cellDegAt(measured),
          { selectedId: selectedStation },
        )
      : _stations.map((reading) => ({ members: [{ reading }] }));
    const items = [];
    for (const group of groups) {
      if (group.members.length === 1) {
        const { reading } = group.members[0];
        const selected = reading.id === selectedStation;
        const id = `air-quality:${reading.id}`;
        const px = selected ? SELECTED_STATION_PX : STATION_PX;
        _drawn.set(id, { reading, lon: reading.lon, lat: reading.lat, px });
        _labelled.add(reading.id);
        items.push({
          id,
          pos: { lon: reading.lon, lat: reading.lat, height: 0 },
          pixelSize: px,
          color: reading.color,
          outlineColor: selected ? SELECTED_OUTLINE : '#000000',
          outlineWidth: selected ? SELECTED_OUTLINE_WIDTH : 1,
          height: 'clampGround',
          meta: { ...reading },
        });
        continue;
      }
      // One bubble: the band colour of its members' mean, its size growing
      // with their number.
      const id = `air-quality-group:${group.members[0].id}:${group.members.length}`;
      const px = Math.round(12 + 6 * Math.log10(group.members.length));
      _drawn.set(id, { group, lon: group.lon, lat: group.lat, px });
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
    if (target.rect)
      findCamera(_viewer)?.flyTo(
        { rect: target.rect },
        { durationS: GROUP_FLIGHT_S },
      );
    else layer.setParams({ station: target.station.id });
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
   * A click on a group flies to it; on a station, selects it; on open map,
   * lets go of the selected station. A card painted on top takes the click.
   */
  const onClick = (event) => {
    if (!_enabled || !showStations || !_points || !_viewer) return;
    // Away from now no station is drawn, so none takes a click.
    if (!atNow()) return;
    if (pointer && !pointer.isPointerFree()) return;
    if (!isTrackingSelectionGesture(event?.gesture)) return;
    if (picking?.clickCard?.(event)) return;
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
    const lists = asked().map((entry) => ({
      provider: entry.id,
      direct: entry.direct === true,
      readings: stateOf(entry).readings.flatMap((raw) => {
        const reading = present(raw);
        if (!isCurrent(reading.observedMs)) return [];
        owners.set(reading, entry);
        return [reading];
      }),
    }));
    _readings = mergeObservations(lists, { view });
    _count = _readings.length;
    followSelection();
    layer._render();
    armAgeOut();
  };

  /** Merge again when the next drawn reading or value turns too old. */
  const armAgeOut = () => {
    clearTimeout(ageTimer);
    ageTimer = null;
    if (!_enabled) return;
    let next = Infinity;
    for (const entry of asked())
      for (const raw of stateOf(entry).readings) {
        const times = [raw.observedMs, ...Object.values(raw.valueTimes ?? {})];
        for (const ms of times)
          if (Number.isFinite(ms) && isCurrent(ms))
            next = Math.min(next, ms + OBSERVATION_MAX_AGE_MS);
      }
    if (!Number.isFinite(next)) return;
    ageTimer = setTimeout(
      () => {
        ageTimer = null;
        if (_enabled) apply();
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
      state.request = null;
      state.status = 'ok';
      state.settled = true;
      state.keyRejected = false;
      state.error = null;
      parked.delete(entry.id);
      const list = Array.isArray(readings) ? readings : [];
      // The AQI view draws one reading per station with all its values.
      state.readings = asking.mode === 'aqi' ? aqiStations(list) : list;
      if (asking.mode === 'aqi')
        aqiMemory.set(entry.id, { at: Date.now(), readings: state.readings });
      state.coverage = source.getCoverage?.(entry.id) ?? null;
      setRetry(entry, state.coverage?.retryAt);
      _lastUpdate = Date.now();
      apply();
      return true;
    } catch (error) {
      if (request.signal.aborted || state.request !== request) return _enabled;
      state.request = null;
      state.settled = true;
      // A key the network refused: the card says to check it.
      state.keyRejected = error?.code === 'key_rejected';
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
      if (state.status !== 'disabled')
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

  /**
   * True as soon as one provider answers (`run` resolves true), or after
   * `FIRST_ANSWER_CAP_MS` while some are still asking; otherwise, once all
   * have settled, true when one of them needs a key or is off on this server
   * (`run` resolves `'parked'`: guidance, not a failure), else whether the
   * layer may still show something (`fallback`).
   */
  const firstAnswer = (jobs, fallback) =>
    new Promise((resolve) => {
      if (!jobs.length) {
        resolve(fallback);
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
            if (--left === 0) settle(guided || fallback);
          }
        });
    });

  /**
   * Ask the given providers in parallel. Resolves on the first answer, or
   * after a few seconds while all are still asking; the others keep loading
   * and land in their own state.
   */
  const refresh = async (entries) => {
    if (!_enabled || !_markers) return false;
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
    let waiting = false;
    const jobs = [];
    for (const entry of entries) {
      const state = stateOf(entry);
      state.request?.abort();
      state.request = null;
      state.retryAt = null;
      state.status = 'loading';
      state.error = null;
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
    // A provider still waiting for a view may yet answer; and while another
    // view is on offer, a layer whose networks all failed stays on, saying so.
    return firstAnswer(jobs, !entries.length || waiting || otherViewOnOffer());
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
      step !== null && step === fieldStepAt(field.manifest, clock.wallNow())
    );
  };
  /** Whether the model field is on the map: a run held, in a station view. */
  const fieldOn = () =>
    _enabled && field.manifest !== null && isObservationView();
  /** The loaded step, when it is the one the layer's time shows. */
  const fieldReady = () => {
    const step = shownStep();
    return (
      step !== null &&
      field.data?.run === field.manifest.run &&
      field.data.step === step
    );
  };
  /** Whether the step the layer's time shows failed to load. */
  const shownStepFailed = () =>
    field.manifest !== null &&
    field.failedStep === `${field.manifest.run}|${shownStep()}`;
  /**
   * Whether the card speaks for the model: a step of the run at the layer's
   * time, on the map (a station view) or read by the tiles (Canada's AQHI).
   */
  const modelShown = () =>
    _enabled &&
    field.manifest !== null &&
    shownStep() !== null &&
    (fieldOn() || fieldReady());
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
   * exact wording); it joins the data credits while the field is held.
   */
  const creditField = (manifest) => {
    if (!manifest.credit || !_viewer) return;
    const html = manifest.credit
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    registerCredit(_viewer, {
      key: `air-quality-field|${manifest.credit}`,
      html,
    });
  };

  /** Let go of the run held, and of its step. */
  const dropRun = () => {
    field.manifest = null;
    field.data = null;
    field.failedStep = null;
    cancelStep();
  };
  /**
   * Back at now holding a run asked for another time, the newest run is
   * asked for at once, whether or not the run held covers now (an older one
   * may, with a shorter forecast). At now a run that does not cover now is
   * let go (expired: stations only until a newer run).
   */
  const expireRun = () => {
    const live = liveTime();
    const returned = live && !field.wasLive;
    field.wasLive = live;
    const held = field.manifest;
    if (!held || !live) return;
    if (returned && field.heldFor !== 'now') field.asks.delete('now');
    if (fieldStepAt(held, clock.wallNow()) !== null) return;
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
    if (field.absent || !_enabled || field.manifestRequest) return;
    const live = liveTime();
    const time = layerTime();
    const held = field.manifest;
    const covered = held !== null && fieldStepAt(held, time) !== null;
    if (covered && !live) return;
    const want = live ? 'now' : bucketOf(time);
    if (Date.now() < (field.asks.get(want) ?? 0)) return;
    // Only the recent spans are remembered.
    if (field.asks.size > 64) field.asks.clear();
    field.asks.set(want, Infinity);
    const request = new AbortController();
    field.manifestRequest = request;
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
        field.manifest = manifest;
        creditField(manifest);
        field.heldFor = want;
        field.manifestFailed = false;
        field.everRead = true;
        // At now the newest run is asked again later; a span away from now
        // is not asked again.
        if (want === 'now')
          field.asks.set(want, Date.now() + FIELD_MANIFEST_MS);
        // A step of another run is not drawn once this run is held.
        if (field.stepRequest && field.stepRequest.run !== manifest.run)
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
        field.asks.set(want, Date.now() + FIELD_RETRY_MS);
        console.warn(
          '[Data:AirQuality] Model field manifest failed:',
          error?.message || error,
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
    if (!clock.follows(CLOCK_ID) || !clock.isPlaying()) return;
    const release = clock.wait(CLOCK_ID);
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      release();
      if (releaseWait === done) releaseWait = null;
    };
    timer = setTimeout(done, FIELD_WAIT_MS);
    releaseWait = done;
  };

  /** Load the step the layer's time shows, if it is not loaded or loading. */
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
    const key = `${manifest.run}|${step}`;
    if (field.failedStep === key && Date.now() < field.retryStepAt) {
      cancelStep();
      return;
    }
    cancelStep();
    const request = {
      run: manifest.run,
      step,
      controller: new AbortController(),
    };
    field.stepRequest = request;
    waitForStep();
    Promise.resolve()
      .then(() =>
        fieldSource.getStep(step, {
          signal: request.controller.signal,
          run: request.run,
        }),
      )
      .then((raw) => {
        if (field.stepRequest !== request) return;
        field.data = {
          run: request.run,
          step,
          grids: readFieldStep(manifest, step, raw),
        };
        if (field.failedStep === key) field.failedStep = null;
      })
      .catch((error) => {
        if (field.stepRequest !== request) return;
        field.failedStep = key;
        field.retryStepAt = Date.now() + FIELD_RETRY_MS;
        console.warn(
          '[Data:AirQuality] Model field step failed:',
          error?.message || error,
        );
      })
      .finally(() => {
        if (field.stepRequest !== request) return;
        field.stepRequest = null;
        releaseWait?.();
        releaseWait = null;
        syncField();
        notify();
      });
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
    syncStrength();
    const { manifest, data } = field;
    if (fieldReady()) {
      if (
        fieldDrawing.show(`${data.run}|${data.step}|${id}`, () =>
          paintField(manifest, data.grids, id, scaleOf(view)),
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
    if (!_enabled || field.absent || syncing) return;
    if (clockState() === clockKey) return;
    syncField();
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

  const syncVisibility = () => {
    const shown = _enabled && showStations && atNow();
    if (_markers) _markers.show = shown;
    if (_points) _points.show = shown;
    overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, shown);
  };

  const layer = {
    id: 'air-quality',
    name: 'Air quality',
    icon: '◍',
    source: sourceLabel(),
    updateInterval: 60_000,

    init(viewer) {
      if (_viewer) throw new Error('Air quality layer is already initialized');
      _markers = drawOf(viewer).shapes({
        id: `${AIR_QUALITY_MARKER_SET_ID}:${++instances}`,
        show: false,
      });
      _points = drawOf(viewer).points({
        id: `${AIR_QUALITY_MARKER_SET_ID}:points:${instances}`,
        show: false,
      });
      _viewer = viewer;
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
      if (fieldSource) {
        fieldDrawing = createFieldDrawing({
          getViewer: () => _viewer,
          getHost: () => imageryHost?.() ?? globeImageryHost(_viewer),
        });
        // The forecast moves with the timeline: a new step, or leaving now.
        offClock = clock.subscribe(onClock);
        // The field fades in and out with the camera's height.
        const offChange = findCamera(viewer)?.on('changed', () => {
          if (_enabled) syncStrength();
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
        const key = JSON.stringify(currentView());
        // Only providers that fetch per view follow the camera; one still
        // waiting for a key is asked again by a scheduled refresh, once
        // NO_KEY_RETRY_MS has passed.
        const moved = asked().filter(
          (entry) =>
            entry.viewDriven &&
            !isParked(stateOf(entry)) &&
            stateOf(entry).requestedView !== key,
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
        notify();
      });
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      _enabled = false;
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      // Other layers' clicks leave a station or group alone (pickRegistry).
      picking?.registerPickOwner?.(layer.id, (id) => _drawn.has(id));
      // Readings kept while off are drawn again, unless they have aged out.
      apply();
      syncVisibility();
      syncField();
      notify();
    },

    /** The shell's imagery host (globe or 3D tiles), where the field drapes. */
    attachShellServices(services) {
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
      // The click and moveEnd listeners stay until destroy: each returns at
      // once while the layer is off, so enable needs no new subscriptions.
      if (_markers) _markers.show = false;
      if (_points) _points.show = false;
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
      notify();
    },

    /** Only `view` is saved and shared; the others are session state. */
    getParams() {
      return { view, stations: showStations, station: selectedStation };
    },

    setParams(params = {}) {
      // The default view restored on a source without stations (Canada's
      // AQHI only) is that source's own first view.
      const nextView =
        params.view === 'aqi' && !views.includes('aqi')
          ? views[0]
          : (params.view ?? view);
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
          drawPoints();
          syncVisibility();
          this._publishOverlays();
          notify();
        }
        return;
      }
      halt();
      view = nextView;
      states = new Map(asked().map((entry) => [entry.id, freshState()]));
      this.source = sourceLabel();
      _lastUpdate = null;
      apply();
      syncVisibility();
      notify();
      if (_enabled) void this.update();
    },

    async update() {
      if (!_enabled || !_markers) return false;
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
     * The span this layer gives the world clock's timeline (its model run's
     * first step to its last while the field is on), or null.
     */
    getClockCoverage() {
      return coverage();
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

    /** Redraw the station markers and overlay labels from the current readings. */
    _render() {
      if (!_markers) return;
      const markers = [];
      const stations = [];
      overlayEntries = [];
      for (const reading of _readings) {
        const owner = ownerOf(reading);
        const category = categoryText(reading);
        const position = fromDegrees(reading.lon, reading.lat);
        // Observation stations are points (`drawPoints`). Index stations are
        // a filled disc on the ground with static axes, as in the earthquake
        // layer: a per-frame axis re-tessellates clamped ground geometry
        // every frame. No outline: clamped to the ground, the default
        // renderer never drew one.
        if (owner.observation === true) stations.push(reading);
        else
          markers.push({
            id: `air-quality:${reading.id}`,
            geometry: {
              kind: 'ellipse',
              center: { lon: reading.lon, lat: reading.lat },
              semiMajor: STATION_MARKER_RADIUS_M,
              semiMinor: STATION_MARKER_RADIUS_M,
            },
            fill: withAlpha(reading.color, 0.35),
            height: 'clampGround',
            clampTo: 'both',
            meta: {
              provider: reading.provider,
              scale: reading.scale,
              value: reading.value,
              band: reading.band,
              name: reading.name,
              zone: reading.zone,
              risk: reading.risk,
              observedMs: reading.observedMs,
              note: reading.note,
              lat: reading.lat,
              lon: reading.lon,
            },
          });
        overlayEntries.push(
          createAirQualityOverlayEntry({
            id: reading.id,
            position,
            title: `${reading.name} ${mapLabelValue(reading)}${category ? ` · ${category}` : ''}`,
            accent: reading.color,
            value: owner.observation === true ? 0 : reading.value,
          }),
        );
      }
      _markers.set(markers);
      _stations = stations;
      drawPoints();
      this._publishOverlays();
    },

    _publishOverlays() {
      if (!_enabled) return;
      // Hidden with the stations, and away from now.
      if (!showStations || !atNow()) {
        overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
        return;
      }
      // A station inside a group has no label of its own: only the stations
      // drawn on their own (and the selected one) keep theirs.
      const visibleIds = isObservationView()
        ? new Set(
            readingsInView(_readings, viewRectangle(), _readings.length)
              .map((row) => row.id)
              .filter((id) => _labelled.has(id)),
          )
        : null;
      overlayHost.setEntries(
        AIR_QUALITY_OVERLAY_SOURCE_ID,
        selectAirQualityOverlayCohort(
          visibleIds
            ? overlayEntries.filter((entry) => visibleIds.has(entry.id))
            : overlayEntries,
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
      _markers?.dispose();
      _markers = null;
      _points?.dispose();
      _points = null;
      _offClick?.();
      _offClick = null;
      offVisibility?.();
      offVisibility = null;
      picking?.unregisterPickOwner?.(layer.id);
      _stations = [];
      _drawn = new Map();
      _labelled = new Set();
      removeMoveEnd?.();
      removeMoveEnd = null;
      _viewer = null;
      overlayEntries = [];
      states = new Map(asked().map((entry) => [entry.id, freshState()]));
      aqiMemory.clear();
      selectedSeen = null;
      lastNearest = null;
      owners = new WeakMap();
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      rowControlsListener = null;
    },

    /**
     * Readout descriptor for the Weather panel, kept slim: the selected
     * station, one time line (the networks drawn and how fresh), how many
     * stations are in view, a line for each network that needs a key or
     * failed, the stations switch, the scale, two groups of tiles (the
     * indices, the pollutants; each the value at one place and a click away
     * from the map), and the highest readings in view.
     *
     * The tiles read the selected station, else the station nearest the view
     * centre. Station details stay in a list row's tooltip.
     */
    getRowControls() {
      const isObservation = isObservationView();
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
      /** Of `list`, the readings inside the view and this side of the globe. */
      const inViewNow = (list) =>
        readingsInView(list, rectangle, list.length).filter(
          (reading) =>
            !query?.isOccluded?.(fromDegrees(reading.lon, reading.lat)),
        );
      const visible = inViewNow(_readings);
      // Stations are readings of now: away from now (a forecast or a past
      // step of the model field) they are hidden, and the card leaves them
      // out too.
      const now = atNow();
      // The stations the tiles may read: the observation stations in view;
      // in the AQHI view, the remembered AQI-view stations in view.
      const candidates = !now
        ? []
        : isObservation
          ? visible.filter((reading) => ownerOf(reading).observation === true)
          : inViewNow(rememberedStations());
      const inView = (
        isObservation
          ? visible
              .map((reading) => ({ reading, rank: rankOf(reading) }))
              .sort(
                (a, b) =>
                  b.rank[0] - a.rank[0] ||
                  b.rank[1] - a.rank[1] ||
                  a.reading.name.localeCompare(b.reading.name),
              )
              .map(({ reading }) => reading)
          : visible
      ).slice(0, READOUT_LIMIT);
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
      // is still discovering the stations in view.
      const providerLines = entries.flatMap((entry) => {
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
              : state.status === 'failed'
                ? t('{network} unavailable', { network: entry.network })
                : covered?.failureStatus === 429
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
        ((field.manifestFailed && field.everRead) || shownStepFailed())
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
      // (the US AQI, or the pollutant's EEA hourly bands), or Canada's AQHI
      // bands by name.
      const limits =
        view === 'aqi' ? US_AQI_LIMITS : (EEA_HOURLY_LIMITS[view] ?? null);
      const bands = view === 'aqi' ? US_AQI_BANDS : EEA_HOURLY_BANDS;
      const legend =
        view === 'aqhi'
          ? covering
              .flatMap((entry) =>
                (entry.legend ?? []).map((band) => ({
                  color: band.color,
                  label: `${bandLabel(band.label, entry.bandContext)}${band.range ? ` ${band.range}` : ''}`,
                })),
              )
              // Index providers on one scale list its bands once.
              .filter(
                (band, index, all) =>
                  all.findIndex(
                    (other) =>
                      other.color === band.color && other.label === band.label,
                  ) === index,
              )
          : limits
            ? bands.map((band, position) => ({
                color: band.color,
                label: !position
                  ? '0'
                  : `${limits[position - 1]}${position === limits.length ? '+' : ''}`,
              }))
            : [];
      // The selected station as last seen: it stays while views change. Away
      // from now it is not shown, and comes back at now.
      const selected =
        selectedStation === null || !now
          ? null
          : (selectedSeen?.reading ?? null);
      return {
        readout: true,
        summary: {
          label: single ? t(single.label) : t('Air quality'),
          // Where the drawn stations are: worldwide, or the networks'
          // countries; Canada for its index. A worldwide field is global.
          coverage: !isObservation
            ? t('Canada')
            : (model && field.manifest.global.wrap) ||
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
                ? `${drawing.map((entry) => entry.network).join(', ')} · ${t(
                    'updated {age}',
                    { age: shortAgo(newest) },
                  )}`
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
                lead: true,
                label: selected.name,
                // Its network and licence, as its row's tooltip ends.
                title: originText(
                  selected,
                  selected.network || selectedSeen.network,
                ),
                clear: {
                  label: t('Deselect station'),
                  params: { station: null },
                },
                lines: [
                  {
                    id: 'station-source',
                    muted: true,
                    text: t('Measured · {provider} · {age}', {
                      provider: selected.network || selectedSeen.network,
                      age: Number.isFinite(selected.observedMs)
                        ? shortAgo(selected.observedMs)
                        : t('Unavailable'),
                    }),
                  },
                ],
              }
            : null,
        },
        legend,
        legendCategorical: view === 'aqhi',
        sublists: tileGroups(selected, candidates, loading && now),
        list: {
          title: t('HIGHEST IN VIEW'),
          ariaLabel: isObservation
            ? t('Observations in view')
            : t('Highest air-quality readings in view'),
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
              timed && Date.now() - reading.observedMs > 2 * 3600_000;
            return {
              id: reading.id,
              ordinal: index + 1,
              swatch: reading.color,
              lead: isObservation ? scaleText(reading) : reading.label,
              text: reading.name,
              title: isObservation
                ? `${reading.name} · ${reading.zone} · ${reading.owner || owner.network} · ${t(reading.averagingMinutes === 60 ? msg('Hourly average') : msg('Source averaging period unspecified'))} · ${observed} · ${view === 'aqi' ? aqiDetails(reading, owner) : pollutantDetails(reading, owner)} · ${older ? `${t('Older observation')} · ` : ''}${t('Provisional data')} · ${originText(reading, reading.network || owner.network)}`
                : `${reading.name} · ${t(reading.risk)}`,
              accent: reading.color,
              ...(isObservation
                ? {
                    active: reading.id === selectedStation,
                    params: { station: reading.id },
                  }
                : {}),
            };
          }),
        },
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
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

    getStats() {
      // `lastUpdate` is when a response was received; `observedAt` is when the
      // network actually measured. Freshness is judged on the latter, so a feed
      // that keeps answering with hours-old observations reports STALE rather
      // than being narrated as live by the HUD and voice provenance envelope.
      return {
        count: _count,
        source: this.source,
        lastUpdate: _lastUpdate,
        // Until the first network answers in this view the Layers row shows
        // progress; a refresh in flight after that does not flicker it.
        loading:
          _enabled &&
          isLoading() &&
          !asked().some((entry) => stateOf(entry).settled),
        error: lastError(),
        observedAt: newestObservation(_readings),
        // Only a completed refresh can be stale; before one there is no feed.
        stale:
          _lastUpdate !== null &&
          (coverageStale() || readingsAreStale(_readings)),
      };
    },
  };
  return layer;
}

// Provider category labels are translated at presentation time.
msg('Good');
msg('Moderate');
msg('Unhealthy');
msg('Very Unhealthy');
msg('Hazardous');

/** Translate each scale in its own grammatical context, only when rendered. */
function bandLabel(label, context) {
  if (context === 'air quality risk') {
    switch (label) {
      case 'Low':
        return t('Low', { context: 'air quality risk' });
      case 'Moderate':
        return t('Moderate', { context: 'air quality risk' });
      case 'High':
        return t('High', { context: 'air quality risk' });
      case 'Very High':
        return t('Very High', { context: 'air quality risk' });
    }
  } else if (context === 'EEA hourly quality') {
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
  } else if (context === 'SAAQIS category') {
    switch (label) {
      case 'Good':
        return t('Good', { context: 'SAAQIS category' });
      case 'Moderate':
        return t('Moderate', { context: 'SAAQIS category' });
      case 'Unhealthy':
        return t('Unhealthy', { context: 'SAAQIS category' });
      case 'Very Unhealthy':
        return t('Very Unhealthy', { context: 'SAAQIS category' });
      case 'Hazardous':
        return t('Hazardous', { context: 'SAAQIS category' });
    }
  }
  return t(label);
}
