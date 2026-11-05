import * as Cesium from 'cesium';
import { msg, t, formatDate } from '../../i18n/index.js';
import {
  SPC_REFRESH_MS,
  SPC_MAX_AGE_MS,
  spcProduct,
  spcBands,
  spcSnapshotState,
  spcSourceLink,
} from './records.js';
import { createSpcRendering } from './rendering.js';

const STATES = {
  loading: msg('Loading SPC outlook…'),
  empty: msg('No outlook polygons reported; consult SPC.'),
  expired: msg('SPC outlook expired; polygons hidden.'),
  stale: msg('Cached SPC outlook · source stale'),
  unavailable: msg('SPC outlook unavailable; retrying automatically.'),
};
const DISCLAIMER = msg(
  'NOAA/NWS Storm Prediction Center · Forecast outlook, not an active NWS warning. Risk areas are not additive.',
);
const TORNADO_HELP = msg(
  'Probability of a tornado within 25 miles of a point. Significant-tornado hatching is not included.',
);
const utc = (time) =>
  time === null
    ? t('Unavailable')
    : `${formatDate(time, { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} UTC`;

/** SPC controller: manager-owned polling, transient selection, durable product options. */
export function createSpcOutlooksLayer({
  source,
  createRendering = createSpcRendering,
  eventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
  isPointerFree = () => true,
  hitTestOverlay = () => null,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('SPC requires a snapshot source');
  let viewer = null,
    rendering = null,
    snapshot = null,
    request = null,
    handler = null;
  let capturedRelease = null,
    removeCapture = null;
  let enabled = false,
    destroyed = false,
    loading = false,
    failed = false;
  let day = 'day1',
    type = 'categorical',
    selectedId = null,
    listener = null,
    expiryTimer = null;
  const notify = () => listener?.();
  const state = () => (loading ? 'loading' : spcSnapshotState(snapshot, now()));
  const clearExpiry = () => {
    if (expiryTimer !== null) clearTimer(expiryTimer);
    expiryTimer = null;
  };
  function armExpiry() {
    clearExpiry();
    if (!snapshot) return;
    const deadline = Math.min(
      snapshot.validUntil ?? Infinity,
      snapshot.fetchedAt + SPC_MAX_AGE_MS,
    );
    if (!Number.isFinite(deadline) || deadline <= now()) return;
    expiryTimer = setTimer(() => {
      expiryTimer = null;
      if (!enabled || destroyed) return;
      rendering?.clear();
      selectedId = null;
      notify();
    }, deadline - now());
  }
  function select(picked) {
    const captured = capturedRelease;
    capturedRelease = null;
    const position = picked?.position;
    const capturedHit =
      captured &&
      position &&
      Math.abs(captured.x - position.x) < 1 &&
      Math.abs(captured.y - position.y) < 1 &&
      captured.hit;
    if (
      !enabled ||
      !isPointerFree() ||
      !picked?.position ||
      capturedHit ||
      hitTestOverlay(picked.position.x, picked.position.y)
    )
      return;
    const hit = viewer.scene.pick(picked.position);
    const id = rendering.pickRow(hit);
    if (id !== null) {
      selectedId = id;
      notify();
    } else if (!hit || hit.id === undefined) {
      selectedId = null;
      notify();
    }
  }
  const layer = {
    id: 'severe-weather-outlooks',
    name: 'Severe Weather Outlooks',
    icon: '△',
    source: 'NOAA SPC',
    updateInterval: SPC_REFRESH_MS,
    init(nextViewer) {
      if (destroyed || viewer)
        throw new Error('SPC layer already initialized or destroyed');
      viewer = nextViewer;
      rendering = createRendering({ viewer });
    },
    enable() {
      if (enabled || destroyed) return;
      enabled = true;
      // Like fire perimeters, broad polygons must not claim pick ownership:
      // sibling world-overlay cards remain clickable over the forecast area.
      handler = eventHandlerFactory(viewer);
      const canvas = viewer.scene.canvas;
      // Snapshot before sibling bubble handlers can rebuild overlay hit boxes.
      const capture = (event) => {
        const point = event.changedTouches?.[0] || event;
        const rect = canvas.getBoundingClientRect();
        const x = point.clientX - rect.left,
          y = point.clientY - rect.top;
        capturedRelease = { x, y, hit: Boolean(hitTestOverlay(x, y)) };
      };
      const reset = () => {
        capturedRelease = null;
      };
      const releases = ['pointerup', 'mouseup', 'touchend'];
      const resets = [
        'pointerdown',
        'mousedown',
        'touchstart',
        'pointercancel',
        'touchcancel',
      ];
      for (const event of releases)
        canvas?.addEventListener?.(event, capture, { capture: true });
      for (const event of resets)
        canvas?.addEventListener?.(event, reset, { capture: true });
      removeCapture = () => {
        for (const event of releases)
          canvas?.removeEventListener?.(event, capture, { capture: true });
        for (const event of resets)
          canvas?.removeEventListener?.(event, reset, { capture: true });
        capturedRelease = null;
      };
      handler.setInputAction(select, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },
    disable() {
      enabled = false;
      request?.abort();
      request = null;
      clearExpiry();
      handler?.destroy();
      handler = null;
      removeCapture?.();
      removeCapture = null;
      snapshot = null;
      selectedId = null;
      loading = false;
      failed = false;
      rendering?.clear();
      notify();
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled || destroyed) return false;
      request?.abort();
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      if (signal?.aborted) abort();
      signal?.addEventListener('abort', abort, { once: true });
      request = controller;
      loading = true;
      notify();
      try {
        const next = await source.getSnapshot({
          product: spcProduct(day, type),
          signal: controller.signal,
        });
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        snapshot = next;
        failed = false;
        const current = spcSnapshotState(snapshot, now());
        if (['expired', 'unavailable'].includes(current)) rendering.clear();
        else rendering.setSnapshot(snapshot);
        if (!snapshot.rows.some((row) => row.id === selectedId))
          selectedId = null;
        armExpiry();
        return true;
      } catch {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        // A source error never promotes old geometry to fresh. Retain only
        // bounded, still-valid context and mark it visibly stale.
        failed = true;
        if (snapshot) snapshot = { ...snapshot, stale: true };
        if (
          ['expired', 'unavailable'].includes(spcSnapshotState(snapshot, now()))
        ) {
          rendering.clear();
          selectedId = null;
        }
        armExpiry();
        return true; // Keep the ordinary toggle on so manager polling retries.
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === controller) {
          request = null;
          loading = false;
          notify();
        }
      }
    },
    setParams(params = {}) {
      if (destroyed) return false;
      const nextDay = params.day ?? day,
        nextType = params.type ?? type;
      if (!spcProduct(nextDay, nextType)) return false;
      if (nextDay !== day || nextType !== type) {
        day = nextDay;
        type = nextType;
        request?.abort();
        request = null;
        clearExpiry();
        snapshot = null;
        selectedId = null;
        failed = false;
        rendering?.clear();
        if (enabled) void layer.update();
      }
      if (params.clear === true) selectedId = null;
      if (
        typeof params.selectedId === 'string' &&
        snapshot?.rows.some((row) => row.id === params.selectedId)
      )
        selectedId = params.selectedId;
      notify();
      return true;
    },
    getParams() {
      return { day, type };
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getRowControls() {
      const current = state();
      const status = STATES[current] ? t(STATES[current]) : null;
      const visible = !['expired', 'unavailable'].includes(
        spcSnapshotState(snapshot, now()),
      );
      const selected = visible
        ? snapshot?.rows.find((row) => row.id === selectedId)
        : null;
      const times =
        snapshot?.issuedAt !== null && snapshot?.issuedAt !== undefined
          ? [
              {
                id: 'issue',
                text: t('Issued {time}', { time: utc(snapshot.issuedAt) }),
              },
              {
                id: 'valid',
                text: t('Valid {start} – {end}', {
                  start: utc(snapshot.validFrom),
                  end: utc(snapshot.validUntil),
                }),
              },
            ]
          : [];
      const hazard =
        type === 'tornado'
          ? t('Tornado probability')
          : t('Categorical severe weather');
      return {
        readout: true,
        chips: [],
        legendCategorical: true,
        legend: spcBands(type).map((band) => ({
          color: band.fill,
          label: type === 'categorical' ? t(band.label) : band.label,
        })),
        summary: {
          label: t('Severe Weather Outlooks'),
          coverage: t('Contiguous U.S.'),
          detail: `${day === 'day1' ? t('Day 1') : t('Day 2')} · ${hazard}`,
          status,
          lines: [
            ...times,
            { id: 'disclaimer', text: t(DISCLAIMER) },
            ...(type === 'tornado'
              ? [{ id: 'probability', text: t(TORNADO_HELP) }]
              : []),
          ],
          settings: [
            {
              id: 'day',
              label: t('Forecast day'),
              chips: ['day1', 'day2'].map((value) => ({
                id: value,
                label: value === 'day1' ? t('Day 1') : t('Day 2'),
                active: day === value,
                params: { day: value },
              })),
            },
            {
              id: 'type',
              label: t('Outlook type'),
              chips: [
                {
                  id: 'categorical',
                  label: t('Categorical'),
                  active: type === 'categorical',
                  params: { type: 'categorical' },
                },
                {
                  id: 'tornado',
                  label: t('Tornado probability'),
                  active: type === 'tornado',
                  params: { type: 'tornado' },
                },
              ],
            },
          ],
          actions: [
            {
              id: 'source',
              label: t('Official SPC outlook ↗'),
              href: spcSourceLink(spcProduct(day, type)),
            },
          ],
          ...(selected
            ? {
                result: {
                  id: 'selection',
                  label: hazard,
                  clear: { params: { clear: true } },
                  lines: [
                    {
                      id: 'risk',
                      text:
                        type === 'categorical'
                          ? t(selected.label)
                          : selected.label,
                    },
                    ...times,
                  ],
                },
              }
            : {}),
        },
        list: {
          ariaLabel: t('SPC forecast areas'),
          items: visible
            ? (snapshot?.rows || []).map((row) => ({
                id: row.id,
                text: type === 'categorical' ? t(row.label) : row.label,
                active: row.id === selectedId,
                params: { selectedId: row.id },
              }))
            : [],
        },
      };
    },
    getStats() {
      const current = state();
      const visible = !['expired', 'unavailable'].includes(current);
      return {
        count: visible ? snapshot?.rows.length || 0 : 0,
        lastUpdate: snapshot?.fetchedAt ?? null,
        loading,
        status: current,
        stale: current === 'stale',
        empty: current === 'empty',
        error:
          failed && current === 'unavailable'
            ? msg('SPC outlook unavailable; retrying automatically.')
            : null,
      };
    },
    destroy() {
      if (destroyed) return;
      layer.disable();
      destroyed = true;
      rendering?.destroy();
      rendering = null;
      viewer = null;
      listener = null;
    },
  };
  return layer;
}
