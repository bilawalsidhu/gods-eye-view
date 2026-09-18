import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
export { createCellularNetworksSource } from './source.js';

export const CELLULAR_LAYER_ID = 'cellular-networks';
const MAX_VIEWPORT_DEGREES = 2;
const REQUEST_DEBOUNCE_MS = 450;
const MAX_RENDERED_SITES = 500;
const MAX_RENDERED_CELLS = 350;
const MAX_RENDERED_RANGES = 8;
const PROVIDER_HINT_GRID_DEGREES = 0.01;
const CLUSTER_THRESHOLD = 260;

const TECHNOLOGY_LABELS = Object.freeze({
  ALL: 'ALL',
  GSM: '2G',
  UMTS: '3G',
  LTE: 'LTE',
  NR: '5G',
  NBIOT: 'NB-IoT',
  CDMA: 'CDMA',
  UNKNOWN: '?',
});

const TECHNOLOGY_COLORS = Object.freeze({
  GSM: '#69c779',
  UMTS: '#4da6ff',
  LTE: '#a47cff',
  NR: '#ff5ec4',
  NBIOT: '#4fd1c5',
  CDMA: '#e2b84b',
  UNKNOWN: '#9ca6b0',
});

function colorForTechnology(technology) {
  return Cesium.Color.fromCssColorString(
    TECHNOLOGY_COLORS[technology] || TECHNOLOGY_COLORS.UNKNOWN,
  );
}

function approximateDistanceM(a, b) {
  const lat1 = Cesium.Math.toRadians(a.latitude);
  const lat2 = Cesium.Math.toRadians(b.latitude);
  const dLat = lat2 - lat1;
  const dLon = Cesium.Math.toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 12_742_016 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function providerGridKey(latitude, longitude) {
  return `${Math.floor(latitude / PROVIDER_HINT_GRID_DEGREES)}:${Math.floor(longitude / PROVIDER_HINT_GRID_DEGREES)}`;
}

function attachProviderHints(cells, sites) {
  const grid = new Map();
  for (const site of sites) {
    if (!site.operator) continue;
    const key = providerGridKey(site.latitude, site.longitude);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(site);
  }
  if (!grid.size) return cells;

  return cells.map((cell) => {
    const cellY = Math.floor(cell.latitude / PROVIDER_HINT_GRID_DEGREES);
    const cellX = Math.floor(cell.longitude / PROVIDER_HINT_GRID_DEGREES);
    let best = null;
    let bestDistance = Infinity;
    for (let y = cellY - 1; y <= cellY + 1; y += 1) {
      for (let x = cellX - 1; x <= cellX + 1; x += 1) {
        for (const site of grid.get(`${y}:${x}`) || []) {
          const distance = approximateDistanceM(cell, site);
          if (distance < bestDistance) {
            best = site;
            bestDistance = distance;
          }
        }
      }
    }
    if (!best || bestDistance > 500) return cell;
    return {
      ...cell,
      providerHint: best.operator,
      providerHintDistanceM: Math.round(bestDistance),
    };
  });
}

function viewportBox(viewer) {
  const rectangle = viewer?.camera?.computeViewRectangle(
    viewer.scene.globe.ellipsoid,
  );
  if (!rectangle) return null;
  const south = Cesium.Math.toDegrees(rectangle.south);
  const north = Cesium.Math.toDegrees(rectangle.north);
  const west = Cesium.Math.toDegrees(rectangle.west);
  const east = Cesium.Math.toDegrees(rectangle.east);
  if (
    !Number.isFinite(south + north + west + east) ||
    east <= west ||
    north <= south ||
    north - south > MAX_VIEWPORT_DEGREES ||
    east - west > MAX_VIEWPORT_DEGREES
  )
    return null;
  return { south, west, north, east };
}

function visibleByTechnology(record, technology) {
  if (technology === 'ALL') return true;
  if (record.kind === 'cell') return record.radio === technology;
  if (!record.technologies?.length) return false;
  return record.technologies.includes(technology);
}

function clusterSites(sites, box) {
  if (sites.length < CLUSTER_THRESHOLD)
    return sites.slice(0, MAX_RENDERED_SITES);
  const span = Math.max(box.north - box.south, box.east - box.west);
  const step = Math.max(span / 36, 0.0025);
  const buckets = new Map();
  for (const site of sites) {
    const x = Math.floor((site.longitude - box.west) / step);
    const y = Math.floor((site.latitude - box.south) / step);
    const key = `${x}:${y}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(site);
  }
  const rendered = [];
  for (const [key, members] of buckets) {
    if (rendered.length >= MAX_RENDERED_SITES) break;
    if (members.length <= 2) {
      rendered.push(...members.slice(0, MAX_RENDERED_SITES - rendered.length));
      continue;
    }
    const latitude =
      members.reduce((sum, item) => sum + item.latitude, 0) / members.length;
    const longitude =
      members.reduce((sum, item) => sum + item.longitude, 0) / members.length;
    const operators = [
      ...new Set(members.map((item) => item.operator).filter(Boolean)),
    ];
    rendered.push({
      id: `cellular:cluster:${key}`,
      kind: 'cluster',
      latitude,
      longitude,
      count: members.length,
      operators: operators.slice(0, 6),
      name: `${members.length} mapped cellular sites`,
      source: 'OpenStreetMap',
    });
  }
  return rendered.slice(0, MAX_RENDERED_SITES);
}

function collapseCoLocatedCells(cells, selectedId = null) {
  const buckets = new Map();
  for (const cell of cells) {
    const key = `${cell.latitude.toFixed(5)}:${cell.longitude.toFixed(5)}:${cell.radio || 'UNKNOWN'}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(cell);
  }

  const collapsed = [];
  for (const members of buckets.values()) {
    const representative =
      members.find((member) => member.id === selectedId) ||
      members.reduce((best, member) => {
        if (!best) return member;
        return (member.samples || 0) > (best.samples || 0) ? member : best;
      }, null);
    collapsed.push({
      ...representative,
      coLocatedCount: members.length,
      coLocatedCellIds: members.slice(0, 12).map((member) => member.cellId),
    });
  }
  return collapsed;
}

function evenlyLimit(records, limit, selectedId = null) {
  if (records.length <= limit) return records;
  const selected = selectedId
    ? records.find((record) => record.id === selectedId)
    : null;
  const result = [];
  const step = records.length / limit;
  for (let i = 0; i < limit; i += 1) {
    result.push(records[Math.floor(i * step)]);
  }
  if (selected && !result.some((record) => record.id === selected.id)) {
    result[result.length - 1] = selected;
  }
  return result;
}

function selectRangeRecords(cells, selectedId = null) {
  const selected = selectedId
    ? cells.find(
        (cell) =>
          cell.id === selectedId &&
          Number.isFinite(cell.rangeM) &&
          cell.rangeM > 0,
      )
    : null;
  if (selected) return [selected];

  const bestByCoordinate = new Map();
  for (const cell of cells) {
    if (!Number.isFinite(cell.rangeM) || cell.rangeM <= 0) continue;
    const key = `${cell.latitude.toFixed(5)}:${cell.longitude.toFixed(5)}`;
    const current = bestByCoordinate.get(key);
    if (!current || (cell.samples || 0) > (current.samples || 0)) {
      bestByCoordinate.set(key, cell);
    }
  }
  return [...bestByCoordinate.values()]
    .sort((a, b) => (b.samples || 0) - (a.samples || 0))
    .slice(0, MAX_RENDERED_RANGES);
}

function statusMessage(state) {
  if (state.status === 'zoom-in')
    return 'Zoom in to city scale to load mapped cellular sites';
  if (state.status === 'unavailable')
    return state.error || 'Cellular network context unavailable';
  if (state.cellStatus === 'key-required')
    return 'Mapped sites are available; add OPENCELLID_API_KEY for logical Cell IDs';
  if (state.cellStatus === 'zoom-in')
    return `Mapped sites loaded; current view needs ${state.cellTileCount || 'too many'} OpenCellID tiles (limit ${state.cellTileLimit || 36})`;
  if (state.cellStatus === 'invalid-key')
    return 'OpenCellID rejected the configured API key';
  if (state.cellStatus === 'rate-limited')
    return 'OpenCellID daily/rate limit reached';
  if (state.cellStatus === 'partial') {
    if (state.cellViewportPartial)
      return `Showing cells near the view center (${state.cellTilesQueried || 0} of ${state.cellTileCount || 0} tiles); zoom in for complete cell coverage`;
    return `OpenCellID returned partial data; ${state.cellFailedTiles || 0} tile${state.cellFailedTiles === 1 ? '' : 's'} failed`;
  }
  if (state.siteSaturated || state.cellSaturated)
    return `Current view is dense; ${state.cellSaturatedTiles || 0} OpenCellID tile${state.cellSaturatedTiles === 1 ? '' : 's'} hit the 50-cell cap`;
  return '';
}

/** Cellular infrastructure layer: physical OSM sites plus optional OpenCellID logical cells. */
export function createCellularNetworksLayer({ services, source } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Cellular Networks require a viewport source');
  if (!services?.context || !services?.picking || !services?.render)
    throw new TypeError('Cellular Networks require application services');

  const state = {
    viewer: null,
    dataSource: null,
    enabled: false,
    sites: [],
    cells: [],
    recordById: new Map(),
    selectedId: null,
    technology: 'ALL',
    showSites: true,
    showCells: true,
    showCoverage: false,
    showSectors: true,
    loading: false,
    status: 'idle',
    error: null,
    lastUpdate: null,
    sitesStatus: 'idle',
    cellStatus: 'unknown',
    siteSaturated: false,
    cellSaturated: false,
    cellAreaKm2: null,
    cellTileCount: 0,
    cellTilesQueried: 0,
    cellCachedTiles: 0,
    cellFailedTiles: 0,
    cellSaturatedTiles: 0,
    cellTileLimit: 0,
    cellViewportPartial: false,
    renderedCells: [],
    renderedCellCount: 0,
    renderedRangeCount: 0,
    rangeEntityIds: new Set(),
    abort: null,
    timer: null,
    moveEndRemove: null,
    clickHandler: null,
    rowListener: null,
    currentBox: null,
  };

  function notifyRow() {
    try {
      state.rowListener?.();
    } catch (error) {
      console.warn('[Data:Cellular] row-controls listener failed:', error);
    }
  }

  function requestRender(reason) {
    services.render.governorRequestRender(reason);
    state.viewer?.scene?.requestRender();
  }

  function rangeRingHeightM(record) {
    const cartographic = Cesium.Cartographic.fromDegrees(
      record.longitude,
      record.latitude,
    );
    const terrainHeight = state.viewer?.scene?.globe?.getHeight?.(cartographic);
    return Number.isFinite(terrainHeight) ? terrainHeight + 10 : 120;
  }

  function rangeRingPositions(record, segments = 56) {
    const radiusM = Math.min(record.rangeM, 50_000);
    const angular = radiusM / 6_371_008;
    const lat1 = Cesium.Math.toRadians(record.latitude);
    const lon1 = Cesium.Math.toRadians(record.longitude);
    const fallbackHeightM = rangeRingHeightM(record);
    const globe = state.viewer?.scene?.globe;
    const positions = [];
    for (let index = 0; index <= segments; index += 1) {
      const bearing = (index / segments) * Cesium.Math.TWO_PI;
      const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(angular) +
          Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
      );
      const lon2 =
        lon1 +
        Math.atan2(
          Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
          Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
        );
      const cartographic = new Cesium.Cartographic(lon2, lat2);
      const localTerrain = globe?.getHeight?.(cartographic);
      const heightM = Number.isFinite(localTerrain)
        ? localTerrain + 12
        : fallbackHeightM;
      positions.push(Cesium.Cartesian3.fromRadians(lon2, lat2, heightM));
    }
    return positions;
  }

  function requestRangeRenderPulse() {
    requestRender('cellular-networks-render-range');
    globalThis.requestAnimationFrame?.(() =>
      requestRender('cellular-networks-render-range-frame'),
    );
    globalThis.setTimeout?.(
      () => requestRender('cellular-networks-render-range-settle'),
      80,
    );
  }

  function clearRendered() {
    state.dataSource?.entities?.removeAll();
    services.context.removeEntityContextsForLayer(CELLULAR_LAYER_ID);
    state.recordById.clear();
    state.rangeEntityIds.clear();
    state.renderedCells = [];
    state.renderedCellCount = 0;
    state.renderedRangeCount = 0;
  }

  function clearRanges() {
    if (!state.dataSource) return;
    for (const id of state.rangeEntityIds)
      state.dataSource.entities.removeById(id);
    state.rangeEntityIds.clear();
    state.renderedRangeCount = 0;
  }

  function renderRanges() {
    clearRanges();
    if (!state.enabled || !state.dataSource || !state.showCoverage) {
      requestRender('cellular-networks-range-off');
      notifyRow();
      return;
    }

    const records = selectRangeRecords(state.renderedCells, state.selectedId);
    for (const record of records) {
      const color = colorForTechnology(record.radio);
      const selectedRange = record.id === state.selectedId;
      const id = `${record.id}:range`;
      state.dataSource.entities.add({
        id,
        polyline: {
          positions: rangeRingPositions(record, selectedRange ? 72 : 48),
          width: selectedRange ? 3 : 1.25,
          material: selectedRange
            ? color.withAlpha(0.95)
            : new Cesium.PolylineDashMaterialProperty({
                color: color.withAlpha(0.4),
                dashLength: 14,
              }),
          depthFailMaterial: color.withAlpha(selectedRange ? 0.8 : 0.28),
          clampToGround: false,
        },
      });
      state.rangeEntityIds.add(id);
    }
    state.renderedRangeCount = records.length;
    requestRangeRenderPulse();
    notifyRow();
  }

  function rangeLabel(rangeM) {
    if (!Number.isFinite(rangeM) || rangeM <= 0) return null;
    return rangeM >= 1000
      ? `EST RANGE ~${(rangeM / 1000).toFixed(rangeM >= 10_000 ? 0 : 1)} KM`
      : `EST RANGE ~${Math.round(rangeM)} M`;
  }

  function selectedLabelModel(record) {
    if (record.kind === 'cluster') {
      return {
        title: `${record.count} CELLULAR SITES`,
        details: [
          record.operators?.length
            ? record.operators.join(' · ')
            : 'MAPPED PHYSICAL SITES',
          'ZOOM IN FOR INDIVIDUAL SITES',
        ],
        accent: '#00ffff',
      };
    }
    if (record.kind === 'site') {
      const title = String(
        record.name || record.operator || 'CELLULAR SITE',
      ).toUpperCase();
      const details = [];
      if (record.operator && title !== String(record.operator).toUpperCase()) {
        details.push(String(record.operator).toUpperCase());
      }
      if (record.technologies?.length) {
        details.push(
          record.technologies
            .map((item) => TECHNOLOGY_LABELS[item] || item)
            .join(' · '),
        );
      }
      const structure = [
        record.structure
          ? String(record.structure).replaceAll('_', ' ').toUpperCase()
          : null,
        Number.isFinite(record.heightM) ? `${record.heightM} M` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      if (structure) details.push(structure);
      if (record.frequency)
        details.push(String(record.frequency).toUpperCase());
      else if (record.sectorAzimuths?.length) {
        details.push(
          `${record.sectorAzimuths.length} MAPPED SECTOR DIRECTION${record.sectorAzimuths.length === 1 ? '' : 'S'}`,
        );
      } else if (record.ref) {
        details.push(`REF ${record.ref}`);
      }
      return {
        title,
        details: details.slice(0, 4),
        accent: '#00ffff',
      };
    }
    const details = [
      record.providerHint
        ? `${String(record.providerHint).toUpperCase()} · PLMN ${record.plmn}`
        : `PLMN ${record.plmn}`,
      `CELL ${record.cellId}${record.tac ? ` · TAC ${record.tac}` : record.lac ? ` · LAC ${record.lac}` : ''}`,
      [
        rangeLabel(record.rangeM),
        Number.isFinite(record.samples)
          ? `${record.samples} SAMPLE${record.samples === 1 ? '' : 'S'}`
          : null,
      ]
        .filter(Boolean)
        .join(' · '),
      record.coLocatedCount > 1
        ? `${record.coLocatedCount} COLOCATED ${TECHNOLOGY_LABELS[record.radio] || record.radio} CELLS`
        : null,
    ].filter(Boolean);
    return {
      title: `${TECHNOLOGY_LABELS[record.radio] || record.radio} CELL ${record.cellId}`,
      details: details.slice(0, 4),
      accent: TECHNOLOGY_COLORS[record.radio] || TECHNOLOGY_COLORS.UNKNOWN,
    };
  }

  function selectedPopupLabel(record) {
    const model = selectedLabelModel(record);
    const lines = [model.title, ...(model.details || [])].filter(Boolean);
    if (!lines.length) return undefined;
    return {
      text: lines.join('\n'),
      font: '12px monospace',
      fillColor: Cesium.Color.fromCssColorString(model.accent || '#00ffff'),
      outlineColor: Cesium.Color.BLACK.withAlpha(0.95),
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      showBackground: true,
      backgroundColor: Cesium.Color.BLACK.withAlpha(0.84),
      backgroundPadding: new Cesium.Cartesian2(10, 8),
      pixelOffset: new Cesium.Cartesian2(22, -28),
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scale: 0.95,
    };
  }

  function publishEntityPresentation(entity, record, displayPosition) {
    const model = selectedLabelModel(record);
    entity.gevTrackedId = `cellular:${record.id}`;
    entity.gevDisplayPosition = () => displayPosition;
    entity.gevLabelModel = {
      ...model,
      cardStyle: 'tactical',
      selected: true,
      leaderStyle: 'elbow',
      leaderAnimationMs: 360,
      leaderAnimationStartedAt:
        state.selectedId === record.id
          ? globalThis.performance?.now?.() || Date.now()
          : 0,
      leaderDrawRatio: 0.7,
      anchorRadiusPx: record.kind === 'cluster' ? 10 : 8,
      anchorRadiusScale: null,
    };
  }

  function registerContext(entity, record) {
    if (record.kind === 'cluster') {
      services.context.registerEntityContext(entity, {
        id: record.id,
        layerId: CELLULAR_LAYER_ID,
        dataSource: state.dataSource,
        layerName: 'Cellular Networks',
        source: 'OpenStreetMap',
        label: record.name,
        latitude: record.latitude,
        longitude: record.longitude,
        properties: {
          recordType: 'site_cluster',
          siteCount: record.count,
          operators: record.operators,
          note: 'Cluster of mapped physical cellular sites; zoom in for individual sites',
        },
      });
      return;
    }
    if (record.kind === 'site') {
      services.context.registerEntityContext(entity, {
        id: record.id,
        layerId: CELLULAR_LAYER_ID,
        dataSource: state.dataSource,
        layerName: 'Cellular Networks',
        source: 'OpenStreetMap · ODbL 1.0',
        label: record.name,
        latitude: record.latitude,
        longitude: record.longitude,
        properties: {
          recordType: 'physical_site',
          operator: record.operator,
          technologies: record.technologies,
          structure: record.structure,
          heightM: record.heightM,
          frequency: record.frequency,
          ref: record.ref,
          mcc: record.mcc,
          mnc: record.mnc,
          sectorAzimuths: record.sectorAzimuths,
          sectorNote: record.sectorAzimuths?.length
            ? 'Directions are mapped OSM antenna/technology direction tags, not inferred RF coverage'
            : null,
          sourceId: record.sourceId,
        },
      });
      return;
    }
    services.context.registerEntityContext(entity, {
      id: record.id,
      layerId: CELLULAR_LAYER_ID,
      dataSource: state.dataSource,
      layerName: 'Cellular Networks',
      source: 'OpenCellID · CC BY-SA 4.0',
      label: `${TECHNOLOGY_LABELS[record.radio] || record.radio} cell ${record.cellId}`,
      latitude: record.latitude,
      longitude: record.longitude,
      properties: {
        recordType: 'logical_cell',
        technology: record.radio,
        plmn: record.plmn,
        mcc: record.mcc,
        mnc: record.mnc,
        lac: record.lac,
        tac: record.tac,
        cellId: record.cellId,
        pci: record.pci,
        psc: record.psc,
        estimatedRangeM: record.rangeM,
        samples: record.samples,
        averageSignalStrength: record.averageSignalStrength,
        coLocatedCount: record.coLocatedCount || 1,
        coLocatedCellIds: record.coLocatedCellIds || [record.cellId],
        providerHint: record.providerHint || null,
        providerHintNote: record.providerHint
          ? `Nearest mapped OSM operator within ${record.providerHintDistanceM} m; not an authoritative PLMN lookup`
          : null,
        precisionNote:
          'OpenCellID coordinates and range are community-derived estimates; a logical cell is not necessarily a physical tower',
      },
    });
  }

  function render() {
    if (!state.enabled || !state.dataSource) return;
    const selected = state.selectedId;
    let selectedEntity = null;
    clearRendered();
    const box = state.currentBox;
    const siteCandidates = state.sites.filter((record) =>
      visibleByTechnology(record, state.technology),
    );
    const renderedSites =
      state.showSites && box ? clusterSites(siteCandidates, box) : [];
    const filteredCells = state.showCells
      ? state.cells.filter((record) =>
          visibleByTechnology(record, state.technology),
        )
      : [];
    const collapsedCells = collapseCoLocatedCells(filteredCells, selected);
    const renderedCells = evenlyLimit(
      collapsedCells,
      MAX_RENDERED_CELLS,
      selected,
    );
    state.renderedCells = renderedCells;
    state.renderedCellCount = renderedCells.length;

    for (const record of renderedSites) {
      const selectedRecord = selected === record.id;
      const isCluster = record.kind === 'cluster';
      const displayPosition = Cesium.Cartesian3.fromDegrees(
        record.longitude,
        record.latitude,
        20,
      );
      const entity = state.dataSource.entities.add({
        id: record.id,
        position: displayPosition,
        point: {
          pixelSize: selectedRecord
            ? 13
            : isCluster
              ? Math.min(18, 9 + Math.log2(record.count || 1))
              : 8,
          color: selectedRecord
            ? Cesium.Color.WHITE
            : isCluster
              ? Cesium.Color.CYAN.withAlpha(0.9)
              : Cesium.Color.CYAN.withAlpha(0.78),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
          outlineWidth: selectedRecord ? 2 : 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: selectedRecord ? selectedPopupLabel(record) : undefined,
      });
      state.recordById.set(record.id, record);
      publishEntityPresentation(entity, record, displayPosition);
      registerContext(entity, record);
      if (selectedRecord) selectedEntity = entity;
      if (
        state.showSectors &&
        record.kind === 'site' &&
        record.sectorAzimuths?.length
      ) {
        for (const azimuth of record.sectorAzimuths.slice(0, 12)) {
          const bearing = Cesium.Math.toRadians(azimuth);
          const angular = 450 / 6_371_008;
          const lat1 = Cesium.Math.toRadians(record.latitude);
          const lon1 = Cesium.Math.toRadians(record.longitude);
          const lat2 = Math.asin(
            Math.sin(lat1) * Math.cos(angular) +
              Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
          );
          const lon2 =
            lon1 +
            Math.atan2(
              Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
              Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
            );
          state.dataSource.entities.add({
            id: `${record.id}:sector:${azimuth}`,
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArray([
                record.longitude,
                record.latitude,
                Cesium.Math.toDegrees(lon2),
                Cesium.Math.toDegrees(lat2),
              ]),
              width: 2,
              material: Cesium.Color.CYAN.withAlpha(0.45),
              clampToGround: true,
            },
          });
        }
      }
    }

    for (const record of renderedCells) {
      const selectedRecord = selected === record.id;
      const color = colorForTechnology(record.radio);
      const displayPosition = Cesium.Cartesian3.fromDegrees(
        record.longitude,
        record.latitude,
        20,
      );
      const entity = state.dataSource.entities.add({
        id: record.id,
        position: displayPosition,
        point: {
          pixelSize: selectedRecord ? 12 : 6,
          color: selectedRecord ? Cesium.Color.WHITE : color.withAlpha(0.9),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
          outlineWidth: selectedRecord ? 2 : 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: selectedRecord ? selectedPopupLabel(record) : undefined,
      });
      state.recordById.set(record.id, record);
      publishEntityPresentation(entity, record, displayPosition);
      registerContext(entity, record);
      if (selectedRecord) selectedEntity = entity;
    }
    if (selectedEntity) services.context.selectEntityContext(selectedEntity);
    if (selected && !state.recordById.has(selected)) state.selectedId = null;
    requestRender('cellular-networks-render');
    renderRanges();
    notifyRow();
  }

  function updateAggregateStatus() {
    if (
      state.sitesStatus === 'unavailable' &&
      state.cellStatus === 'unavailable'
    ) {
      state.status = 'unavailable';
      state.error = 'Cellular data providers are temporarily unavailable';
      return;
    }
    state.error = null;
    if (state.sites.length || state.cells.length) {
      state.status = 'ready';
      return;
    }
    if (state.loading) {
      state.status = 'loading';
      return;
    }
    state.status = 'empty';
  }

  async function load() {
    if (!state.enabled || !state.viewer) return false;
    const box = viewportBox(state.viewer);
    state.currentBox = box;
    if (!box) {
      state.abort?.abort();
      state.abort = null;
      state.loading = false;
      state.status = 'zoom-in';
      state.error = null;
      state.sites = [];
      state.cells = [];
      state.sitesStatus = 'zoom-in';
      state.cellStatus = 'zoom-in';
      clearRendered();
      requestRender('cellular-networks-zoom-guidance');
      notifyRow();
      return true;
    }

    state.abort?.abort();
    const request = new AbortController();
    state.abort = request;
    state.loading = true;
    state.status = 'loading';
    state.error = null;
    state.sitesStatus = 'loading';
    state.cellStatus = 'loading';
    notifyRow();

    const stillCurrent = () =>
      !request.signal.aborted && state.abort === request && state.enabled;
    let cellsApplied = false;
    let anySuccess = false;

    const loadSites = async () => {
      try {
        const snapshot =
          typeof source.getSites === 'function'
            ? await source.getSites(box, { signal: request.signal })
            : await source.getSnapshot(box, {
                radio: state.technology,
                signal: request.signal,
              });
        if (!stillCurrent()) return;
        anySuccess = true;
        state.sites = snapshot.sites;
        state.sitesStatus = snapshot.sitesStatus;
        state.siteSaturated = snapshot.siteSaturated;
        if (cellsApplied)
          state.cells = attachProviderHints(state.cells, state.sites);
        state.lastUpdate = Date.now();
        updateAggregateStatus();
        render();
      } catch (error) {
        if (!stillCurrent() || error?.name === 'AbortError') return;
        state.sitesStatus = 'unavailable';
        updateAggregateStatus();
        notifyRow();
      }
    };

    const loadCells = async () => {
      try {
        const snapshot =
          typeof source.getCells === 'function'
            ? await source.getCells(box, {
                radio: state.technology,
                signal: request.signal,
              })
            : await source.getSnapshot(box, {
                radio: state.technology,
                signal: request.signal,
              });
        if (!stillCurrent()) return;
        anySuccess = true;
        state.cells = attachProviderHints(snapshot.cells, state.sites);
        cellsApplied = true;
        state.cellStatus = snapshot.cellStatus;
        state.cellSaturated = snapshot.cellSaturated;
        state.cellAreaKm2 = snapshot.cellAreaKm2;
        state.cellTileCount = snapshot.cellTileCount;
        state.cellTilesQueried = snapshot.cellTilesQueried;
        state.cellCachedTiles = snapshot.cellCachedTiles;
        state.cellFailedTiles = snapshot.cellFailedTiles;
        state.cellSaturatedTiles = snapshot.cellSaturatedTiles;
        state.cellTileLimit = snapshot.cellTileLimit;
        state.cellViewportPartial = Boolean(snapshot.cellViewportPartial);
        state.lastUpdate = Date.now();
        updateAggregateStatus();
        render();
      } catch (error) {
        if (!stillCurrent() || error?.name === 'AbortError') return;
        state.cellStatus = 'unavailable';
        updateAggregateStatus();
        notifyRow();
      }
    };

    await Promise.allSettled([loadSites(), loadCells()]);
    if (!stillCurrent()) return false;
    state.abort = null;
    state.loading = false;
    updateAggregateStatus();
    if (!anySuccess && state.status === 'unavailable') {
      requestRender('cellular-networks-error');
    }
    notifyRow();
    return anySuccess;
  }

  function scheduleLoad() {
    if (!state.enabled) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(load, REQUEST_DEBOUNCE_MS);
  }

  function setTechnology(technology) {
    const normalized = String(technology || '').toUpperCase();
    if (!['ALL', 'GSM', 'UMTS', 'LTE', 'NR'].includes(normalized)) return;
    if (state.technology === normalized) return;
    state.technology = normalized;
    render();
    void load();
  }

  function installClickHandler(viewer) {
    if (state.clickHandler) return;
    state.clickHandler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );
    state.clickHandler.setInputAction((click) => {
      if (!state.enabled || !isPointerFree()) return;
      const picked = viewer.scene.pick(click.position);
      const pickedId = services.picking.resolvePickId(picked);
      if (!pickedId || !state.recordById.has(pickedId)) {
        if (state.selectedId) {
          state.selectedId = null;
          services.context.clearSelectedEntityContextForLayer(
            CELLULAR_LAYER_ID,
          );
          render();
        }
        return;
      }
      const previous = state.selectedId;
      state.selectedId = pickedId;
      const entity = state.dataSource.entities.getById(pickedId);
      if (previous !== pickedId) render();
      else if (entity) services.context.selectEntityContext(entity);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function technologyCounts() {
    const counts = { GSM: 0, UMTS: 0, LTE: 0, NR: 0 };
    for (const cell of state.cells) {
      if (Object.hasOwn(counts, cell.radio)) counts[cell.radio] += 1;
    }
    return counts;
  }

  const layer = {
    id: CELLULAR_LAYER_ID,
    name: 'Cellular Networks',
    icon: '▥',
    source: 'OpenStreetMap + OpenCellID',
    requiresKeyId: 'opencellid',
    updateInterval: 0,
    statsRefreshInterval: 1000,

    init(viewer) {
      if (state.viewer)
        throw new Error('Cellular Networks layer is already initialized');
      state.viewer = viewer;
      state.dataSource = new Cesium.CustomDataSource(CELLULAR_LAYER_ID);
      state.dataSource.show = false;
      viewer.dataSources.add(state.dataSource);
      state.moveEndRemove =
        viewer.camera.moveEnd.addEventListener(scheduleLoad);
      installClickHandler(viewer);
    },

    enable() {
      state.enabled = true;
      if (state.dataSource) state.dataSource.show = true;

      services.picking.registerPickOwner(CELLULAR_LAYER_ID, (id) =>
        String(id || '').startsWith('cellular:'),
      );

      void load();
    },

    disable() {
      state.enabled = false;
      clearTimeout(state.timer);
      state.abort?.abort();
      state.abort = null;
      state.loading = false;
      services.picking.unregisterPickOwner(CELLULAR_LAYER_ID);
      if (state.dataSource) state.dataSource.show = false;
      services.context.clearSelectedEntityContextForLayer(CELLULAR_LAYER_ID);
      state.selectedId = null;
      notifyRow();
    },

    update() {
      return load();
    },

    destroy(viewer = state.viewer) {
      this.disable();
      state.moveEndRemove?.();
      state.moveEndRemove = null;
      state.clickHandler?.destroy();
      state.clickHandler = null;
      clearRendered();
      if (state.dataSource && viewer)
        viewer.dataSources.remove(state.dataSource, true);
      state.dataSource = null;
      state.viewer = null;
      state.sites = [];
      state.cells = [];
    },

    setRowControlsListener(listener) {
      state.rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      const counts = technologyCounts();
      const chip = (id, label, active, onClick, options = {}) => ({
        id,
        label,
        active,
        onClick,
        disabled: Boolean(options.disabled),
        title: options.title || '',
      });
      return {
        chips: [
          chip(
            'sites',
            'SITES',
            state.showSites,
            () => {
              state.showSites = !state.showSites;
              render();
            },
            { title: 'Mapped physical mobile-phone sites from OpenStreetMap' },
          ),
          chip(
            'cells',
            'CELLS',
            state.showCells,
            () => {
              state.showCells = !state.showCells;
              render();
            },
            {
              title:
                'Logical cells from OpenCellID when configured and zoomed in',
            },
          ),
          chip(
            'sectors',
            'SECTORS',
            state.showSectors,
            () => {
              state.showSectors = !state.showSectors;
              render();
            },
            {
              disabled: !state.sites.some(
                (site) => site.sectorAzimuths?.length,
              ),
              title:
                'Show mapped OSM antenna/sector direction rays where direction tags exist',
            },
          ),
          chip(
            'coverage',
            'RANGE',
            state.showCoverage,
            () => {
              state.showCoverage = !state.showCoverage;
              renderRanges();
            },
            {
              disabled: !state.cells.length,
              title:
                'Show estimated OpenCellID range rings; selecting a cell isolates its range. These are not RF coverage guarantees',
            },
          ),
          ...['ALL', 'GSM', 'UMTS', 'LTE', 'NR'].map((technology) =>
            chip(
              `tech-${technology.toLowerCase()}`,
              TECHNOLOGY_LABELS[technology],
              state.technology === technology,
              () => setTechnology(technology),
              {
                title:
                  technology === 'ALL'
                    ? 'All technologies'
                    : `Filter to ${TECHNOLOGY_LABELS[technology]}`,
              },
            ),
          ),
        ],
        legend: ['GSM', 'UMTS', 'LTE', 'NR'].map((technology) => ({
          klass: technology,
          label: TECHNOLOGY_LABELS[technology],
          color: TECHNOLOGY_COLORS[technology],
          count: counts[technology],
          blurb:
            'OpenCellID logical-cell count in the current accepted snapshot',
        })),
      };
    },

    getStats() {
      const visibleSites = state.sites.filter((record) =>
        visibleByTechnology(record, state.technology),
      ).length;
      const visibleCells = state.cells.filter((record) =>
        visibleByTechnology(record, state.technology),
      ).length;
      const guidance = statusMessage(state);
      const siteCountLabel =
        state.sitesStatus === 'loading'
          ? 'loading sites'
          : `${visibleSites} sites`;
      const cellCountLabel =
        state.cellStatus === 'loading'
          ? 'loading cells'
          : state.cellStatus === 'zoom-in'
            ? 'zoom in for cells'
            : state.cellStatus === 'key-required'
              ? 'key required for cells'
              : state.cellStatus === 'rate-limited'
                ? 'cell API limit reached'
                : state.cellStatus === 'invalid-key'
                  ? 'invalid cell API key'
                  : state.cellStatus === 'unavailable'
                    ? 'cells unavailable'
                    : `${visibleCells}${state.cellSaturated ? '+' : ''} cells`;
      return {
        count: visibleSites + visibleCells,
        countLabel: `${siteCountLabel} · ${cellCountLabel}`,
        lastUpdate: state.lastUpdate,
        loading: state.loading,
        loadingLabel: 'loading cellular infrastructure',
        error: state.error,
        status: state.status,
        statusMessage: guidance,
        keyRequired: state.cellStatus === 'key-required',
        source: ['ready', 'empty', 'partial'].includes(state.cellStatus)
          ? 'OpenStreetMap + OpenCellID'
          : 'OpenStreetMap',
        siteSaturated: state.siteSaturated,
        cellSaturated: state.cellSaturated,
        cellStatus: state.cellStatus,
        cellAreaKm2: state.cellAreaKm2,
        cellTileCount: state.cellTileCount,
        cellTilesQueried: state.cellTilesQueried,
        cellCachedTiles: state.cellCachedTiles,
        cellFailedTiles: state.cellFailedTiles,
        cellSaturatedTiles: state.cellSaturatedTiles,
        cellTileLimit: state.cellTileLimit,
        cellViewportPartial: state.cellViewportPartial,
        renderedCellCount: state.renderedCellCount,
        renderedRangeCount: state.renderedRangeCount,
        sectorSiteCount: state.sites.filter(
          (site) => site.sectorAzimuths?.length,
        ).length,
      };
    },

    getAnalystRecords(maxCount = 1000) {
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 1000;
      return [...state.sites, ...state.cells]
        .slice(0, limit)
        .map((record) => ({ ...record }));
    },
  };

  return layer;
}
