import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { COUNTIES, countyFor, incidentSource } from './counties.js';
import {
  createCountyFilterPreferences,
  INCIDENT_CATEGORIES,
} from './filterPreferences.js';

const ID = 'chester-county-ems';
const UNIT_STATUS_CHECKED = msg(
  'Unit status checked: {time} (America/New_York)',
);
const UNIT_STATUS_UPDATED = msg(
  'Unit status updated: {time} (America/New_York)',
);
const ASSIGNMENTS_CHECKED = msg(
  'Assignments checked: {time} (America/New_York)',
);
const SELECTED = `${ID}-selected`;
const CATEGORIES = INCIDENT_CATEGORIES;
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
const detailLink = incidentSource;
// Like the S2 cards, keep source text readable within the canvas card width.
const wrap = (value) =>
  String(value)
    .match(/.{1,60}(?:\s|$)|.{1,60}/g)
    ?.map((line) => line.trim())
    .slice(0, 2) || [];

/** Display county incidents at approximate street intersections or address points. */
export function createChesterCountyEmsLayer({
  source,
  filterPreferences = createCountyFilterPreferences(),
  overlayHost,
  openExternal,
  screenSpaceEventHandlerFactory,
  picking,
  pointer,
}) {
  let viewer, dataSource, request, rowControlsListener;
  const panelListeners = new Set();
  let enabled = false;
  let snapshot = null;
  let error = null;
  let selected = null;
  let { categories, counties } = filterPreferences.get();
  const visibleRows = () =>
    (snapshot?.rows || []).filter(
      (row) =>
        categories.includes(row.category) &&
        counties.includes(countyFor(row).id),
    );
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
    const row = visibleRows().find((row) => row.id === selected);
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
    const row = visibleRows().find((row) => row.id === id);
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
        const row = visibleRows().find((row) => row.id === selected);
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
    rowControlsListener?.();
    for (const listener of panelListeners) listener();
    viewer?.scene?.requestRender?.();
  };
  const position = (row) =>
    Cesium.Cartesian3.fromDegrees(row.mapPosition.lon, row.mapPosition.lat);
  const stale = (row) => {
    const feeds = snapshot?.countyFeeds;
    if (feeds) {
      const relevant = row
        ? feeds.filter((feed) => feed.id === countyFor(row).id)
        : feeds;
      return Boolean(
        error || relevant.some((feed) => feed.stale || feed.unavailable),
      );
    }
    return Boolean(
      snapshot &&
      (error || snapshot.stale || Date.now() - snapshot.observedAt > 180000),
    );
  };

  function render() {
    if (!dataSource || !enabled) return;
    dataSource.entities.removeAll();
    for (const row of visibleRows()) {
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
  const reportTime = (row) =>
    t(
      row.timeBasis === 'reported'
        ? msg('Reported: {time} (America/New_York)')
        : row.timeBasis === 'received'
          ? row.timezoneAssumed
            ? msg('Received: {time} (assumed America/New_York)')
            : msg('Received: {time} (America/New_York)')
          : msg('Dispatch: {time} (America/New_York)'),
      { time: row.dispatched },
    );
  const reportNote = (row) =>
    row.reportKind === 'completed'
      ? t('Completed report; not an active incident')
      : row.reportKind === 'dispatch'
        ? t('Recent dispatch; active status unknown')
        : '';
  const publicFields = (row) =>
    [
      row.crossStreets
        ? t('Cross streets: {location}', { location: row.crossStreets })
        : '',
      row.nearestIntersection
        ? t('Nearest intersection: {location}', {
            location: row.nearestIntersection,
          })
        : '',
      row.box ? t('Box: {box}', { box: row.box }) : '',
    ].filter(Boolean);
  function renderSelection() {
    overlayHost.clearSource(SELECTED);
    const row = visibleRows().find((row) => row.id === selected);
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
          title: `${styleFor(row).symbol} ${row.incidentNumber || t('Public report')} · ${row.type}`,
          details: [
            t('County: {county}', { county: countyFor(row).name }),
            ...(row.reportKind === 'dispatch'
              ? [
                  t('Recent dispatch; active status unknown'),
                  t('Community source: {source}', { source: row.sourceName }),
                ]
              : []),
            ...wrap(
              t('Location: {location}', {
                location: row.location || t('Unknown'),
              }),
            ),
            ...(row.municipality
              ? wrap(
                  t('Municipality: {municipality}', {
                    municipality: row.municipality,
                  }),
                )
              : []),
            ...(row.mapPosition.matchedLocation
              ? [
                  t('GIS match: {location}', {
                    location: row.mapPosition.matchedLocation,
                  }),
                ]
              : []),
            reportTime(row),
            ...publicFields(row),
            ...(row.reportKind === 'completed' ? [reportNote(row)] : []),
            ...(row.station
              ? [
                  row.category === 'traffic' &&
                  countyFor(row).id === 'chester-pa'
                    ? t('Agency: {agency}', { agency: row.station })
                    : t('Station: {station}', { station: row.station }),
                ]
              : []),
            ...(detailsRequest && !detail ? [t('Loading unit status...')] : []),
            ...(detail
              ? [
                  t(
                    detail.assignmentOnly
                      ? msg('Published units: {count}')
                      : msg('Units: {count}'),
                    {
                      count: new Set(detail.units.map((unit) => unit.unit))
                        .size,
                    },
                  ),
                  ...(detail.assignmentOnly
                    ? [
                        t(
                          'Assigned units only; movement status and times are not published.',
                        ),
                      ]
                    : []),
                  ...detail.units.slice(0, 8).flatMap((unit) =>
                    wrap(
                      t(
                        unit.entered
                          ? msg('{unit} · {status} · {time}')
                          : msg('{unit} · {status}'),
                        {
                          unit: unit.unit,
                          status: detail.assignmentOnly
                            ? t('Assigned')
                            : unit.status,
                          time: unit.entered,
                        },
                      ),
                    ),
                  ),
                  ...(detail.units.length > 8
                    ? [
                        t('{count} more unit updates · open source', {
                          count: detail.units.length - 8,
                        }),
                      ]
                    : []),
                  ...(!detail.units.length
                    ? [
                        t(
                          detail.assignmentOnly
                            ? msg('No assigned units published')
                            : msg('No public unit status'),
                        ),
                      ]
                    : []),
                  t(
                    detail.assignmentOnly
                      ? ASSIGNMENTS_CHECKED
                      : detail.timestampBasis === 'retrieved'
                        ? UNIT_STATUS_CHECKED
                        : UNIT_STATUS_UPDATED,
                    {
                      time: new Date(detail.observedAt).toLocaleString(
                        undefined,
                        { timeZone: 'America/New_York' },
                      ),
                    },
                  ),
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
            ...(stale(row) ? [t('Stale data')] : []),
          ],
          accent: styleFor(row).color,
          interactive: Boolean(detailLink(row) && openExternal),
          ...(detailLink(row) && openExternal
            ? {
                accessibilityLabel: t('Open the source for {title}', {
                  title: row.incidentNumber || t('Public report'),
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
    name: msg('County EMS'),
    icon: '✚',
    source: 'PA county public safety / GIS',
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
        error = msg('County incidents unavailable');
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
      panelListeners.clear();
      rowControlsListener = null;
      viewer = dataSource = snapshot = null;
    },
    getStats() {
      return {
        count: snapshot?.rows.length || 0,
        displayCount: visibleRows().length,
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
      return {
        chips: [
          ...CATEGORIES.map((category) => ({
            id: category,
            label: t(
              category === 'fire'
                ? 'Fire'
                : category === 'ems'
                  ? 'EMS'
                  : 'Traffic',
            ),
            title:
              category === 'traffic'
                ? t('Public WebCAD traffic reports')
                : undefined,
            active: categories.includes(category),
            params: {
              categories: categories.includes(category)
                ? categories.filter((value) => value !== category)
                : [...categories, category],
            },
          })),
        ],
      };
    },
    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },
    getIncidentPanelState() {
      const allRows = snapshot?.rows || [];
      const rows = visibleRows();
      const coverageNotes = [
        ...(counties.includes('lebanon-pa')
          ? [t('Lebanon: recent pager summaries; active status unknown.')]
          : []),
        ...(counties.includes('pike-pa')
          ? [t('Pike: today’s completed reports only.')]
          : []),
        ...(counties.includes('delaware-pa')
          ? [
              t(
                'Delco Dispatch: newest 20 pages within two hours; active status unknown.',
              ),
            ]
          : []),
      ];
      return {
        enabled,
        categories: [...categories],
        counties: COUNTIES.map((county) => ({
          id: county.id,
          label: county.name,
          active: counties.includes(county.id),
          hint:
            county.coverageKind === 'completed-reports'
              ? t('Completed reports only')
              : '',
        })),
        total: allRows.length,
        chips: [
          {
            id: 'county',
            label: t('View counties'),
            onClick: () =>
              viewer?.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(
                  -76.05,
                  40.55,
                  350000,
                ),
              }),
          },
        ],
        feedInfo: [
          ...(snapshot?.countyFeeds || []).map((feed) =>
            feed.unavailable
              ? t('{county}: unavailable', { county: feed.county })
              : t(
                  feed.coverageKind === 'completed-reports'
                    ? msg('{county}: {count} completed reports')
                    : feed.coverageKind === 'recent-dispatches'
                      ? msg('{county}: {count} recent dispatches')
                      : msg('{county}: {count} incidents'),
                  {
                    county: feed.county,
                    count: feed.count,
                  },
                ) +
                ' · ' +
                (feed.timestampBasis === 'retrieved'
                  ? t('Checked')
                  : t('Updated')) +
                ': ' +
                new Date(feed.observedAt).toLocaleString(undefined, {
                  timeZone: 'America/New_York',
                }) +
                ' (America/New_York)' +
                (feed.stale ? ' · ' + t('Stale data') : ''),
          ),
          ...coverageNotes,
        ],
        info: [
          t('Supported Pennsylvania counties only. Locations are approximate.'),

          !snapshot && !error ? t('Loading...') : '',
          snapshot
            ? t('{matching} of {total} incidents', {
                matching: rows.length,
                total: allRows.length,
              })
            : '',
          snapshot
            ? t(
                '{mapped} mapped · {unresolved} unresolved · {errors} lookup errors',
                {
                  mapped: allRows.filter((row) => row.mapPosition).length,
                  unresolved: allRows.filter(
                    (row) =>
                      !row.mapPosition && row.locationStatus !== 'unavailable',
                  ).length,
                  errors: snapshot.locationCoverage?.unavailable || 0,
                },
              )
            : '',

          error ? t(error) : '',
          stale() ? t('Stale data') : '',
          snapshot && !allRows.length ? t('No matching incidents') : '',
          snapshot && allRows.length && !rows.length
            ? t('No matching incidents')
            : '',
        ]
          .filter(Boolean)
          .join(' · '),
        selection: (() => {
          const row = rows.find((row) => row.id === selected);
          if (!row || row.mapPosition) return null;
          return {
            title:
              (row.incidentNumber || t('Public report')) + ' · ' + row.type,
            lines: [
              countyFor(row).name,
              reportNote(row),
              ...(row.reportKind === 'dispatch'
                ? [t('Community source: {source}', { source: row.sourceName })]
                : []),
              row.location,
              row.municipality,
              reportTime(row),
              ...publicFields(row),
              row.locationStatus === 'not-published'
                ? t('No published map location')
                : row.locationStatus === 'unavailable'
                  ? t('Location lookup failed')
                  : t('No location match'),
              ...(detailsRequest ? [t('Loading unit status...')] : []),
              ...(detail
                ? [
                    detail.assignmentOnly
                      ? t(
                          'Assigned units only; movement status and times are not published.',
                        )
                      : '',
                    ...detail.units.map((unit) =>
                      [
                        unit.unit,
                        detail.assignmentOnly ? t('Assigned') : unit.status,
                        unit.description,
                        unit.entered,
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    ),
                    !detail.units.length
                      ? t('No assigned units published')
                      : '',
                  ]
                : []),
              ...(detailsError ? [t('Unit status unavailable')] : []),
              ...(stale(row) ? [t('Stale data')] : []),
            ].filter(Boolean),
          };
        })(),
        list: {
          ariaLabel: t('County EMS'),
          items: rows.map((row) => ({
            id: row.id,
            lead: `${styleFor(row).symbol} ${row.incidentNumber || t('Public report')} · ${row.type}`,
            text: [
              reportNote(row),
              countyFor(row).name,
              row.location,
              row.municipality,
              reportTime(row),
              ...publicFields(row),
              row.station
                ? row.category === 'traffic' &&
                  countyFor(row).id === 'chester-pa'
                  ? t('Agency: {agency}', { agency: row.station })
                  : t('Station: {station}', { station: row.station })
                : '',
              row.mapPosition
                ? ''
                : row.locationStatus === 'not-published'
                  ? t('No published map location')
                  : row.locationStatus === 'unavailable'
                    ? t('Location lookup failed')
                    : t('No location match'),
            ]
              .filter(Boolean)
              .join(' · '),
            active: selected === row.id,
            params: { selectedIncident: row.id },
          })),
        },
      };
    },
    getParams() {
      return { categories: [...categories], counties: [...counties] };
    },
    setParams(params, { origin } = {}) {
      let changed = false;
      const filterChanges = {};
      for (const [key, allowed] of [
        ['categories', CATEGORIES],
        ['counties', COUNTIES.map((county) => county.id)],
      ]) {
        if (
          Object.hasOwn(params, key) &&
          Array.isArray(params[key]) &&
          params[key].every((value) => allowed.includes(value))
        ) {
          const values = allowed.filter((value) => params[key].includes(value));
          if (key === 'categories') categories = values;
          else counties = values;
          filterChanges[key] = values;
          changed = true;
        }
      }
      if (changed) {
        if (['user', 'voice', 'tool'].includes(origin))
          filterPreferences.set(filterChanges);
        if (!visibleRows().some((row) => row.id === selected)) clearSelection();
        render();
      }
      if (!enabled || !Object.hasOwn(params, 'selectedIncident')) return;
      select(params.selectedIncident, true);
    },
    /** Subscribe to incident/list selection updates without owning the layer's polling. */
    subscribeIncidentPanel(listener) {
      panelListeners.add(listener);
      return () => panelListeners.delete(listener);
    },
  };
  return layer;
}
