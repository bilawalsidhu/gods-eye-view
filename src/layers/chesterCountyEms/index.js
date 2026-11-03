import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';

const ID = 'chester-county-ems';
const SELECTED = `${ID}-selected`;
const STYLES = {
  fire: {
    symbol: '🔥',
    color: '#ff8a35',
    path: '<path fill="#ff761a" d="M32 7c3 13 17 16 17 30a17 17 0 1 1-34 0c0-9 7-14 9-20 1 9 5 9 5 9s5-9 3-19Z"/><path fill="#ffe869" d="M33 31c1 8 8 9 8 16a9 9 0 1 1-18 0c0-5 6-8 10-16Z"/>',
  },
  ems: {
    symbol: '✚',
    color: '#ff3b45',
    path: '<path fill="#ed2438" d="M24 12h16v12h12v16H40v12H24V40H12V24h12Z"/>',
  },
  traffic: {
    symbol: '🚨',
    color: '#7caeff',
    path: '<path fill="#e92c42" d="M15 43V28a17 17 0 0 1 17-17v32Z"/><path fill="#3285ff" d="M32 11a17 17 0 0 1 17 17v15H32Z"/><path stroke="#fff" stroke-width="4" d="M8 49h48M32 3v5M6 19l7 4M58 19l-7 4"/>',
  },
};
for (const style of Object.values(STYLES))
  style.image =
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#10202b" stroke="white" stroke-width="2"/>${style.path}</svg>`,
    );
const styleFor = (row) => STYLES[row.category] || STYLES.ems;
const detailLink = (row) => {
  try {
    const url = new URL(row.detailUrl);
    return url.origin === 'https://webcad.chesco.org' &&
      url.pathname === `/WebCad/livecadcomments-${row.category}.asp` &&
      url.searchParams.get('incidentno') === row.incidentNumber &&
      !url.username &&
      !url.password &&
      !url.hash
      ? url.href
      : null;
  } catch {
    return null;
  }
};
// Like the S2 cards, keep source text readable within the canvas card width.
const wrap = (value) =>
  String(value)
    .match(/.{1,60}(?:\s|$)|.{1,60}/g)
    ?.map((line) => line.trim())
    .slice(0, 2) || [];

/** Display county incidents at approximate street intersections or address points. */
export function createChesterCountyEmsLayer({
  source,
  overlayHost,
  openExternal,
  screenSpaceEventHandlerFactory,
  picking,
  pointer,
}) {
  let viewer, dataSource, request, listener;
  let enabled = false;
  let snapshot = null;
  let error = null;
  let selected = null;
  let clickHandler, detailsRequest;
  let detail = null,
    detailsError = false;
  function clearSelection() {
    detailsRequest?.abort();
    detailsRequest = null;
    detail = null;
    detailsError = false;
    selected = null;
    overlayHost.clearSource(SELECTED);
  }
  async function loadDetails() {
    detailsRequest?.abort();
    detailsRequest = null;
    const row = snapshot?.rows.find((row) => row.id === selected);
    if (!row || !detailLink(row) || !source.getIncidentDetails) return;
    const current = new AbortController();
    detailsRequest = current;
    detailsError = false;
    renderSelection();
    try {
      const result = await source.getIncidentDetails(row.id, {
        signal: current.signal,
      });
      if (
        current.signal.aborted ||
        detailsRequest !== current ||
        !enabled ||
        selected !== row.id
      )
        return;
      detail = result;
    } catch {
      if (
        current.signal.aborted ||
        detailsRequest !== current ||
        !enabled ||
        selected !== row.id
      )
        return;
      detailsError = true;
    } finally {
      if (detailsRequest === current) {
        detailsRequest = null;
        renderSelection();
        notify();
      }
    }
  }
  function select(id, fly = false) {
    const row = snapshot?.rows.find((row) => row.id === id);
    if (!enabled || !row) return;
    clearSelection();
    selected = row.id;
    renderSelection();
    notify();
    void loadDetails();
    if (fly && row.mapPosition)
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          row.mapPosition.lon,
          row.mapPosition.lat,
          1800,
        ),
      });
  }
  function installClickHandler() {
    if (!screenSpaceEventHandlerFactory || !picking || clickHandler) return;
    picking.registerPickOwner(ID, (id) => id.startsWith(`${ID}:`));
    clickHandler = screenSpaceEventHandlerFactory(viewer);
    clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const hit = overlayHost.hitTest?.(click.position?.x, click.position?.y, {
        sourceId: SELECTED,
      });
      if (hit?.entryId === selected) {
        const row = snapshot?.rows.find((row) => row.id === selected);
        const link = row && detailLink(row);
        if (link) openExternal?.(link);
        return;
      }
      const picked = viewer.scene.pick(click.position);
      const id = picking.resolvePickId(picked);
      if (id?.startsWith(`${ID}:`)) {
        select(id.slice(ID.length + 1));
        return;
      }
      if (id && picking.isOwnedByOtherLayer(ID, id)) return;
      clearSelection();
      notify();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }
  const notify = () => {
    listener?.();
    viewer?.scene?.requestRender?.();
  };
  const position = (row) =>
    Cesium.Cartesian3.fromDegrees(row.mapPosition.lon, row.mapPosition.lat);
  const stale = () =>
    Boolean(
      snapshot &&
      (error || snapshot.stale || Date.now() - snapshot.observedAt > 180000),
    );

  function render() {
    if (!dataSource || !enabled) return;
    dataSource.entities.removeAll();
    for (const row of snapshot?.rows || []) {
      if (!row.mapPosition) continue;
      const style = styleFor(row);
      const anchor = position(row);
      dataSource.entities.add({
        id: `${ID}:${row.id}`,
        position: anchor,
        billboard: {
          image: style.image,
          width: 32,
          height: 32,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    overlayHost.clearSource(ID);
    renderSelection();
    notify();
  }
  function renderSelection() {
    overlayHost.clearSource(SELECTED);
    const row = snapshot?.rows.find((row) => row.id === selected);
    if (!enabled || !row?.mapPosition) return;
    overlayHost.setEntries(
      SELECTED,
      [
        {
          id: row.id,
          position: position(row),
          variant: 'selected',
          selected: true,
          protected: true,
          paintLane: 'selected',
          collisionGroup: 'ambient-card',
          priority: Number.MAX_SAFE_INTEGER,
          title: `${styleFor(row).symbol} ${row.incidentNumber || row.id} · ${row.type}`,
          details: [
            ...wrap(t('Location: {location}', { location: row.location })),
            ...wrap(
              t('Municipality: {municipality}', {
                municipality: row.municipality,
              }),
            ),
            ...(row.mapPosition.matchedLocation
              ? [
                  t('GIS match: {location}', {
                    location: row.mapPosition.matchedLocation,
                  }),
                ]
              : []),
            t('Dispatch: {time} (America/New_York)', { time: row.dispatched }),
            row.category === 'traffic'
              ? t('Agency: {agency}', { agency: row.station })
              : t('Station: {station}', { station: row.station }),
            ...(detailsRequest && !detail ? [t('Loading unit status...')] : []),
            ...(detail
              ? [
                  t('Units: {count}', {
                    count: new Set(detail.units.map((unit) => unit.unit)).size,
                  }),
                  ...detail.units.slice(0, 8).flatMap((unit) =>
                    wrap(
                      t('{unit} · {status} · {time}', {
                        unit: unit.unit,
                        status: unit.status,
                        time: unit.entered,
                      }),
                    ),
                  ),
                  ...(detail.units.length > 8
                    ? [
                        t('{count} more unit updates · open source', {
                          count: detail.units.length - 8,
                        }),
                      ]
                    : []),
                  ...(!detail.units.length ? [t('No public unit status')] : []),
                  t('Unit status updated: {time} (America/New_York)', {
                    time: new Date(detail.observedAt).toLocaleString(
                      undefined,
                      { timeZone: 'America/New_York' },
                    ),
                  }),
                  ...(detail.stale || detailsError
                    ? [t('Unit status is stale')]
                    : []),
                ]
              : detailsError
                ? [t('Unit status unavailable')]
                : []),
            ...(detailLink(row) && openExternal
              ? [t('Open incident source ↗')]
              : []),
            ...(stale() ? [t('Stale data')] : []),
          ],
          accent: styleFor(row).color,
          interactive: Boolean(detailLink(row) && openExternal),
          ...(detailLink(row) && openExternal
            ? {
                accessibilityLabel: t('Open the source for {title}', {
                  title: row.incidentNumber || row.id,
                }),
                activate: () => {
                  openExternal(detailLink(row));
                  return true;
                },
              }
            : {}),
          stateless: true,
          horizonCull: true,
          terrainOcclusion: false,
          verticalOnly: true,
          placement: 'above',
        },
      ],
      { cohortLimit: 1, collisionCapacity: 1, moving: false },
    );
  }
  const layer = {
    id: ID,
    name: msg('Chester County, PA incidents'),
    icon: '✚',
    source: 'Chester County DES / GIS',
    updateInterval: 60000,
    init(nextViewer) {
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
    },
    enable() {
      enabled = true;
      dataSource.show = true;
      overlayHost.setVisible(ID, true);
      overlayHost.setVisible(SELECTED, true);
      installClickHandler();
      render();
    },
    disable() {
      enabled = false;
      request?.abort();
      request = null;
      clearSelection();
      clickHandler?.destroy();
      clickHandler = null;
      picking?.unregisterPickOwner(ID);
      if (dataSource) dataSource.show = false;
      for (const id of [ID, SELECTED]) {
        overlayHost.clearSource(id);
        overlayHost.setVisible(id, false);
      }
      notify();
    },
    async update() {
      if (!enabled) return false;
      request?.abort();
      const current = new AbortController();
      request = current;
      try {
        const next = await source.getSnapshot({ signal: current.signal });
        if (current.signal.aborted || request !== current || !enabled)
          return false;
        snapshot = next;
        error = null;
        if (!next.rows.some((row) => row.id === selected)) clearSelection();
        render();
        if (selected) void loadDetails();
        return true;
      } catch {
        if (current.signal.aborted || request !== current || !enabled)
          return false;
        error = msg('Chester County incidents unavailable');
        renderSelection();
        notify();
        return false;
      } finally {
        if (request === current) request = null;
      }
    },
    destroy() {
      layer.disable();
      if (dataSource) viewer.dataSources.remove(dataSource, true);
      viewer = dataSource = snapshot = listener = null;
    },
    getStats() {
      return {
        count: snapshot?.rows.length || 0,
        lastUpdate: snapshot?.fetchedAt || null,
        observedAt: snapshot?.observedAt || null,
        stale: stale(),
        error,
        degraded: (snapshot?.locationCoverage?.unavailable || 0) > 0,
        mappedCount:
          snapshot?.rows.filter((row) => row.mapPosition).length || 0,
        unresolvedCount:
          snapshot?.rows.filter(
            (row) => !row.mapPosition && row.locationStatus !== 'unavailable',
          ).length || 0,
        locationErrorCount: snapshot?.locationCoverage?.unavailable || 0,
      };
    },
    getRowControls() {
      const rows = snapshot?.rows || [];
      return {
        chips: [
          {
            id: 'county',
            label: t('View Chester County'),
            onClick: () =>
              viewer?.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(
                  -75.75,
                  40.0,
                  100000,
                ),
              }),
          },
          {
            id: 'source',
            label: t('County WebCAD'),
            onClick: () =>
              globalThis.open(
                'https://www.chesco.org/3963/WebCad-Active-Incidents',
                '_blank',
                'noopener,noreferrer',
              ),
          },
        ],
        info: [
          t(
            'Chester County, Pennsylvania only. Street locations are approximate.',
          ),

          snapshot
            ? `${t('Updated')}: ${new Date(snapshot.observedAt).toLocaleString(undefined, { timeZone: 'America/New_York' })} (America/New_York)`
            : t('Loading...'),
          snapshot
            ? t(
                '{mapped} mapped · {unresolved} unresolved · {errors} lookup errors',
                {
                  mapped: rows.filter((row) => row.mapPosition).length,
                  unresolved: rows.filter(
                    (row) =>
                      !row.mapPosition && row.locationStatus !== 'unavailable',
                  ).length,
                  errors: snapshot.locationCoverage?.unavailable || 0,
                },
              )
            : '',
          stale() ? t('Stale data') : '',
          snapshot && !rows.length ? t('No active incidents') : '',
        ]
          .filter(Boolean)
          .join(' · '),
        list: {
          ariaLabel: t('Chester County, PA incidents'),
          items: rows.map((row) => ({
            id: row.id,
            lead: `${styleFor(row).symbol} ${row.incidentNumber || row.id} · ${row.type}`,
            text: `${row.location} · ${row.municipality} · ${row.dispatched} (America/New_York) · ${row.category === 'traffic' ? t('Agency: {agency}', { agency: row.station }) : t('Station: {station}', { station: row.station })}${row.mapPosition ? '' : ` · ${row.locationStatus === 'unavailable' ? t('Location lookup failed') : t('No location match')}`}`,
            active: selected === row.id,
            params: { selectedIncident: row.id },
          })),
        },
      };
    },
    setParams(params) {
      if (!enabled || !Object.hasOwn(params, 'selectedIncident')) return;
      select(params.selectedIncident, true);
    },
    setRowControlsListener(next) {
      listener = next;
    },
  };
  return layer;
}
