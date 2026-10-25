import * as Cesium from 'cesium';
import { t, msg, formatNumber } from '../../i18n/index.js';
import {
  DEFAULT_PARAMS,
  DISPLAY_LIMIT,
  LAYER_ID,
  VOLTAGES,
  intersects,
  normalizeParams,
  recordColor,
  selectRecords,
} from './model.js';
import { createTransmissionDisplay, PICK_PREFIX } from './rendering.js';
import { transmissionCard } from './cards.js';

/** Own one bounded static snapshot, its optional filters, and one selected card. */
export function createTransmissionLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  screenSpaceEventHandlerFactory = null,
  openExternal = null,
  credits = null,
  createDisplay = createTransmissionDisplay,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Transmission requires a snapshot source');
  let viewer = null,
    enabled = false,
    snapshot = null,
    request = null,
    display = null;
  let params = { ...DEFAULT_PARAMS },
    selected = null,
    selectedPosition = null,
    clickHandler = null,
    notify = null;
  let removeMove = null,
    removeChanged = null,
    timer = null,
    epoch = 0,
    signature = null;
  let error = null,
    lastUpdate = null,
    selection = { filtered: [], visible: [], omitted: 0, zoomedOut: true };
  let outside = false;
  const cardOptions = { cohortLimit: 1, collisionCapacity: 1, moving: false };

  function clearCard() {
    selected = null;
    selectedPosition = null;
    overlayHost?.clearSource(LAYER_ID);
  }
  function publishCard() {
    const row = selection.visible.find((r) => r.id === selected);
    if (!row) return clearCard();
    const card = transmissionCard(row, snapshot.metadata.sourceTimestamp);
    card.position =
      selectedPosition ||
      Cesium.Cartesian3.fromDegrees(row.anchor.lon, row.anchor.lat);
    card.interactive = Boolean(openExternal);
    card.activate = () => {
      openExternal?.(`https://www.openstreetmap.org/${row.id}`);
      return true;
    };
    overlayHost?.setEntries(LAYER_ID, [card], cardOptions);
    viewer?.scene.requestRender?.();
  }
  function viewBounds() {
    const rect = viewer.camera.computeViewRectangle?.(
      viewer.scene.globe?.ellipsoid,
    );
    if (!rect) return null;
    const degrees = Cesium.Math.toDegrees;
    if (rect.west > rect.east)
      return [-180, degrees(rect.south), 180, degrees(rect.north)];
    return [
      degrees(rect.west),
      degrees(rect.south),
      degrees(rect.east),
      degrees(rect.north),
    ];
  }
  async function refreshView() {
    if (!enabled || !snapshot || !viewer) return;
    const view = viewBounds();
    outside = Boolean(view && !intersects(snapshot.metadata.bbox, view));
    selection = selectRecords(
      snapshot.rows,
      params,
      view,
      viewer.camera.positionCartographic?.height,
    );
    if (selected && !selection.visible.some((r) => r.id === selected))
      clearCard();
    const nextSignature = selection.visible.map((r) => r.id).join('|');
    notify?.();
    if (signature === nextSignature) return;
    signature = nextSignature;
    const generation = ++epoch;
    const target = viewer;
    let next;
    try {
      next = createDisplay(selection.visible, snapshot.metadata.bbox);
      await target.dataSources.add(next);
      if (!enabled || generation !== epoch || target !== viewer) {
        target.dataSources.remove(next, true);
        return;
      }
      if (display) target.dataSources.remove(display, true);
      display = next;
      error = null;
      credits?.show(target, layer);
      publishCard();
      target.scene.requestRender?.();
    } catch (cause) {
      if (next) target.dataSources.remove(next, true);
      if (generation === epoch && enabled) {
        if (display) target.dataSources.remove(display, true);
        display = null;
        selection.visible = [];
        clearCard();
        signature = null;
        error = msg('Transmission display unavailable');
        notify?.();
      }
      throw cause;
    }
  }
  function scheduleView() {
    if (!enabled || timer != null) return;
    timer = setTimeout(() => {
      timer = null;
      void refreshView().catch(() => {});
    }, 250);
  }
  function installInteraction() {
    picking?.registerPickOwner(LAYER_ID, (id) => id.startsWith(PICK_PREFIX));
    if (!screenSpaceEventHandlerFactory || clickHandler) return;
    clickHandler = screenSpaceEventHandlerFactory(viewer);
    clickHandler.setInputAction((click) => {
      if (!enabled || (pointer && !pointer.isPointerFree())) return;
      const hit = overlayHost?.hitTest?.(click.position.x, click.position.y);
      if (hit) {
        if (hit.sourceId === LAYER_ID && selected && openExternal)
          openExternal(`https://www.openstreetmap.org/${selected}`);
        return;
      }
      const picked = viewer.scene.pick(click.position);
      const id = picking?.resolvePickId(picked);
      if (id?.startsWith(PICK_PREFIX)) {
        const osmId = id.slice(PICK_PREFIX.length).split(':')[0];
        if (selection.visible.some((r) => r.id === osmId)) {
          selected = osmId;
          const row = selection.visible.find((r) => r.id === osmId);
          selectedPosition =
            row.kind === 'line'
              ? viewer.camera.pickEllipsoid?.(
                  click.position,
                  viewer.scene.globe?.ellipsoid,
                ) || null
              : null;
          publishCard();
        }
        return;
      }
      if (id && picking?.isOwnedByOtherLayer(LAYER_ID, id)) return;
      clearCard();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }
  function focusPilot() {
    if (!viewer || !enabled || viewer.trackedEntity) return;
    viewer.camera.cancelFlight();
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(18.645, -33.915, 125000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      duration: 1.2,
    });
  }
  const layer = {
    id: LAYER_ID,
    name: 'Transmission Infrastructure',
    icon: 'ϟ',
    source: 'OpenStreetMap',
    updateInterval: 0,
    statsRefreshInterval: 500,
    init(target) {
      if (viewer) throw new Error('Transmission is already initialized');
      viewer = target;
    },
    enable() {
      enabled = true;
      overlayHost?.setVisible(LAYER_ID, true);
      installInteraction();
      removeMove = viewer.camera.moveEnd.addEventListener(scheduleView);
      removeChanged = viewer.camera.changed?.addEventListener(scheduleView);
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled) return false;
      request?.abort();
      const own = new AbortController();
      request = own;
      const abort = () => own.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) own.abort();
      error = null;
      try {
        const next =
          snapshot || (await source.getSnapshot({ signal: own.signal }));
        if (own.signal.aborted || request !== own || !enabled) return false;
        snapshot = next;
        await refreshView();
        if (own.signal.aborted || request !== own || !enabled) return false;
        lastUpdate = Date.now();
        return true;
      } catch (cause) {
        if (own.signal.aborted || request !== own || !enabled) return false;
        error = msg('Transmission snapshot unavailable');
        return false;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === own) request = null;
        notify?.();
      }
    },
    disable() {
      enabled = false;
      ++epoch;
      request?.abort();
      request = null;
      clearTimeout(timer);
      timer = null;
      removeMove?.();
      removeMove = null;
      removeChanged?.();
      removeChanged = null;
      clickHandler?.destroy();
      clickHandler = null;
      picking?.unregisterPickOwner(LAYER_ID);
      clearCard();
      overlayHost?.setVisible(LAYER_ID, false);
      if (display) viewer?.dataSources.remove(display, true);
      display = null;
      signature = null;
      selection = { filtered: [], visible: [], omitted: 0, zoomedOut: true };
      credits?.hide(viewer, layer);
      viewer?.scene.requestRender?.();
    },
    destroy() {
      layer.disable();
      snapshot = null;
      viewer = null;
      notify = null;
      lastUpdate = null;
      error = null;
    },
    getParams() {
      return { ...params };
    },
    setParams(patch) {
      params = normalizeParams(params, patch);
      void refreshView().catch(() => {});
      return { ...params };
    },
    setRowControlsListener(listener) {
      notify = listener;
    },
    getStats() {
      const known = selection.filtered.filter(
        (r) => r.voltageState === 'known',
      );
      return {
        count: selection.filtered.length,
        lastUpdate,
        loading: Boolean(request),
        error,
        lineCount: known.filter((r) => r.kind === 'line').length,
        substationCount: known.filter((r) => r.kind === 'substation').length,
        unknownCount: selection.filtered.length - known.length,
        displayedCount: selection.visible.length,
        omittedCount: selection.omitted,
        displayLimit: DISPLAY_LIMIT,
        entityCount: display?.entities.values.length || 0,
        outsideCoverage: outside,
        zoomedOut: selection.zoomedOut,
        selectedId: selected,
        sourceTimestamp: snapshot?.metadata.sourceTimestamp || null,
        countLabel: t('{count} mapped', {
          count: formatNumber(selection.filtered.length),
        }),
      };
    },
    getRowControls() {
      const known = selection.filtered.filter(
        (r) => r.voltageState === 'known',
      );
      const date =
        snapshot?.metadata.sourceTimestamp?.slice(0, 10) || '2026-10-22';
      let info = t(
        'Cape Town pilot · {date}. Missing tags do not mean missing infrastructure.',
        { date },
      );
      if (outside) info += ` ${t('Outside pilot coverage')}`;
      else if (selection.zoomedOut)
        info += ` ${t('Zoom in to see transmission infrastructure')}`;
      if (selection.omitted)
        info += ` ${t('{count} records omitted by the display limit', { count: formatNumber(selection.omitted) })}`;
      return {
        chips: [
          {
            id: 'focus',
            label: t('Cape Town pilot'),
            title: t('Show pilot coverage'),
            disabled: Boolean(viewer?.trackedEntity),
            onClick: focusPilot,
          },
          {
            id: 'all',
            label: t('All voltages'),
            active: params.voltage === 'all',
            params: { voltage: 'all' },
          },
          ...VOLTAGES.map((v) => ({
            id: `voltage-${v}`,
            // i18n-ignore: kV is the SI unit symbol
            label: `${formatNumber(v / 1000)} kV`,
            active: params.voltage === String(v),
            params: { voltage: String(v) },
            color: recordColor({ voltages: [v] }),
          })),
          {
            id: 'unknown',
            label: t('Voltage unknown'),
            title: t('Show substations with unknown voltage'),
            active: params.showUnknown,
            params: { showUnknown: !params.showUnknown },
          },
        ],
        legend: [
          { label: t('Tagged ≥110 kV'), color: '#f2cc60', count: known.length },
          {
            label: t('Voltage unknown'),
            color: '#b7c1cb',
            count: selection.filtered.length - known.length,
            blurb: t(
              'Unknown-voltage substations are not confirmed transmission sites',
            ),
          },
        ],
        info,
      };
    },
  };
  return layer;
}
