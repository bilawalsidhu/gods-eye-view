import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import { cssColor } from '../../render/color.js';
import {
  canvasOf,
  drawOf,
  findCamera,
  findQuery,
  rendererOf,
} from '../../render/rendererOf.js';
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
import { msg, t, tn } from '../../i18n/index.js';
import {
  AIR_QUALITY_UNKNOWN_COLOR,
  AIR_QUALITY_OVERLAY_SOURCE_ID,
  AIR_QUALITY_OVERLAY_COHORT_LIMIT,
  AIR_QUALITY_OVERLAY_COLLISION_CAPACITY,
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
 */
export function createAirQualityLayer({
  source,
  overlayHost,
  input = null,
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Air quality requires a snapshot source');
  if (!overlayHost) throw new TypeError('Air quality requires an overlay host');
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
  /** When each provider last answered that it has no key, by provider id. */
  const noKeyAt = new Map();
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
  /** A provider asked recently enough that "no key" still stands. */
  const keyStillMissing = (entry) =>
    noKeyAt.has(entry.id) &&
    Date.now() - noKeyAt.get(entry.id) < NO_KEY_RETRY_MS;
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
  const armRetry = () => {
    clearTimeout(retryTimer);
    retryTimer = null;
    const at = _enabled ? nextRetryAt() : null;
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
   * One reading as the current view presents it. In the AQI view a station
   * gets its index from its plausible, recent values (`stationIndex`), unless
   * its provider leaves it unrated; its time is then that of the pollutant
   * leading the index, and its averaging that of the values used.
   */
  const present = (reading) => {
    if (view !== 'aqi') return reading;
    const result = reading.rated === false ? null : stationIndex(reading);
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
      label: aqi ? String(aqi.index) : '—',
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
      return view === 'aqi' ? String(value) : concentrationText(view, value);
    if (view === 'aqhi') return reading.label;
    const converted =
      view === 'aqi'
        ? null
        : concentrationIn(view, reading.value, reading.units);
    return converted === null ? NO_VALUE : concentrationText(view, converted);
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
   * Values at the view centre from a model field, `{ aqi, values }` with
   * `values` by pollutant view id, or null. Stand-alone Core has no field.
   */
  const fieldValues = () => null;
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
    const field = selected ? null : fieldValues();
    let station = selected;
    if (!station && !field) {
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
    const aqi = field
      ? (field.aqi ?? null)
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
              String,
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
      if (field) {
        // A model's value is an hourly field: banded as it stands.
        const value = field.values?.[id] ?? null;
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
          : field
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
    const groups = measured
      ? groupStations(
          _stations.map((reading) => ({
            id: reading.id,
            lat: reading.lat,
            lon: reading.lon,
            value: scaleValue(reading),
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

  /** Merge every asked provider's readings into the drawn set. */
  const apply = () => {
    owners = new WeakMap();
    const lists = asked().map((entry) => ({
      provider: entry.id,
      direct: entry.direct === true,
      readings: stateOf(entry).readings.map((raw) => {
        const reading = present(raw);
        owners.set(reading, entry);
        return reading;
      }),
    }));
    _readings = mergeObservations(lists, { view });
    _count = _readings.length;
    followSelection();
    layer._render();
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
      state.error = null;
      noKeyAt.delete(entry.id);
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
      // Earlier readings stay drawn: a failed refresh is degraded, not empty.
      state.status = error?.code === 'no_key' ? 'no-key' : 'failed';
      if (state.status === 'no-key') noKeyAt.set(entry.id, Date.now());
      state.error =
        (error?.code === 'no_key'
          ? keyRequirementText(entry.requiresKeyId)
          : '') ||
        error?.message ||
        msg('Air quality request failed');
      setRetry(entry, error?.retryAt);
      console.warn(
        `[Data:AirQuality] Refresh failed (${entry.id}):`,
        state.error,
      );
      return state.retryAt !== null;
    } finally {
      armRetry();
      notify();
    }
  };

  /**
   * True as soon as one provider answers (`run` resolves true), or after
   * `FIRST_ANSWER_CAP_MS` while some are still asking; otherwise, once all
   * have settled, whether any of them may still succeed (`fallback`).
   */
  const firstAnswer = (jobs, fallback) =>
    new Promise((resolve) => {
      if (!jobs.length) {
        resolve(fallback);
        return;
      }
      let left = jobs.length;
      const timer = setTimeout(() => resolve(true), FIRST_ANSWER_CAP_MS);
      const settle = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      for (const job of jobs)
        job.then((ok) => {
          if (ok) settle(true);
          else if (--left === 0) settle(fallback);
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
          ...asked().filter((e) => e.viewDriven && !keyStillMissing(e)),
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
    // A provider still waiting for a view may yet answer.
    return firstAnswer(jobs, !entries.length || waiting);
  };

  const syncVisibility = () => {
    const shown = _enabled && showStations;
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
      removeMoveEnd = findCamera(viewer)?.on('moveEnd', () => {
        if (!_enabled) return;
        drawPoints();
        this._publishOverlays();
        const key = JSON.stringify(currentView());
        // Only providers that fetch per view follow the camera; one still
        // waiting for a key is asked again by a scheduled refresh, once
        // NO_KEY_RETRY_MS has passed.
        const moved = asked().filter(
          (entry) =>
            entry.viewDriven &&
            stateOf(entry).status !== 'no-key' &&
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
                (entry) =>
                  entry.viewDriven && stateOf(entry).status !== 'no-key',
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
      drawPoints();
      syncVisibility();
      notify();
    },

    disable() {
      // Abort in flight: a response arriving after disable must not redraw.
      halt();
      _enabled = false;
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
      // A provider that said it has no key is left alone for a while; the
      // card keeps saying what it needs.
      const entries = asked().filter((entry) => {
        if (!keyStillMissing(entry)) return true;
        const state = stateOf(entry);
        if (state.status !== 'no-key') {
          state.status = 'no-key';
          state.error = keyRequirementText(entry.requiresKeyId) || null;
        }
        return false;
      });
      // Nothing to ask because every provider lacks its key: as when they
      // all said so, the update fails.
      if (!entries.length && asked().length) {
        notify();
        return false;
      }
      return refresh(entries);
    },

    /** Each asked provider's state, for the card: ok, loading, failed, no-key. */
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
            title: `${reading.name} ${reading.label}${category ? ` · ${category}` : ''}`,
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
      if (!showStations) {
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
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
      _markers?.dispose();
      _markers = null;
      _points?.dispose();
      _points = null;
      _offClick?.();
      _offClick = null;
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
      // The stations the tiles may read: the observation stations in view;
      // in the AQHI view, the remembered AQI-view stations in view.
      const candidates = isObservation
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
      const newest = _readings.reduce(
        (max, reading) => Math.max(max, reading.observedMs || 0),
        0,
      );
      // One short line for each network that needs a key, failed, is out of
      // requests for now, or serves cached data.
      const providerLines = entries.flatMap((entry) => {
        const state = stateOf(entry);
        const text =
          state.status === 'no-key'
            ? t('{network}: add a key in Provider Settings', {
                network: entry.network,
              })
            : state.status === 'failed'
              ? t('{network} unavailable', { network: entry.network })
              : state.coverage?.failureStatus === 429
                ? t(
                    '{network}: request budget reached; cached data will refresh later',
                    { network: entry.network },
                  )
                : state.coverage?.stale === true
                  ? t('{network}: showing cached data', {
                      network: entry.network,
                    })
                  : '';
        return text ? [{ id: `provider-${entry.id}`, muted: true, text }] : [];
      });
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
      // The selected station as last seen: it stays while views change.
      const selected =
        selectedStation === null ? null : (selectedSeen?.reading ?? null);
      return {
        readout: true,
        summary: {
          label: single ? t(single.label) : t('Air quality'),
          // Where the drawn stations are: worldwide, or the networks'
          // countries; Canada for its index.
          coverage: !isObservation
            ? t('Canada')
            : drawing.some((entry) => entry.worldwide === true)
              ? t('Global')
              : drawing.map((entry) => t(entry.title)).join(' · '),
          validTime: newest ? new Date(newest).toISOString() : undefined,
          // Who measured what is drawn, and how fresh the newest reading is.
          detail:
            drawing.length && newest
              ? `${drawing.map((entry) => entry.network).join(', ')} · ${t(
                  'updated {age}',
                  { age: shortAgo(newest) },
                )}`
              : '',
          status: loading
            ? t('Loading')
            : covering.length && showStations
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
        sublists: tileGroups(selected, candidates, loading),
        list: {
          title: t('HIGHEST IN VIEW'),
          ariaLabel: isObservation
            ? t('Observations in view')
            : t('Highest air-quality readings in view'),
          // One line a row: rank, band colour, value, name. The station's
          // details are the row's tooltip.
          // Hidden with the stations.
          items: (showStations ? inView : []).map((reading, index) => {
            const owner = ownerOf(reading);
            return {
              id: reading.id,
              ordinal: index + 1,
              swatch: reading.color,
              lead: isObservation ? scaleText(reading) : reading.label,
              text: reading.name,
              title: isObservation
                ? `${reading.name} · ${reading.zone} · ${reading.owner || owner.network} · ${t(reading.averagingMinutes === 60 ? msg('Hourly average') : msg('Source averaging period unspecified'))} · ${new Date(reading.observedMs).toISOString()} · ${view === 'aqi' ? aqiDetails(reading, owner) : pollutantDetails(reading, owner)} · ${Date.now() - reading.observedMs > 2 * 3600_000 ? `${t('Older observation')} · ` : ''}${t('Provisional data')} · ${reading.network || owner.network}`
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
        // A slower provider still asking: the Layers row shows progress.
        loading: _enabled && isLoading(),
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
