import { formatNumber, msg, t } from '../../i18n/index.js';
import { spriteDrawOrder } from '../../data/spriteOrder.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { translateFeedError } from '../../ui/statusText.js';
import { createHorizonCull } from '../streetLevel/view.js';
import {
  SONDE_PROVENANCE,
  SONDE_STATES,
  sondeState,
  sondeTrackerUrl,
} from './records.js';
export * from './records.js';
export { createSondeSource } from './source.js';

export const SONDES_LAYER_ID = 'radiosondes';
export const SONDES_OVERLAY_SOURCE_ID = 'radiosondes';
const PICK_PREFIX = 'radiosonde:';
const MARKER_PX = 20;
const LANDING_PX = 18;
const PATH_COLOR = [255, 159, 67, 0.85];
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: true,
});
const STATE_LABELS = Object.freeze({
  rising: msg('Rising'),
  falling: msg('Falling'),
  silent: msg('Not heard for 15+ min'),
});
const colorOf = (state) =>
  SONDE_STATES.find(({ id }) => id === state)?.color ?? '#9aa3ad';
const utcTime = (ms) => new Date(ms).toISOString().slice(11, 16);

/** A balloon with its instrument hanging below, as an SVG data URL. */
export function sondeMarkerImage(color) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24">` +
    `<path d="M12 2.5c3.6 0 6 2.6 6 5.9c0 3.4-3.3 6.3-6 7.6c-2.7-1.3-6-4.2-6-7.6c0-3.3 2.4-5.9 6-5.9z" ` +
    `fill="${color}" stroke="#0b1016" stroke-width="1.2"/>` +
    `<path d="M12 16v4.2" stroke="#e8eef4" stroke-width="1.1"/>` +
    `<rect x="10.4" y="19.6" width="3.2" height="2.6" rx="0.4" fill="#e8eef4" stroke="#0b1016" stroke-width="0.7"/>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** A cross marking a predicted landing, as an SVG data URL. */
export function landingMarkerImage() {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 24 24">` +
    `<circle cx="12" cy="12" r="9" fill="rgba(11,16,22,0.55)" stroke="#ff9f43" stroke-width="2"/>` +
    `<path d="M7.5 7.5l9 9M16.5 7.5l-9 9" stroke="#ff9f43" stroke-width="2.4" stroke-linecap="round"/>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Title and detail lines for a sonde's card, in the page's language. */
export function describeSonde(row, { nowMs, prediction = null } = {}) {
  const details = [];
  if (row.altM !== null)
    details.push(
      t('Altitude {km} km', {
        km: formatNumber(row.altM / 1000, { maximumFractionDigits: 1 }),
      }),
    );
  const state = sondeState(row, nowMs);
  if (state === 'rising' || state === 'falling') {
    const rate = formatNumber(Math.abs(row.climbMps), {
      maximumFractionDigits: 1,
    });
    details.push(
      state === 'rising'
        ? t('Rising {rate} m/s', { rate })
        : t('Falling {rate} m/s', { rate }),
    );
  }
  if (row.speedMps !== null)
    details.push(
      t('Drifting {speed} km/h', {
        speed: formatNumber(Math.round(row.speedMps * 3.6)),
      }),
    );
  if (row.tempC !== null)
    details.push(
      t('Temperature {temp} °C', {
        temp: formatNumber(row.tempC, { maximumFractionDigits: 1 }),
      }),
    );
  if (row.humidityPct !== null)
    details.push(
      t('Humidity {humidity}%', {
        humidity: formatNumber(Math.round(row.humidityPct)),
      }),
    );
  if (row.pressureHpa !== null)
    details.push(
      t('Pressure {hpa} hPa', {
        hpa: formatNumber(row.pressureHpa, { maximumFractionDigits: 0 }),
      }),
    );
  const kit = [
    row.manufacturer,
    row.type,
    row.frequencyMhz !== null
      ? `${formatNumber(row.frequencyMhz, { maximumFractionDigits: 3 })} MHz`
      : null,
  ].filter(Boolean);
  if (kit.length) details.push(kit.join(' · '));
  details.push(t('Last heard {time} UTC', { time: utcTime(row.time) }));
  if (prediction?.landing?.time && state !== 'silent')
    details.push(
      t('Predicted landing {time} UTC', {
        time: utcTime(prediction.landing.time),
      }),
    );
  return { title: t('Radiosonde {serial}', { serial: row.serial }), details };
}

const validRow = (row) =>
  row &&
  typeof row.serial === 'string' &&
  Number.isFinite(row.time) &&
  Number.isFinite(row.lat) &&
  Number.isFinite(row.lon);
const orNull = (value) => (Number.isFinite(value) ? value : null);
const textOrNull = (value) =>
  typeof value === 'string' && value ? value.slice(0, 40) : null;

/**
 * Weather balloons: radiosondes that volunteer stations hear, from SondeHub,
 * drawn at their reported altitude and coloured by whether they are rising,
 * falling or no longer heard. Selecting one shows its card and, from
 * SondeHub's predictor, its forecast path and landing point.
 */
export function createRadiosondesLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  openExternal = null,
  input = (viewer) => inputFor(viewer),
  now = () => Date.now(),
  drawOf: drawPort = drawOf,
  frameOf = findFrame,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Radiosondes require a snapshot source');
  let _viewer = null;
  let _enabled = false;
  let _markers = null;
  let _paths = null;
  let _landing = null;
  let _request = null;
  let _predictionRequest = null;
  let _rows = new Map();
  let _pins = [];
  let _live = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _clickHandler = null;
  let _selected = null;
  let _selectedCardId = null;
  let _prediction = null;
  const _images = Object.fromEntries(
    SONDE_STATES.map(({ id, color }) => [id, sondeMarkerImage(color)]),
  );
  const _landingImage = landingMarkerImage();
  const changedPins = new Set();
  const canSelect = () => Boolean(overlayHost && picking);

  const render = () => {
    if (changedPins.size) {
      _markers?.upsert([...changedPins].map((pin) => pin.item));
      changedPins.clear();
    }
    if (_viewer) frameOf(_viewer)?.requestRender?.('radiosondes');
  };
  const horizon = createHorizonCull({
    getViewer: () => _viewer,
    items: () => _pins,
    onChange: render,
  });

  const positionOf = (row) =>
    fromDegrees(row.lon, row.lat, row.altM !== null ? row.altM : 0);

  function rebuild() {
    const at = now();
    changedPins.clear();
    // Silent ones first, so the active ones draw on top.
    const order = { silent: 0, falling: 1, rising: 2 };
    _pins = [..._rows.values()]
      .map((row) => ({ row, state: sondeState(row, at) }))
      .sort((a, b) => order[a.state] - order[b.state])
      .map(({ row, state }) => {
        const position = positionOf(row);
        return {
          item: {
            id: `${PICK_PREFIX}${row.serial}`,
            pos: position,
            image: _images[state],
            size: [MARKER_PX, MARKER_PX],
            anchor: 'bottom',
            alpha: state === 'silent' ? 0.7 : 1,
            height: row.altM !== null ? 'absolute' : 'clampGround',
            disableDepthTest: Number.POSITIVE_INFINITY,
            show: true,
          },
          row,
          state,
          position,
          get show() {
            return this.item.show;
          },
          set show(value) {
            if (this.item.show === value) return;
            this.item = { ...this.item, show: value };
            changedPins.add(this);
          },
        };
      });
    _markers?.set(_pins.map((pin) => pin.item));
    horizon.update();
    if (_selected && !_rows.has(_selected)) clearSelection();
    else if (_selected) publishCard();
    render();
  }

  function drawPrediction() {
    const row = _selected ? _rows.get(_selected) : null;
    const prediction =
      row && _prediction?.serial === row.serial ? _prediction : null;
    if (!prediction || sondeState(row, now()) === 'silent') {
      _paths?.clear();
      _landing?.clear();
      return;
    }
    // From where the balloon is now along the forecast, to the ground.
    const ahead = prediction.path.filter(
      (point) => point.time === null || point.time >= row.time,
    );
    const positions = [
      positionOf(row),
      ...ahead.map((point) => fromDegrees(point.lon, point.lat, point.altM)),
    ];
    _paths?.set([
      {
        id: `radiosonde-path:${row.serial}`,
        positions,
        widthPx: 2,
        mode: '3d',
        style: { kind: 'solid', color: PATH_COLOR },
        depthFail: null,
      },
    ]);
    _landing?.set([
      {
        id: `radiosonde-landing:${row.serial}`,
        pos: fromDegrees(prediction.landing.lon, prediction.landing.lat, 0),
        image: _landingImage,
        size: [LANDING_PX, LANDING_PX],
        height: 'clampGround',
        disableDepthTest: Number.POSITIVE_INFINITY,
        pickable: false,
      },
    ]);
  }

  async function loadPrediction(serial) {
    _predictionRequest?.abort();
    if (typeof source.getPrediction !== 'function') return;
    const request = new AbortController();
    _predictionRequest = request;
    try {
      const prediction = await source.getPrediction(serial, {
        signal: request.signal,
      });
      if (request.signal.aborted || _selected !== serial) return;
      _prediction = prediction ? { ...prediction, serial } : null;
    } catch (error) {
      if (request.signal.aborted) return;
      console.warn('[Data:Radiosondes] Prediction error:', error);
      _prediction = null;
    } finally {
      if (_predictionRequest === request) _predictionRequest = null;
    }
    if (_selected === serial) {
      publishCard();
      render();
    }
  }

  function publishCard() {
    if (!canSelect()) return;
    const row = _selected ? _rows.get(_selected) : null;
    if (!row) return clearSelection();
    const at = now();
    const prediction = _prediction?.serial === row.serial ? _prediction : null;
    const { title, details } = describeSonde(row, { nowMs: at, prediction });
    const card = {
      id: `radiosonde-card:${row.serial}`,
      selected: true,
      interactive: Boolean(openExternal),
      title,
      details,
      accent: colorOf(sondeState(row, at)),
      priority: Number.MAX_SAFE_INTEGER,
      gapPx: 15,
      verticalOnly: true,
      placement: 'above',
      stateless: true,
      horizonCull: true,
      position: positionOf(row),
    };
    if (card.interactive) {
      card.accessibilityLabel = t('Open the source for {title}', { title });
      card.activate = () => {
        openExternal(sondeTrackerUrl(row.serial));
        return true;
      };
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(SONDES_OVERLAY_SOURCE_ID, [card], CARD_HOST_OPTIONS);
    overlayHost.setVisible?.(SONDES_OVERLAY_SOURCE_ID, true);
    drawPrediction();
  }

  function clearSelection() {
    _selected = null;
    _selectedCardId = null;
    _prediction = null;
    _predictionRequest?.abort();
    _predictionRequest = null;
    _paths?.clear();
    _landing?.clear();
    overlayHost?.setEntries(SONDES_OVERLAY_SOURCE_ID, [], CARD_HOST_OPTIONS);
  }

  function select(serial) {
    if (_selected !== serial) {
      _prediction = null;
      _paths?.clear();
      _landing?.clear();
    }
    _selected = serial;
    publishCard();
    render();
    void loadPrediction(serial);
  }

  function pickedSerial(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const serial = pickId.slice(PICK_PREFIX.length);
    return _rows.has(serial) ? serial : null;
  }

  function installClicks() {
    if (!_viewer || !canSelect() || _clickHandler) return;
    picking.registerPickOwner?.(
      SONDES_LAYER_ID,
      (pickedId) =>
        typeof pickedId === 'string' && pickedId.startsWith(PICK_PREFIX),
    );
    let clicks = null;
    try {
      clicks = input(_viewer) ?? null;
    } catch {
      clicks = null;
    }
    if (!clicks) return;
    _clickHandler = clicks.onClick((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = picking.clickCard?.(click) ?? null;
      if (cardHit) {
        if (
          cardHit.sourceId === SONDES_OVERLAY_SOURCE_ID &&
          cardHit.entryId === _selectedCardId &&
          openExternal &&
          _selected
        )
          openExternal(sondeTrackerUrl(_selected));
        return;
      }
      const picked = click.topHit;
      const pickId = picked ? (picking.resolvePickId(picked) ?? null) : null;
      const serial = pickedSerial(pickId);
      if (serial) {
        select(serial);
        return;
      }
      if (pickId && picking.isOwnedByOtherLayer(SONDES_LAYER_ID, pickId))
        return;
      if (_selected) {
        clearSelection();
        render();
      }
    });
  }

  function removeClicks() {
    _clickHandler?.();
    _clickHandler = null;
    picking?.unregisterPickOwner?.(SONDES_LAYER_ID);
  }

  function stateCounts() {
    const at = now();
    const counts = Object.fromEntries(SONDE_STATES.map(({ id }) => [id, 0]));
    for (const row of _rows.values()) counts[sondeState(row, at)] += 1;
    return counts;
  }

  const layer = {
    id: SONDES_LAYER_ID,
    name: 'Weather Balloons',
    icon: '🎈',
    source: 'SondeHub',
    provenance: SONDE_PROVENANCE,
    // The local mirror follows the live feed; this only reads the mirror.
    updateInterval: 15_000,

    init(viewer) {
      if (_viewer) throw new Error('Radiosondes layer is already initialized');
      _viewer = viewer;
      const draws = drawPort(viewer);
      _markers = draws.icons({
        id: 'radiosondes:markers',
        blend: 'translucent',
        drawOrder: spriteDrawOrder(SONDES_LAYER_ID),
        show: false,
      });
      _paths = draws.lines({ id: 'radiosondes:prediction', show: false });
      _landing = draws.icons({
        id: 'radiosondes:landing',
        blend: 'translucent',
        drawOrder: spriteDrawOrder(SONDES_LAYER_ID),
        show: false,
      });
    },

    enable() {
      _enabled = true;
      for (const set of [_markers, _paths, _landing]) if (set) set.show = true;
      installClicks();
      if (_pins.length) horizon.update();
      render();
    },

    disable() {
      _enabled = false;
      _request?.abort();
      _request = null;
      for (const set of [_markers, _paths, _landing]) if (set) set.show = false;
      removeClicks();
      clearSelection();
      horizon.stop();
      render();
    },

    async update(_viewerArg, { signal } = {}) {
      if (!_enabled || !_markers || signal?.aborted) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      const onAbort = () => request.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      let snapshot;
      try {
        snapshot = await source.getSnapshot({ signal: request.signal });
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Radiosondes] Fetch error:', error);
        _lastError = error?.message || String(error);
        return error?.retryable !== false || _rows.size > 0;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (_request === request) _request = null;
      }
      if (request.signal.aborted || !_enabled) return false;
      _rows = new Map(
        snapshot.rows.filter(validRow).map((row) => [
          row.serial,
          {
            serial: row.serial.slice(0, 32),
            time: row.time,
            lat: row.lat,
            lon: row.lon,
            altM: orNull(row.altM),
            climbMps: orNull(row.climbMps),
            speedMps: orNull(row.speedMps),
            headingDeg: orNull(row.headingDeg),
            type: textOrNull(row.type),
            manufacturer: textOrNull(row.manufacturer),
            frequencyMhz: orNull(row.frequencyMhz),
            tempC: orNull(row.tempC),
            humidityPct: orNull(row.humidityPct),
            pressureHpa: orNull(row.pressureHpa),
          },
        ]),
      );
      _live = snapshot.live;
      _lastUpdate = snapshot.fetchedAt ?? now();
      _lastError = null;
      rebuild();
      return true;
    },

    destroy() {
      layer.disable();
      _markers?.dispose();
      _paths?.dispose();
      _landing?.dispose();
      _markers = _paths = _landing = null;
      _viewer = null;
      _rows = new Map();
      _pins = [];
      _lastUpdate = null;
      _lastError = null;
    },

    getRowControls() {
      const counts = stateCounts();
      return {
        chips: [],
        info: _lastError
          ? translateFeedError(_lastError)
          : _lastUpdate && !_live
            ? t('Reconnecting to the live feed')
            : '',
        infoTitle: t(
          'Radiosondes (weather balloons) heard in the last three hours by volunteer receiving stations, from SondeHub, drawn at their reported altitude. National weather services launch them twice a day, mostly near 00:00 and 12:00 UTC. Select one for its readings and SondeHub’s predicted path and landing. Coverage is only where volunteers listen, and sensor readings are uncalibrated.',
        ),
        legend: SONDE_STATES.map(({ id, color }) => ({
          label: t(STATE_LABELS[id]),
          color,
          count: counts[id],
        })),
      };
    },

    /** The sondes as plain records, for Context and analyst reads. */
    getAnalystRecords(maxCount = Infinity) {
      if (!_enabled) return [];
      const records = [];
      for (const row of _rows.values()) {
        if (records.length >= maxCount) break;
        records.push({
          id: row.serial,
          key: `${PICK_PREFIX}${row.serial}`,
          name: `Radiosonde ${row.serial}`,
          lat: row.lat,
          lon: row.lon,
          altitudeM: row.altM,
          verticalRateMps: row.climbMps,
          observedMs: row.time,
          type: row.type,
          manufacturer: row.manufacturer,
        });
      }
      return records;
    },

    getStats() {
      return {
        count: _rows.size,
        states: stateCounts(),
        live: _live,
        lastUpdate: _lastUpdate,
        error: _lastError,
        provenance: SONDE_PROVENANCE,
        // Load-bearing: without an explicit boolean, layerFeedState reads the
        // source name as a fallback (src/data/feedState.js).
        fallback: false,
      };
    },
  };
  return layer;
}
