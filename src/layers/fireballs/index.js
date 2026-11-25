import { formatDate, formatNumber, msg, t } from '../../i18n/index.js';
import { spriteDrawOrder } from '../../data/spriteOrder.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { translateFeedError } from '../../ui/statusText.js';
import { createHorizonCull } from '../streetLevel/view.js';
import {
  FIREBALL_AGE_BANDS,
  FIREBALL_PROVENANCE,
  fireballAgeBand,
  fireballMarkerSize,
} from './records.js';
export * from './records.js';
export { createFireballSource } from './source.js';

export const FIREBALLS_LAYER_ID = 'fireballs';
export const FIREBALLS_OVERLAY_SOURCE_ID = 'fireballs';
const PICK_PREFIX = 'fireball:';
const CNEOS_URL = 'https://cneos.jpl.nasa.gov/fireballs/';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const BAND_LABELS = Object.freeze({
  month: msg('Last 30 days'),
  year: msg('Last 12 months'),
  older: msg('Older'),
});
const EVENT_TIME = Object.freeze({
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

/** A burst of light in the band's colour, as an SVG data URL. */
export function fireballMarkerImage(color) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 32 32">` +
    `<defs><radialGradient id="g"><stop offset="0" stop-color="#fffbe8"/>` +
    `<stop offset="0.35" stop-color="${color}"/>` +
    `<stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient></defs>` +
    `<circle cx="16" cy="16" r="15" fill="url(#g)"/>` +
    `<path d="M16 3v26M3 16h26M7 7l18 18M25 7L7 25" stroke="#fffbe8" stroke-width="1" stroke-opacity="0.55"/>` +
    `<circle cx="16" cy="16" r="3.2" fill="#ffffff"/>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const degrees = (value, positive, negative) =>
  `${formatNumber(Math.abs(value), { maximumFractionDigits: 1 })}°${value < 0 ? negative : positive}`;

/** Title and detail lines for an event's card, in the page's language. */
export function describeFireball(event) {
  const details = [
    `${degrees(event.lat, 'N', 'S')} ${degrees(event.lon, 'E', 'W')}`,
  ];
  if (event.impactEnergyKt !== null)
    details.push(
      t('Estimated impact energy {kt} kt TNT', {
        kt: formatNumber(event.impactEnergyKt, { maximumSignificantDigits: 2 }),
      }),
    );
  if (event.radiatedEnergy !== null)
    details.push(
      t('Radiated energy {energy} × 10¹⁰ J', {
        energy: formatNumber(event.radiatedEnergy, {
          maximumSignificantDigits: 3,
        }),
      }),
    );
  if (event.altKm !== null)
    details.push(
      t('Peak brightness at {km} km', {
        km: formatNumber(event.altKm, { maximumFractionDigits: 1 }),
      }),
    );
  if (event.velocityKms !== null)
    details.push(
      t('Speed {speed} km/s', {
        speed: formatNumber(event.velocityKms, { maximumFractionDigits: 1 }),
      }),
    );
  return {
    title: t('Fireball {time}', { time: formatDate(event.time, EVENT_TIME) }),
    details,
  };
}

const validRow = (row) =>
  row &&
  typeof row.id === 'string' &&
  Number.isFinite(row.time) &&
  Number.isFinite(row.lat) &&
  Number.isFinite(row.lon) &&
  Math.abs(row.lat) <= 90 &&
  Math.abs(row.lon) <= 180;
const orNull = (value) => (Number.isFinite(value) ? value : null);

/**
 * Fireballs: bright meteors and bolides that U.S. Government sensors detected,
 * from NASA/JPL CNEOS, drawn where each peaked in brightness (at that height
 * when it is known), sized by estimated impact energy and coloured by age.
 */
export function createFireballsLayer({
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
    throw new TypeError('Fireballs require a snapshot source');
  let _viewer = null;
  let _enabled = false;
  let _markers = null;
  let _request = null;
  let _events = new Map();
  let _pins = [];
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _clickHandler = null;
  let _selectedId = null;
  let _selectedCardId = null;
  const _images = Object.fromEntries(
    FIREBALL_AGE_BANDS.map((band) => [
      band.id,
      fireballMarkerImage(band.color),
    ]),
  );
  const changedPins = new Set();
  const canSelect = () => Boolean(overlayHost && picking);

  const render = () => {
    if (changedPins.size) {
      _markers?.upsert([...changedPins].map((pin) => pin.item));
      changedPins.clear();
    }
    if (_viewer) frameOf(_viewer)?.requestRender?.('fireballs');
  };
  const horizon = createHorizonCull({
    getViewer: () => _viewer,
    items: () => _pins,
    onChange: render,
  });

  function rebuild(rows) {
    const at = now();
    _events = new Map(rows.map((row) => [row.id, row]));
    changedPins.clear();
    // Oldest first, so the newest draw on top.
    _pins = [...rows]
      .sort((a, b) => a.time - b.time)
      .map((event) => {
        const band = fireballAgeBand(event, at);
        const size = fireballMarkerSize(event);
        const lifted = event.altKm !== null;
        const position = fromDegrees(
          event.lon,
          event.lat,
          lifted ? event.altKm * 1000 : 0,
        );
        return {
          item: {
            id: `${PICK_PREFIX}${event.id}`,
            pos: position,
            image: _images[band.id],
            size: [size, size],
            height: lifted ? 'absolute' : 'clampGround',
            disableDepthTest: Number.POSITIVE_INFINITY,
            show: true,
          },
          event,
          band,
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
    if (_selectedId && !_events.has(_selectedId)) clearSelection();
    else if (_selectedId) publishCard();
    render();
  }

  function publishCard() {
    if (!canSelect()) return;
    const event = _selectedId ? _events.get(_selectedId) : null;
    if (!event) return clearSelection();
    const { title, details } = describeFireball(event);
    const card = {
      id: `fireball-card:${event.id}`,
      selected: true,
      interactive: Boolean(openExternal),
      title,
      details,
      accent: fireballAgeBand(event, now()).color,
      priority: Number.MAX_SAFE_INTEGER,
      gapPx: 15,
      verticalOnly: true,
      placement: 'above',
      stateless: true,
      horizonCull: true,
      position: fromDegrees(
        event.lon,
        event.lat,
        event.altKm !== null ? event.altKm * 1000 : 0,
      ),
    };
    if (card.interactive) {
      card.accessibilityLabel = t('Open the source for {title}', { title });
      card.activate = () => {
        openExternal(CNEOS_URL);
        return true;
      };
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(
      FIREBALLS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
    overlayHost.setVisible?.(FIREBALLS_OVERLAY_SOURCE_ID, true);
  }

  function clearSelection() {
    _selectedId = null;
    _selectedCardId = null;
    overlayHost?.setEntries(FIREBALLS_OVERLAY_SOURCE_ID, [], CARD_HOST_OPTIONS);
  }

  function pickedEventId(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _events.has(id) ? id : null;
  }

  function installClicks() {
    if (!_viewer || !canSelect() || _clickHandler) return;
    picking.registerPickOwner?.(
      FIREBALLS_LAYER_ID,
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
          cardHit.sourceId === FIREBALLS_OVERLAY_SOURCE_ID &&
          cardHit.entryId === _selectedCardId &&
          openExternal
        )
          openExternal(CNEOS_URL);
        return;
      }
      const picked = click.topHit;
      const pickId = picked ? (picking.resolvePickId(picked) ?? null) : null;
      const id = pickedEventId(pickId);
      if (id) {
        _selectedId = id;
        publishCard();
        render();
        return;
      }
      if (pickId && picking.isOwnedByOtherLayer(FIREBALLS_LAYER_ID, pickId))
        return;
      if (_selectedId) {
        clearSelection();
        render();
      }
    });
  }

  function removeClicks() {
    _clickHandler?.();
    _clickHandler = null;
    picking?.unregisterPickOwner?.(FIREBALLS_LAYER_ID);
  }

  function bandCounts() {
    const at = now();
    const counts = Object.fromEntries(
      FIREBALL_AGE_BANDS.map((band) => [band.id, 0]),
    );
    for (const event of _events.values())
      counts[fireballAgeBand(event, at).id] += 1;
    return counts;
  }

  const layer = {
    id: FIREBALLS_LAYER_ID,
    name: 'Fireballs',
    icon: '☄️',
    source: 'NASA/JPL CNEOS',
    provenance: FIREBALL_PROVENANCE,
    // Events are posted days to weeks after they happen.
    updateInterval: 60 * 60_000,

    init(viewer) {
      if (_viewer) throw new Error('Fireballs layer is already initialized');
      _viewer = viewer;
      _markers = drawPort(viewer).icons({
        id: 'fireballs:markers',
        blend: 'translucent',
        drawOrder: spriteDrawOrder(FIREBALLS_LAYER_ID),
        show: false,
      });
    },

    enable() {
      _enabled = true;
      if (_markers) _markers.show = true;
      installClicks();
      if (_pins.length) horizon.update();
      render();
    },

    disable() {
      _enabled = false;
      _request?.abort();
      _request = null;
      if (_markers) _markers.show = false;
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
        console.warn('[Data:Fireballs] Fetch error:', error);
        _lastError = error?.message || String(error);
        return error?.retryable !== false || _events.size > 0;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (_request === request) _request = null;
      }
      if (request.signal.aborted || !_enabled) return false;
      rebuild(
        snapshot.rows.filter(validRow).map((row) => ({
          id: row.id,
          time: row.time,
          lat: row.lat,
          lon: row.lon,
          altKm: orNull(row.altKm),
          velocityKms: orNull(row.velocityKms),
          radiatedEnergy: orNull(row.radiatedEnergy),
          impactEnergyKt: orNull(row.impactEnergyKt),
        })),
      );
      _lastUpdate = snapshot.fetchedAt ?? now();
      _stale = snapshot.stale;
      _lastError = null;
      return true;
    },

    destroy() {
      layer.disable();
      _markers?.dispose();
      _markers = null;
      _viewer = null;
      _events = new Map();
      _pins = [];
      _lastUpdate = null;
      _lastError = null;
    },

    getRowControls() {
      const counts = bandCounts();
      return {
        chips: [],
        info: _lastError ? translateFeedError(_lastError) : '',
        infoTitle: t(
          'Bright meteors and bolides detected by U.S. Government sensors since 1988, from NASA/JPL CNEOS, drawn where each was brightest (at that height when known) and sized by estimated impact energy. Events are posted days to weeks after they happen, and many smaller fireballs are never reported.',
        ),
        legend: FIREBALL_AGE_BANDS.map((band) => ({
          label: t(BAND_LABELS[band.id]),
          color: band.color,
          count: counts[band.id],
        })),
      };
    },

    /** The drawn events as plain records, for Context and analyst reads. */
    getAnalystRecords(maxCount = Infinity) {
      if (!_enabled) return [];
      const records = [];
      for (const event of _events.values()) {
        if (records.length >= maxCount) break;
        records.push({
          id: event.id,
          // The pick id, so a clicked marker finds its record.
          key: `${PICK_PREFIX}${event.id}`,
          name: `Fireball ${new Date(event.time).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
          lat: event.lat,
          lon: event.lon,
          eventTime: event.time,
          impactEnergyKilotonsTnt: event.impactEnergyKt,
          radiatedEnergyE10J: event.radiatedEnergy,
          speedMps:
            event.velocityKms === null ? null : event.velocityKms * 1000,
        });
      }
      return records;
    },

    getStats() {
      return {
        count: _events.size,
        bands: bandCounts(),
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
        provenance: FIREBALL_PROVENANCE,
        // Load-bearing: without an explicit boolean, layerFeedState reads the
        // source name as a fallback (src/data/feedState.js).
        fallback: false,
      };
    },
  };
  return layer;
}
