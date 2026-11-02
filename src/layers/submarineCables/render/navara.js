import * as geo from '../../../geo/index.js';
import { Color } from 'three';
import { isPointerFree } from '../../../data/inputOwnership.js';
import {
  featureLabel,
  featureReference,
  normalizeFeatures,
} from '../geometry.js';
import {
  BASE_CABLE_COLOR,
  BASE_LANDING_COLOR,
  CABLE_OVERLAY_SOURCE_ID as id,
} from '../policy.js';
import {
  cableReferencePriority,
  clampLabel,
  createCableOverlayEntry,
  createCableOverlayPublisher,
  createCableReferenceSweepGate,
  selectCableReferenceLabelWinners,
  updateCableReferenceTip,
} from '../overlay.js';
import { createStemBatch } from '../../shared/render/navaraStems.js';
import { bindGroundShapePicks } from '../../shared/render/navaraGroundPicks.js';
import { rgbaFromCss } from '../../shared/color.js';
import { distanceToSegment } from '../../../globe/cpuPicks.js';

export function createNavaraCables(engine, native, host) {
  const { view } = native;
  const publisher = createCableOverlayPublisher({ host }),
    gate = createCableReferenceSweepGate();
  const records = new Map(),
    banks = [],
    removers = [];
  let source,
    layer,
    dataset,
    lastLabels = null,
    referenceLabelCount = 0;
  const wake = () => engine.render.request(id);
  function sweep() {
    const position = engine.camera.livePosition;
    if (!position || !gate.shouldRun({ positionWC: position })) return;
    const { height } = engine.host.size(),
      { fovy } = engine.camera.pose();
    for (const bank of banks) {
      const visible = [];
      for (const row of bank.rows) {
        row.visible = engine.projector.horizonVisible(row.base);
        if (!row.visible) continue;
        row.distanceM = geo.cartesian3.distance(position, row.base);
        updateCableReferenceTip(row, position, height, fovy);
        bank.points.set(visible.length, {
          position: row.tip,
          pickId: row.id,
          show: true,
          color: bank.color,
        });
        visible.push(row);
      }
      bank.points.setCount(visible.length);
      bank.points.commit();
      bank.stems.set(visible, position);
    }
    const winners = selectCableReferenceLabelWinners([...records.values()]);
    referenceLabelCount = winners.length;
    const signature = winners
      .map((r) => r.id + '/' + cableReferencePriority(r.distanceM))
      .join('|');
    if (signature !== lastLabels) {
      lastLabels = signature;
      publisher.publish(
        winners.map((r) => {
          r.entry.priority = cableReferencePriority(r.distanceM);
          return r.entry;
        }),
      );
    }
  }
  function hide() {
    for (const fn of removers.splice(0)) fn();
    for (const bank of banks.splice(0)) {
      bank.points?.destroy();
      bank.stems?.destroy();
      bank.surface?.destroy();
    }
    layer?.delete();
    source?.delete();
    source = layer = dataset = null;
    records.clear();
    gate.reset();
    lastLabels = null;
    referenceLabelCount = 0;
    publisher.hide();
    wake();
  }
  function show(next) {
    if (next === dataset) return;
    if (dataset) hide();
    try {
      const cables = normalizeFeatures(next.cables, 'cable'),
        landings = normalizeFeatures(next.landingPoints, 'landing');
      const shapes = [],
        colors = new Map();
      for (const [kind, features, css] of [
        ['cable', cables, BASE_CABLE_COLOR],
        ['landing-point', landings, BASE_LANDING_COLOR],
      ]) {
        const rows = [],
          color = rgbaFromCss(css).rgba();
        for (const f of features) {
          const ref = featureReference(f);
          if (!ref) continue;
          const key = id + ':' + kind + ':' + rows.length;
          const base = geo.cartesian3.fromDegrees(ref.lon, ref.lat);
          const row = {
            id: key,
            reference: ref,
            label: clampLabel(featureLabel(f)),
            kind,
            base,
            tip: geo.cartesian3.fromDegrees(ref.lon, ref.lat, 2500),
            nextTip: geo.cartesian3.create(),
          };
          row.entry = createCableOverlayEntry(row);
          records.set(key, row);
          rows.push(row);
          const geom = f.geometry;
          if (geom.type === 'Point')
            shapes.push({
              id: key,
              geometry: { type: 'point', position: geom.coordinates },
              style: { pointRadius: 5 },
            });
          else
            for (const path of geom.type === 'MultiLineString'
              ? geom.coordinates
              : [geom.coordinates])
              if (path.length > 1)
                shapes.push({
                  id: key,
                  geometry: { type: 'line', positions: path },
                  style: { lineWidth: 2.5 },
                });
        }
        if (!rows.length) continue;
        const bank = { rows, color };
        banks.push(bank);
        const point = {
          sizePx: kind === 'cable' ? 7 : 8,
          outlinePx: 1,
          outlineColor: [0, 0, 0, 0.65],
        };
        const make = (role) =>
          engine.movers.createSet({
            id: id + '-' + kind + role,
            kind: 'point',
            capacity: rows.length,
            depthTest: 'normal',
            pickable: true,
            point,
          });
        bank.points = make('-tip');
        bank.stems = createStemBatch(
          native,
          css,
          rows.length,
          kind === 'cable' ? 2 : 2.4,
          kind === 'cable' ? 0.58 : 0.68,
        );
        if (kind === 'landing-point') {
          bank.surface = make('-base');
          rows.forEach((row, i) =>
            bank.surface.set(i, {
              position: row.base,
              show: true,
              pickId: row.id,
              color,
            }),
          );
          bank.surface.setCount(rows.length);
          bank.surface.commit();
        }
      }
      source = view.addSource({
        type: 'geojson',
        data: { type: 'FeatureCollection', features: cables },
      });
      layer = view.addLayer({
        type: 'vector',
        source,
        polyline: {
          clampToGround: true,
          width: 2.5,
          lit: false,
          color: 0xffffff,
          opacity: 0.92,
          transparent: true,
        },
      });
      layer.on('featureUpdated', ({ evaluator }) =>
        evaluator.evaluate(({ properties }) => {
          const css = properties?.color ?? BASE_CABLE_COLOR;
          if (!colors.has(css)) colors.set(css, new Color(css));
          return { color: colors.get(css) };
        }),
      );
      layer.forceUpdate();
      removers.push(bindGroundShapePicks(engine, id, shapes));
      removers.push(
        engine.picker.registerMeshPicker((at) => {
          const hits = [];
          for (const r of records.values()) {
            if (!r.visible) continue;
            const a = engine.projector.worldToWindow(r.base, {}),
              b = engine.projector.worldToWindow(r.tip, {});
            if (a && b && distanceToSegment(at, a, b) <= 2)
              hits.push({
                onTop: 0,
                order: 0,
                depth: r.distanceM,
                result: { id: r.id, owner: id },
              });
          }
          return hits;
        }),
      );
      removers.push(
        engine.input.on(
          'click',
          (e) => {
            if (!isPointerFree()) return;
            const row = records.get(e.picked?.id);
            if (!row) return;
            engine.camera.flyTo({
              destination: geo.cartesian3.fromDegrees(
                row.reference.lon,
                row.reference.lat,
                6500,
              ),
              orientation: {
                heading: engine.camera.pose().heading,
                pitch: geo.math.toRadians(-52),
                roll: 0,
              },
              duration: 1.35,
            });
          },
          { pick: true },
        ),
        engine.camera.moveEnd.addEventListener(() => {
          gate.markDirty();
          wake();
        }),
        engine.frames.preRender.addEventListener(sweep),
      );
      dataset = next;
      publisher.show();
      gate.markDirty();
      sweep();
      wake();
    } catch (e) {
      hide();
      throw e;
    }
  }
  return { show, hide, destroy: hide, stats: () => ({ referenceLabelCount }) };
}
