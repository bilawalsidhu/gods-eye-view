import * as Cesium from 'cesium';
import { isPointerFree } from './inputOwnership.js';

// Local public-data snapshots only. No network endpoint or credential discovery.
export const PUBLIC_INFRASTRUCTURE = Object.freeze([
  {
    id: 'public-power-plants',
    name: 'Power Plants (EIA US)',
    data: 'eia-plants',
    token: '3',
    color: '#ffd369',
    source: 'Operator-supplied EIA-860M inventory · public domain',
    scope:
      '≥1 MW operating inventory; includes storage/standby. Nameplate MW is not actual generation.',
  },
  {
    id: 'mapped-mobile-sites',
    name: 'Mapped Mobile Sites (GA)',
    data: 'osm-ga-sites',
    token: '4',
    color: '#ff92ed',
    source: 'Operator-supplied OpenStreetMap extract · ODbL',
    scope:
      'Incomplete mapped cellular sites/rooftop antennas, not verified towers or carrier inventory. Technology only when explicitly tagged.',
  },
  {
    id: 'mapped-power-plants',
    name: 'Mapped Power Plants (GA)',
    data: 'osm-ga-mapped-plants',
    token: '5',
    color: '#ffab5a',
    source: 'Operator-supplied OpenStreetMap extract · ODbL',
    scope:
      'Mapped power=plant features. Separate source may overlap EIA; no inferred generators or live output.',
  },
  {
    id: 'mapped-substations',
    name: 'Mapped Substations (GA)',
    data: 'osm-ga-substations',
    token: '6',
    color: '#a4ee7d',
    source: 'Operator-supplied OpenStreetMap extract · ODbL',
    scope:
      'Mapped power=substation, separate from generating plants. Incomplete; representative positions for mapped ways.',
  },
  {
    id: 'mapped-telecom-lines',
    name: 'Mapped Telecom Lines (GA)',
    data: 'osm-ga-telecom',
    token: '7',
    color: '#95b8ff',
    source: 'Operator-supplied OpenStreetMap extract · ODbL',
    scope:
      'Sparse mapped terrestrial routes. Fibre only when explicitly tagged; no junctions inferred from crossings, service areas or outage/power dependencies. Published carrier maps are reference documents, not imported route geometry. Existing submarine cables remain separate.',
  },
]);

export function longitudeInside(lon, west, east) {
  return west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
}
export function visibleInfrastructure(records, bounds, filter = 'all') {
  return records.filter(
    (r) =>
      r.lat >= bounds.south &&
      r.lat <= bounds.north &&
      longitudeInside(r.lon, bounds.west, bounds.east) &&
      (filter === 'all' || (r.technologies || []).includes(filter)),
  );
}
/** Geographic grid clusters preserve full counts; they never claim an exact site. */
export function clusterInfrastructure(records, bounds, limit) {
  const span =
    bounds.west <= bounds.east
      ? bounds.east - bounds.west
      : 360 - bounds.west + bounds.east;
  const columns = Math.max(1, Math.floor(Math.sqrt(limit * 1.5))),
    rows = Math.max(1, Math.floor(limit / columns));
  const cells = new Map();
  for (const r of records) {
    const dx = (r.lon - bounds.west + 360) % 360;
    const x = Math.min(
      columns - 1,
      Math.floor((dx / Math.max(0.00001, span)) * columns),
    );
    const y = Math.min(
      rows - 1,
      Math.floor(
        ((r.lat - bounds.south) /
          Math.max(0.00001, bounds.north - bounds.south)) *
          rows,
      ),
    );
    const key = `${x}:${y}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(r);
  }
  return [...cells.values()].slice(0, limit).map((group) =>
    group.length === 1
      ? group[0]
      : {
          id: `cluster:${group[0].id}`,
          name: `${group.reduce((n, r) => n + (r.count || 1), 0)} mapped records — zoom in`,
          lat: group[0].lat,
          lon: group[0].lon,
          count: group.reduce((n, r) => n + (r.count || 1), 0),
          cluster: true,
        },
  );
}

export function createPublicInfrastructureLayers(services) {
  return PUBLIC_INFRASTRUCTURE.map((config) =>
    createPublicInfrastructureLayer(config, services),
  );
}
export function createPublicInfrastructureLayer(
  config,
  services,
  { fetchData = fetch } = {},
) {
  let viewer,
    ds,
    handler,
    removeMove,
    timer,
    controller,
    generation = 0,
    enabled = false,
    destroyed = false,
    index,
    error = null,
    loading = false,
    rendered = 0,
    visible = 0,
    filter = 'all',
    lastUpdate = null;
  const cache = new Map();
  const credit = new Cesium.Credit(
    `<a href="${config.data.startsWith('eia') ? 'https://www.eia.gov/electricity/data/eia860m/index.php' : 'https://www.openstreetmap.org/copyright'}" target="_blank" rel="noopener">${config.source}</a>`,
    true,
  );
  const bounds = () => {
    const r = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
    return r
      ? {
          west: Cesium.Math.toDegrees(r.west),
          east: Cesium.Math.toDegrees(r.east),
          south: Cesium.Math.toDegrees(r.south),
          north: Cesium.Math.toDegrees(r.north),
        }
      : { west: -180, east: 180, south: -90, north: 90 };
  };
  const clear = () => {
    services.overlayHost?.clearSource(config.id);
    services.hideInfrastructureDetailsForLayer?.(config.id);
    ds?.entities.removeAll();
    services.clearSelectedEntityContextForLayer(config.id);
    services.removeEntityContextsForLayer(config.id);
    rendered = 0;
  };
  const stop = () => {
    generation++;
    controller?.abort();
    controller = null;
    clearTimeout(timer);
    timer = null;
    loading = false;
  };
  async function json(url, signal) {
    const response = await fetchData(url, { signal });
    if (!response.ok)
      throw new Error(`Local snapshot unavailable (HTTP ${response.status})`);
    return response.json();
  }
  async function refresh() {
    if (!enabled || destroyed) return;
    stop();
    const current = generation,
      request = new AbortController();
    controller = request;
    loading = true;
    error = null;
    try {
      const loadedIndex =
        index ||
        (await json(
          `/infrastructure/${config.data}/index.json`,
          request.signal,
        ));
      if (current !== generation || !enabled || destroyed) return;
      index = loadedIndex;
      const b = bounds(),
        selected = index.tiles.filter(
          (t) =>
            t.north >= b.south &&
            t.south <= b.north &&
            (b.west <= b.east
              ? t.east >= b.west && t.west <= b.east
              : t.east >= b.west || t.west <= b.east),
        );
      const overview =
        selected.length > 8 ||
        viewer.camera.positionCartographic.height > 2000000;
      let records;
      if (overview)
        records = selected.map((t) => ({
          id: t.tile,
          name: `${t.count} source records — zoom in`,
          lat: t.lat,
          lon: t.lon,
          count: t.count,
          cluster: true,
        }));
      else {
        records = [];
        // Sequential fetch keeps mobile peak memory bounded; max eight 2-degree tiles.
        for (const t of selected) {
          let data = cache.get(t.tile);
          if (!data)
            data = await json(
              `/infrastructure/${config.data}/${t.tile}.json`,
              request.signal,
            );
          if (current !== generation || !enabled || destroyed) return;
          cache.delete(t.tile);
          cache.set(t.tile, data);
          while (cache.size > 8) cache.delete(cache.keys().next().value);
          records.push(...data);
        }
        records = visibleInfrastructure(records, b, filter);
      }
      if (current !== generation || !enabled || destroyed) return;
      visible = records.reduce((n, r) => n + (r.count || 1), 0);
      clear();
      const limit =
        typeof matchMedia === 'function' &&
        matchMedia('(max-width: 900px), (pointer: coarse)').matches
          ? 80
          : 160;
      const clusterEntries = [];
      for (const r of clusterInfrastructure(records, b, limit)) {
        const position = Cesium.Cartesian3.fromDegrees(r.lon, r.lat);
        const entity = ds.entities.add({
          id: `${config.id}:${r.id}`,
          name: r.name,
          position,
          point: {
            pixelSize: r.cluster ? 13 : 8,
            color: Cesium.Color.fromCssColorString(config.color),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          ...(r.geometry && !r.cluster
            ? {
                polyline: {
                  positions: Cesium.Cartesian3.fromDegreesArray(
                    r.geometry.flat(),
                  ),
                  width: 3,
                  material: Cesium.Color.fromCssColorString(config.color),
                  clampToGround: true,
                },
              }
            : {}),
        });
        if (r.cluster)
          clusterEntries.push({
            id: entity.id,
            position,
            variant: 'card',
            title: String(r.count),
            details: ['Approximate cluster; zoom in'],
            accent: config.color,
            interactive: false,
            collisionGroup: 'ambient-card',
            placement: 'above',
            gapPx: 15,
            horizonCull: true,
          });
        const properties = r.cluster
          ? {
              type: 'Approximate geographic cluster',
              records: r.count,
              instruction:
                'Zoom in for individual records. Position is representative, not a verified site.',
            }
          : {
              ...r,
              owner: r.owner || 'Unknown',
              operator: r.operator || 'Unknown',
              network: r.network || 'Unknown',
              hostedCarriers:
                'Unknown; not inferred from owner/operator/network',
              technologies: (r.technologies || []).join(', ') || 'Unknown',
              medium: r.medium || 'Unknown',
              sourceCoverage: config.scope,
            };
        services.registerEntityContext(entity, {
          id: entity.id,
          layerId: config.id,
          layerName: config.name,
          source: config.source,
          dataSource: ds,
          label: r.name,
          properties,
          latitude: r.lat,
          longitude: r.lon,
        });
      }
      services.overlayHost?.setEntries(config.id, clusterEntries);
      rendered = ds.entities.values.length;
      lastUpdate = Date.now();
      services.governorRequestRender();
    } catch (e) {
      if (current === generation && e.name !== 'AbortError') {
        error = e.message;
        clear();
      }
    } finally {
      if (current === generation) {
        loading = false;
        controller = null;
      }
    }
  }
  function schedule() {
    if (!enabled) return;
    stop();
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, 300);
  }
  return {
    id: config.id,
    name: config.name,
    icon: '◇',
    source: config.source,
    defaultEnabled: false,
    updateInterval: 0,
    statsRefreshInterval: 1000,
    async init(v) {
      viewer = v;
      ds = new Cesium.CustomDataSource(config.id);
      ds.show = false;
      await viewer.dataSources.add(ds);
      removeMove = viewer.camera.moveEnd.addEventListener(schedule);
      handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((e) => {
        if (!enabled || !isPointerFree()) return;
        const picked = viewer.scene.pick(e.position)?.id;
        if (picked && ds.entities.contains(picked)) {
          const record = services.selectEntityContext(picked);
          services.showInfrastructureDetails?.(record);
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },
    enable() {
      if (destroyed) return;
      enabled = true;
      services.overlayHost?.setVisible(config.id, true);
      ds.show = true;
      viewer.creditDisplay?.addStaticCredit(credit);
      void refresh();
    },
    disable() {
      enabled = false;
      services.overlayHost?.setVisible(config.id, false);
      stop();
      clear();
      if (ds) ds.show = false;
      cache.clear();
      viewer?.creditDisplay?.removeStaticCredit(credit);
      services.governorRequestRender();
    },
    update() {},
    setParams(params) {
      if (['all', '2G', '3G', '4G', '5G'].includes(params?.technology)) {
        filter = params.technology;
        if (enabled) void refresh();
      }
    },
    getParams: () => ({ technology: filter }),
    getRowControls: () => ({
      info: `${config.source}. ${config.scope} ${error || (loading ? 'Loading local tiles…' : `${visible} visible source records; ${rendered} points/clusters. Outside coverage is unknown, not absence.`)}${config.id === 'mapped-mobile-sites' ? ` Tech filter: ${filter}. Overview counts are unfiltered until zoomed in.` : ''}`,
      infoTitle: config.scope,
      ...(config.id === 'mapped-mobile-sites'
        ? {
            chips: ['all', '2G', '3G', '4G', '5G'].map((value) => ({
              id: value,
              label: value === 'all' ? 'All tech' : value,
              value,
              active: filter === value,
              params: { technology: value },
            })),
          }
        : {}),
      ...(config.id === 'mapped-telecom-lines'
        ? {
            chips: [
              {
                id: 'atlanta-map',
                label: 'Atlanta carrier map',
                title:
                  'Southern Telecom published schematic/marketing map; separate source, not imported geometry',
                onClick: () =>
                  window.open(
                    'https://www.southern-telecom.com/network.html',
                    '_blank',
                    'noopener,noreferrer',
                  ),
              },
              {
                id: 'nw-ga-map',
                label: 'NW GA middle-mile map',
                title:
                  'Regional commission reference document; date/reuse rights unverified',
                onClick: () =>
                  window.open(
                    'https://www.nwgrc.gov/media/1-Broadband-map-C-Middle-Mile-Networks.pdf',
                    '_blank',
                    'noopener,noreferrer',
                  ),
              },
              {
                id: 'syncglobal-map',
                label: 'SyncGlobal reference',
                title:
                  'Carrier reference map; no inferred service areas or imported routes',
                onClick: () =>
                  window.open(
                    'https://www.syncglobal.net/company/fiber-map.html',
                    '_blank',
                    'noopener,noreferrer',
                  ),
              },
            ],
          }
        : {}),
    }),
    getStats: () => ({
      count: rendered,
      total: index?.total || 0,
      visible,
      lastUpdate,
      error,
      loading,
      coverage: config.scope,
      source: config.source,
    }),
    destroy() {
      if (destroyed) return;
      enabled = false;
      stop();
      clear();
      removeMove?.();
      handler?.destroy();
      viewer?.creditDisplay?.removeStaticCredit(credit);
      viewer?.dataSources?.remove(ds, true);
      cache.clear();
      index = null;
      destroyed = true;
    },
  };
}
