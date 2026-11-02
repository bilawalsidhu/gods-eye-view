import * as geo from '../../../geo/index.js';
import {
  selectInfraLod,
  applyInfraEvictionGrace,
  INFRA_LOD_ACTIVE_MAX,
} from '../../../data/localGeojsonLod.js';
import {
  createLocalInfrastructureOverlayEntry,
  selectLocalInfrastructureOverlayCohort,
  createLocalInfrastructureOverlayPublisher,
  LOCAL_OVERLAY_COHORT_LIMIT,
  labelPriorityFromProperties,
  localInfrastructureOverlayCopy,
} from '../../../data/localGeojsonCore.js';
import { createNavaraPolygonDisplay } from '../../shared/render/navaraPolygons.js';
import { bindGroundShapePicks } from '../../shared/render/navaraGroundPicks.js';
import { distanceToSegment } from '../../../globe/cpuPicks.js';
import { rgbaFromCss } from '../../shared/color.js';
import { isPointerFree } from '../../../data/inputOwnership.js';
import { createStemBatch } from '../../shared/render/navaraStems.js';

export function createInfrastructureNavaraRenderer(
  engine,
  native,
  config,
  services,
) {
  const { id, name, source, color, labelMax, labelGridPx } = config;
  const rgba = rgbaFromCss(color).rgba();
  const publisher = createLocalInfrastructureOverlayPublisher({
    sourceId: id,
    host: services.overlayHost,
  });
  const display = createNavaraPolygonDisplay(
    engine,
    native.view,
    (tint, show) => ({
      polyline: { color: tint, show, width: 2, clampToGround: true },
      polygon: {
        color: tint,
        show,
        opacity: 0.3,
        transparent: true,
        clampToGround: true,
        outline: true,
        outlineColor: tint,
        outlineWidth: 2,
      },
    }),
  );
  let dataset = null,
    records = new Map(),
    active = new Set(),
    grace = new Map(),
    shown = [],
    budget = 0;
  let lastWalk = -Infinity,
    signature = '',
    topology = '',
    points = null,
    stems = null,
    unbindShapes = null;
  let retryTimer = null;
  const removers = [];
  const wake = () => engine.render.request(id);
  const key = (fid) => id + ':' + fid;
  function footprints() {
    const features = [],
      shapes = [];
    for (const feature of dataset.features) {
      const g = feature.geometry;
      if (
        g.type !== 'LineString' &&
        (g.type !== 'Polygon' || !active.has(feature.id))
      )
        continue;
      features.push(feature);
      shapes.push({
        id: key(feature.id),
        geometry:
          g.type === 'LineString'
            ? { type: 'line', positions: g.coordinates }
            : {
                type: 'polygon',
                outer: g.coordinates[0],
                holes: g.coordinates.slice(1),
              },
        style: { lineWidth: 2 },
      });
    }
    display.replace(features.length ? new Map([[color, features]]) : new Map());
    unbindShapes?.();
    unbindShapes = bindGroundShapePicks(engine, id, shapes);
  }
  function sweep(force = false) {
    if (!dataset) return;
    const now = performance.now();
    if (!force && now - lastWalk < 450) return;
    lastWalk = now;
    const pose = engine.camera.pose(),
      size = engine.host.size();
    const sig = [
      pose.position.x,
      pose.position.y,
      pose.position.z,
      pose.heading,
      pose.pitch,
      pose.roll,
      pose.fovy,
      size.width,
      size.height,
    ].join('/');
    const sampling = shown.some(
      (r) =>
        !r.grounded &&
        r.tries < 30 &&
        now - r.lastSample >= 2000 &&
        r.distance < 75000,
    );
    if (!force && signature === sig && !sampling) return;
    if (force || signature !== sig) {
      const candidates = [];
      for (const r of records.values()) {
        r.distance = geo.cartesian3.distance(pose.position, r.base);
        candidates.push({
          id: r.id,
          priority: r.priority,
          distanceM: r.distance,
          inView: engine.projector.horizonVisible(r.base),
        });
      }
      const result = selectInfraLod(candidates, {
        cameraHeightM: pose.cartographic.height,
        incumbentIds: active,
      });
      budget = result.budget.activeLimit;
      const next = applyInfraEvictionGrace({
        selectedIds: result.activeIds,
        builtIds: [...active],
        graceState: grace,
        nowMs: now,
        activeLimit: budget,
      });
      active = new Set(next.keepIds);
      grace = next.graceState;
      signature = sig;
      const nextTopology = next.keepIds.slice().sort().join('/');
      if (force || topology !== nextTopology) {
        topology = nextTopology;
        footprints();
      }
    }
    shown = [];
    for (const fid of active) {
      const r = records.get(fid);
      if (!engine.projector.horizonVisible(r.base)) continue;
      const carto = r.carto;
      if (
        r.distance < 75000 &&
        now - r.lastSample >= 2000 &&
        (force || r.tries < 30)
      ) {
        const terrain = engine.surface.terrainHeight(carto);
        const sampled = engine.surface.supported
          ? engine.surface.sampleHeight(carto, [points])
          : undefined;
        const floor = Number.isFinite(sampled)
          ? Math.max(sampled, terrain ?? -Infinity)
          : terrain;
        r.lastSample = now;
        r.tries++;
        if (Number.isFinite(floor) && Math.abs(floor) <= 9000) {
          r.floor = floor;
          r.grounded = Number.isFinite(sampled) || !engine.surface.supported;
          geo.cartesian3.fromRadians(
            carto.longitude,
            carto.latitude,
            floor,
            undefined,
            r.base,
          );
        }
      }
      const height =
        r.floor +
        (Math.max(1, r.distance) * 2 * Math.tan(pose.fovy / 2) * 65) /
          Math.max(1, size.height);
      geo.cartesian3.fromRadians(
        carto.longitude,
        carto.latitude,
        height,
        undefined,
        r.tip,
      );
      points.set(shown.length, {
        position: r.tip,
        color: rgba,
        show: true,
        pickId: key(fid),
      });
      shown.push(r);
    }
    points.setCount(shown.length);
    points.commit();
    stems.set(shown, pose.position);
    publisher.publish(
      selectLocalInfrastructureOverlayCohort(shown, {
        maxEntries: labelMax,
        gridPx: labelGridPx,
        width: size.width,
        height: size.height,
        cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
        project: (r) => engine.projector.worldToWindow(r.tip, {}),
      }),
    );
    if (
      !retryTimer &&
      engine.surface.supported &&
      shown.some((r) => !r.grounded && r.distance < 75000 && r.tries < 30)
    ) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        wake();
      }, 2050);
    }
    wake();
  }
  function select(fid) {
    const row = records.get(fid);
    if (!row) return false;
    services.selectEntityContext(row);
    return true;
  }
  function hide() {
    clearTimeout(retryTimer);
    retryTimer = null;
    while (removers.length) removers.pop()();
    unbindShapes?.();
    unbindShapes = null;
    publisher.hide();
    display.destroy();
    points?.destroy();
    stems?.destroy();
    points = stems = dataset = null;
    records.clear();
    active.clear();
    grace.clear();
    shown = [];
    budget = 0;
    signature = topology = '';
    services.removeEntityContextsForLayer(id);
    services.hideOsmCredit(engine, id);
  }
  return {
    show(next) {
      if (dataset === next) return;
      dataset = next;
      points = engine.movers.createSet({
        id,
        kind: 'point',
        capacity: INFRA_LOD_ACTIVE_MAX,
        pickable: true,
        depthTest: 'always',
        point: { sizePx: 10, outlinePx: 2, outlineColor: [0, 0, 0, 1] },
      });
      stems = createStemBatch(native, color, INFRA_LOD_ACTIVE_MAX);
      for (const input of next.records) {
        const carto = geo.cartographic.fromDegrees(input.lon, input.lat);
        const base = geo.cartesian3.fromDegrees(input.lon, input.lat),
          tip = geo.cartesian3.clone(base);
        const priority = labelPriorityFromProperties(input.properties, id);
        const row = {
          ...input,
          carto,
          base,
          tip,
          priority,
          floor: 0,
          tries: 0,
          lastSample: -Infinity,
          grounded: false,
        };
        row.entry = createLocalInfrastructureOverlayEntry({
          id: row.id,
          layerId: id,
          position: tip,
          properties: row.properties,
          priority,
          accent: color,
        });
        records.set(row.id, row);
        services.registerEntityContext(row, {
          id: key(row.id),
          layerId: id,
          layerName: name,
          source,
          label: localInfrastructureOverlayCopy(row.properties, id).title,
          properties: row.properties,
          latitude: row.lat,
          longitude: row.lon,
        });
      }
      display.setVisible(true);
      publisher.show();
      if (next.features.length) services.showOsmCredit(engine, id);
      removers.push(
        engine.frames.preRender.addEventListener(() => sweep()),
        engine.camera.moveEnd.addEventListener(() => sweep(true)),
      );
      removers.push(
        engine.picker.registerMeshPicker((at) => {
          const hits = [];
          for (const row of shown) {
            const a = engine.projector.worldToWindow(row.base, {}),
              b = engine.projector.worldToWindow(row.tip, {});
            if (a && b && distanceToSegment(at, a, b) <= 2.5)
              hits.push({
                onTop: 0,
                order: 0,
                depth: row.distance,
                result: { id: key(row.id), owner: id },
              });
          }
          return hits;
        }),
      );
      removers.push(
        engine.input.on(
          'click',
          (event) => {
            if (!isPointerFree() || event.picked?.owner !== id) return;
            const fid = String(event.picked.id).slice(id.length + 1);
            const row = records.get(fid);
            const feature = row || next.features.find((f) => f.id === fid);
            if (!feature) return;
            if (row) select(fid);
            const [lon, lat] = row
              ? [row.lon, row.lat]
              : feature.geometry.coordinates[0];
            engine.camera.flyTo({
              destination: geo.cartesian3.fromDegrees(lon, lat, 5000),
              duration: 1.5,
            });
          },
          { pick: true },
        ),
      );
      sweep(true);
    },
    select,
    hide,
    destroy() {
      hide();
      publisher.destroy();
    },
    lod: () => ({
      total: records.size,
      active: active.size,
      budgetLimit: budget,
      computed: Boolean(dataset),
    }),
  };
}
