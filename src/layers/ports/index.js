import { formatNumber, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { createHorizonCull } from '../streetLevel/view.js';
import { PORT_FACILITIES, portProfileLines, visibleWpiPort } from './records.js';

export const PORTS_LAYER_ID = 'ports';
const PICK_PREFIX = 'ports:';
const CARD_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const MARKER =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">' +
      '<circle cx="36" cy="36" r="33" fill="#123e45" stroke="#4bc6ca" stroke-width="3"/>' +
      '<path d="M36 10v39M23 21h26M20 42c7 14 25 14 32 0M12 40l8 2M60 40l-8 2" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/>' +
      '<circle cx="36" cy="10" r="5" fill="#ffffff"/>' +
      '</svg>',
  );

/**
 * Reference-only NGA WPI ports layer. Country and facility filters are
 * session-local, while the layer toggle has its own durable share token.
 */
export function createPortsLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  input = (viewer) => inputFor(viewer),
  now = Date.now,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Ports require a snapshot source');

  let viewer = null;
  let markers = null;
  let enabled = false;
  let pending = null;
  let clickOff = null;
  let snapshot = null;
  let lastError = null;
  let selectedId = null;
  let country = '';
  let facility = 'all';
  let rowListener = null;
  let records = new Map();
  let pins = [];
  const changed = new Set();

  const draw = () => {
    if (changed.size) {
      markers?.upsert([...changed].map((pin) => pin.item));
      changed.clear();
    }
    if (viewer) findFrame(viewer)?.requestRender('ports');
  };
  const notify = () => rowListener?.();
  const visible = (record) =>
    visibleWpiPort(record, { country, facility });
  const horizon = createHorizonCull({
    getViewer: () => viewer,
    items: () => pins,
    onChange: draw,
  });
  function setPinVisibility(pin) {
    const show = enabled && pin.inFront && visible(pin.record);
    if (pin.item.show !== show) {
      pin.item = { ...pin.item, show };
      changed.add(pin);
    }
  }
  function clearCard() {
    selectedId = null;
    overlayHost?.setEntries(PORTS_LAYER_ID, [], CARD_OPTIONS);
  }
  function showCard() {
    if (!selectedId || !overlayHost) return;
    const port = records.get(selectedId);
    if (!port || !visible(port)) {
      clearCard();
      return;
    }
    overlayHost.setEntries(
      PORTS_LAYER_ID,
      [
        {
          id: `ports-card:${port.wpiNumber}`,
          title: port.name,
          details: portProfileLines(port),
          selected: true,
          priority: Number.MAX_SAFE_INTEGER,
          accent: '#4bc6ca',
          verticalOnly: true,
          placement: 'above',
          stateless: true,
          horizonCull: true,
          position: fromDegrees(port.lon, port.lat),
        },
      ],
      CARD_OPTIONS,
    );
    overlayHost.setVisible?.(PORTS_LAYER_ID, true);
  }
  function applyFilters() {
    for (const pin of pins) setPinVisibility(pin);
    if (selectedId && !visible(records.get(selectedId))) clearCard();
    draw();
    notify();
  }
  function rebuild(portRecords) {
    records = new Map(portRecords.map((port) => [port.id, port]));
    pins = portRecords.map((port) => {
      const pin = {
        record: port,
        inFront: true,
        item: {
          id: `${PICK_PREFIX}${port.wpiNumber}`,
          pos: fromDegrees(port.lon, port.lat),
          image: MARKER,
          size: [20, 20],
          height: 'clampGround',
          disableDepthTest: Number.POSITIVE_INFINITY,
          show: enabled && visible(port),
        },
        get show() {
          return this.inFront;
        },
        set show(value) {
          this.inFront = value;
          setPinVisibility(this);
        },
      };
      return pin;
    });
    changed.clear();
    markers?.set(pins.map((pin) => pin.item));
    horizon.update();
    if (selectedId && !records.has(selectedId)) clearCard();
    else if (selectedId) showCard();
    draw();
  }
  function attachClicks() {
    if (!viewer || clickOff || !picking || !overlayHost) return;
    picking.registerPickOwner?.(
      PORTS_LAYER_ID,
      (value) => typeof value === 'string' && value.startsWith(PICK_PREFIX),
    );
    let dispatcher;
    try {
      dispatcher = input(viewer);
    } catch {
      dispatcher = null;
    }
    if (!dispatcher) return;
    clickOff = dispatcher.onClick((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      if (picking.clickCard?.(click)) return;
      const id = click.topHit
        ? picking.resolvePickId?.(click.topHit)
        : null;
      if (typeof id === 'string' && id.startsWith(PICK_PREFIX)) {
        const key = `wpi:${id.slice(PICK_PREFIX.length)}`;
        if (visible(records.get(key))) {
          selectedId = key;
          showCard();
          draw();
          return;
        }
      }
      if (id && picking.isOwnedByOtherLayer?.(PORTS_LAYER_ID, id))
        return;
      if (selectedId) clearCard();
    });
  }
  function removeClicks() {
    clickOff?.();
    clickOff = null;
    picking?.unregisterPickOwner?.(PORTS_LAYER_ID);
  }
  const layer = {
    id: PORTS_LAYER_ID,
    name: 'Ports & terminals',
    icon: '⚓',
    source: 'NGA World Port Index · DOE NETL mirror',
    updateInterval: REFRESH_INTERVAL_MS,

    init(nextViewer) {
      if (viewer) throw new Error('Ports already initialized');
      viewer = nextViewer;
      markers = drawOf(viewer).icons({
        id: 'ports:markers',
        blend: 'translucent',
        show: false,
      });
    },
    enable() {
      enabled = true;
      if (markers) markers.show = true;
      attachClicks();
      if (pins.length) horizon.update();
      applyFilters();
    },
    disable() {
      enabled = false;
      pending?.abort();
      pending = null;
      if (markers) markers.show = false;
      removeClicks();
      clearCard();
      horizon.stop();
      draw();
    },
    async update() {
      if (!enabled || !markers) return false;
      pending?.abort();
      const request = new AbortController();
      pending = request;
      try {
        const result = await source.getSnapshot({ signal: request.signal });
        if (!enabled || request.signal.aborted || pending !== request)
          return false;
        const unchanged =
          result.version === snapshot?.version && pins.length > 0;
        snapshot = result;
        lastError = result.partial
          ? 'WPI pagination limit reached — showing partial data'
          : null;
        if (!unchanged) rebuild(result.records);
        notify();
        return true;
      } catch (error) {
        if (!enabled || request.signal.aborted || pending !== request)
          return false;
        lastError = error?.message || 'World Port Index unavailable';
        if (snapshot) {
          if (now() - snapshot.retrievedAt > MAX_STALE_MS) {
            snapshot = null;
            rebuild([]);
          } else snapshot = { ...snapshot, stale: true };
        }
        notify();
        return false;
      } finally {
        if (pending === request) pending = null;
      }
    },
    destroy() {
      layer.disable();
      markers?.dispose();
      markers = null;
      records.clear();
      pins = [];
      snapshot = null;
      viewer = null;
      rowListener = null;
    },
    getParams() {
      return { country, facility };
    },
    setParams(params = {}) {
      const knownCountries = new Set(
        [...records.values()].map((port) => port.country).filter(Boolean),
      );
      const nextCountry =
        params.country === ''
          ? ''
          : knownCountries.has(params.country)
            ? params.country
            : country;
      const nextFacility =
        params.facility === 'all' ||
        PORT_FACILITIES.some((entry) => entry.id === params.facility)
          ? params.facility
          : facility;
      if (country === nextCountry && facility === nextFacility)
        return true;
      country = nextCountry;
      facility = nextFacility;
      applyFilters();
      return true;
    },
    setRowControlsListener(listener) {
      rowListener = listener;
    },
    getRowControls() {
      const countries = [
        ...new Set(
          [...records.values()].map((port) => port.country).filter(Boolean),
        ),
      ].sort();
      const shown = [...records.values()].filter(visible).length;
      return {
        segmented: {
          id: 'port-facilities',
          label: t('Facility'),
          options: [
            { id: 'facility-all', label: t('All'), value: 'all' },
            ...PORT_FACILITIES.map(({ id, label }) => ({
              id: `facility-${id}`,
              label: t(label),
              value: id,
            })),
          ].map(({ id, label, value }) => ({
            id,
            label,
            active: facility === value,
            params: { facility: value },
          })),
        },
        list: {
          ariaLabel: t('Country filter'),
          items: [
            { id: 'country-all', text: t('All countries'), code: '' },
            ...countries.map((code) => ({
              id: `country-${code}`,
              text: code,
              code,
            })),
          ].map(({ id, text, code }) => ({
            id,
            text,
            lead: code ? '🌐' : '🌍',
            active: code === country,
            params: { country: code },
          })),
        },
        chips: [],
        info: `${formatNumber(shown)} / ${formatNumber(records.size)} ports · ${snapshot?.partial ? 'PARTIAL · ' : ''}${snapshot?.stale ? 'STALE · ' : ''}NGA WPI (NETL mirror)`,
        infoTitle: t(
          'NGA reference data only. A listed port is not evidence it is operational. Facility filters include affirmative values only. Country and facility filters remain session-local.',
        ),
      };
    },
    getStats() {
      return {
        count: enabled
          ? [...records.values()].filter(visible).length
          : 0,
        lastUpdate: snapshot?.retrievedAt ?? null,
        stale: snapshot?.stale === true || snapshot?.partial === true,
        error: lastError,
      };
    },
    getAnalystRecords(maxCount = 2000) {
      if (!enabled) return [];
      return [...records.values()]
        .filter(visible)
        .slice(0, maxCount);
    },
  };
  return layer;
}
