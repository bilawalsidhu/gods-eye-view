import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import { formatQuantity } from '../../ui/unitLabels.js';
import { horizonOccluder } from '../../data/iconOrientation.js';
import { transitStyleProfile } from '../../data/transitPresetStyle.js';
import {
  buildSondeLabel,
  RADIOSONDES_LABEL_STYLE,
  RADIOSONDES_OVERLAY_OPTIONS,
  RADIOSONDES_OVERLAY_SOURCE_ID,
} from './cards.js';
import * as policy from './policy.js';
import { isSondeAloft, isSondeLanded } from './records.js';
import { createSondeRenderModel } from './renderModel.js';

/** North-up 20 px art, rasterised at 3x for crisp orbital sprites. */
function createSondeSprite(color, symbol, outlinePx) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 60;
  const ctx = canvas.getContext('2d');
  ctx.scale(3, 3);
  ctx.globalAlpha = symbol.alpha;
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.fillStyle = color;
  const fill = () => {
    ctx.fill();
    ctx.strokeStyle = policy.RADIOSONDE_OUTLINE;
    ctx.lineWidth = outlinePx;
    ctx.stroke();
  };
  const stroke = (width = 1.25) => {
    ctx.strokeStyle = policy.RADIOSONDE_OUTLINE;
    ctx.lineWidth = width + outlinePx;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  const payload = () => {
    ctx.fillRect(8.5, 16.5, 3, 2.5);
    ctx.strokeStyle = policy.RADIOSONDE_OUTLINE;
    ctx.lineWidth = outlinePx;
    ctx.strokeRect(8.5, 16.5, 3, 2.5);
  };
  if (symbol.shape === 'ground') {
    ctx.beginPath();
    ctx.arc(10, 9.5, 3.25, 0, Math.PI * 2);
    fill();
    ctx.beginPath();
    ctx.moveTo(5, 15);
    ctx.lineTo(15, 15);
    stroke(1.75);
  } else if (symbol.shape === 'parachute') {
    ctx.beginPath();
    ctx.moveTo(2.5, 9);
    ctx.lineTo(9, 16.5);
    ctx.moveTo(10, 9);
    ctx.lineTo(10, 16.5);
    ctx.moveTo(17.5, 9);
    ctx.lineTo(11, 16.5);
    stroke();
    ctx.beginPath();
    ctx.moveTo(1.75, 9);
    ctx.bezierCurveTo(2, -1, 18, -1, 18.25, 9);
    ctx.lineTo(1.75, 9);
    ctx.closePath();
    fill();
    payload();
  } else {
    ctx.beginPath();
    ctx.moveTo(10, 1.5);
    ctx.bezierCurveTo(1, 1.5, 1, 8.5, 5.5, 12);
    ctx.bezierCurveTo(7, 13.5, 8.5, 14, 10, 14);
    ctx.bezierCurveTo(11.5, 14, 13, 13.5, 14.5, 12);
    ctx.bezierCurveTo(19, 8.5, 19, 1.5, 10, 1.5);
    ctx.closePath();
    const lost = symbol.shape === 'lost-balloon';
    if (lost) {
      ctx.setLineDash([3, 2.5]);
      stroke(1.5);
    } else fill();
    ctx.beginPath();
    ctx.moveTo(10, 14);
    ctx.lineTo(10, 16.5);
    stroke();
    if (lost) ctx.strokeRect(8.5, 16.5, 3, 2.5);
    else payload();
  }
  return canvas.toDataURL();
}

/** Own balloon sprites, selected altitude marks and world-overlay labels. */
export function createRadiosondeRendering({ viewer, services, overlayHost }) {
  const scene = viewer.scene;
  const billboards = scene.primitives.add(
    new Cesium.BillboardCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
      show: false,
    }),
  );
  const lines = scene.primitives.add(
    new Cesium.PolylineCollection({ show: false }),
  );
  const points = scene.primitives.add(
    new Cesium.PointPrimitiveCollection({ show: false }),
  );
  const burst = points.add({
    position: Cesium.Cartesian3.ZERO,
    show: false,
    pixelSize: 9,
    color: Cesium.Color.fromCssColorString(policy.RADIOSONDE_COLOR),
    outlineColor: Cesium.Color.fromCssColorString(policy.RADIOSONDE_OUTLINE),
    outlineWidth: 2,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  });
  const cache = new Map();
  let style = 'normal',
    enabled = false,
    geoidReady = false,
    dropVisible = true,
    burstPosition = null,
    burstPoint = null,
    selectedSerial = null,
    scaleSignature = '',
    altitudeTicks = [],
    geometryRevision = 0,
    labelSignature = '';
  let trackPositions = [],
    trail = null,
    trailVisible = null;
  services.sprites?.registerSpriteCollection?.('radiosondes', billboards);
  services.sprites?.registerSpriteCollection?.('radiosondes-burst', points);
  const n = (p) =>
    geoidReady ? services.geoid?.geoidHeight?.(p.lat, p.lon) || 0 : 0;
  // Use cached ground floors; one bounded resolve lifts cold cells in place
  // without triggering per-contact scene rendering and pixel readback.
  let floorColdPending = false;
  let floorResolve = null;
  function position(frame, landed = false) {
    let height = frame.altM + n(frame);
    if (landed) {
      const floor = services.groundFloor?.cachedGroundFloor?.(
        frame.lat,
        frame.lon,
      );
      if (floor == null && !floorColdPending) {
        floorColdPending = true;
        queueMicrotask(warmColdFloors);
      }
      height = Number.isFinite(floor) ? floor : n(frame);
    }
    return Cesium.Cartesian3.fromDegrees(frame.lon, frame.lat, height);
  }
  function warmColdFloors() {
    if (!floorColdPending || floorResolve) return;
    floorColdPending = false;
    const resolve = services.groundFloor?.resolveGroundFloorCellsBounded;
    if (!enabled || typeof resolve !== 'function') return;
    const landed = [...marks.values()].filter((mark) =>
      isSondeLanded(mark.phase),
    );
    if (!landed.length) return;
    floorResolve = Promise.resolve(
      resolve(landed.map(({ frame }) => ({ lat: frame.lat, lon: frame.lon }))),
    )
      .catch(() => {})
      .then(() => {
        floorResolve = null;
        if (!enabled) return;
        let changed = false;
        for (const mark of marks.values()) {
          if (!isSondeLanded(mark.phase)) continue;
          const next = position(mark.frame, true);
          if (Cesium.Cartesian3.equals(next, mark.sprite.position)) continue;
          mark.sprite.position = next;
          if (!mark.selected) mark.line.positions = [mark.foot, next];
          changed = true;
        }
        if (changed)
          services.render?.governorRequestRender?.('radiosondes-ground');
      });
  }
  function image(phase, selected = false) {
    const profile = transitStyleProfile(style);
    const symbol = policy.RADIOSONDE_SYMBOLS[phase];
    const color =
      profile === 'mono' || (selected && isSondeAloft(phase))
        ? policy.RADIOSONDE_MONO_COLOR
        : symbol.color;
    const key = `${color}:${symbol.shape}:${symbol.alpha}:${profile}`;
    if (!cache.has(key))
      cache.set(
        key,
        createSondeSprite(
          color,
          symbol,
          profile === 'mono' ? 2 : profile === 'crt' ? 1.25 : 1.5,
        ),
      );
    return cache.get(key);
  }
  const model = createSondeRenderModel({
    create(record) {
      return {
        sprite: billboards.add({
          id: `radiosonde:${record.frame.serial}`,
          position: Cesium.Cartesian3.ZERO,
          show: false,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(
            ...policy.RADIOSONDE_SCALE_BY_DISTANCE,
          ),
        }),
        line: lines.add({
          positions: [Cesium.Cartesian3.ZERO, Cesium.Cartesian3.UNIT_X],
          width: 1,
          show: false,
          material: Cesium.Material.fromType('Color', {
            color: Cesium.Color.fromCssColorString(
              policy.RADIOSONDE_COLOR,
            ).withAlpha(policy.RADIOSONDE_DROP_LINE_ALPHA),
          }),
        }),
      };
    },
    update(mark, record) {
      const { frame } = record;
      mark.sprite.position = position(frame, isSondeLanded(record.phase));
      mark.foot = Cesium.Cartesian3.fromDegrees(frame.lon, frame.lat, n(frame));
      mark.sprite.image = image(mark.phase, mark.selected);
      mark.sprite.width = mark.sprite.height =
        policy.RADIOSONDE_SPRITE_PX * (mark.selected ? 1.5 : 1);
      mark.sprite.scale = transitStyleProfile(style) === 'normal' ? 1 : 1.3;
      if (!mark.selected || !isSondeAloft(record.phase))
        mark.line.positions = [mark.foot, mark.sprite.position];
    },
    remove(mark) {
      billboards.remove(mark.sprite);
      lines.remove(mark.line);
    },
  });
  const { marks } = model;
  function sync(records, selected, force = false) {
    selectedSerial = selected;
    if (force) geometryRevision++;
    const result = model.sync(
      records,
      selected,
      `${style}:${geometryRevision}`,
    );
    syncAltitudeScale();
    return result;
  }
  function syncAltitudeScale() {
    const mark = marks.get(selectedSerial);
    if (!mark || !isSondeAloft(mark.phase)) {
      altitudeTicks = [];
      scaleSignature = '';
      return;
    }
    const ceiling = Math.max(mark.frame.altM, burstPoint?.altM ?? 0);
    const signature = JSON.stringify([
      selectedSerial,
      mark.frame.lon,
      mark.frame.lat,
      n(mark.frame),
      ceiling,
    ]);
    if (signature === scaleSignature) return;
    scaleSignature = signature;
    // During descent the ruler retains the observed maximum, so every tick
    // stays on the selected vertical line rather than floating above its end.
    mark.line.positions = [
      mark.foot,
      position({ ...mark.frame, altM: ceiling }),
    ];
    altitudeTicks = policy.RADIOSONDE_ALTITUDE_TICKS_M.filter(
      (altM) => altM < ceiling,
    ).map((altM) => ({
      altM,
      position: position({ ...mark.frame, altM }),
      show: false,
    }));
  }
  const occluder = () =>
    services.horizonOccluder?.(viewer.camera) ??
    (viewer.camera?.positionWC ? horizonOccluder(viewer.camera) : null);
  function cull() {
    if (!enabled) return false;
    let changed = false;
    const occlusion = occluder();
    const visible = (p) => !occlusion || occlusion.isPointVisible(p) === true;
    dropVisible = policy.dropLinesVisible(
      viewer.camera?.positionCartographic?.height ?? Infinity,
      dropVisible,
    );
    for (const mark of marks.values()) {
      const show = visible(mark.sprite.position);
      if (mark.sprite.show !== show) {
        mark.sprite.show = show;
        changed = true;
      }
      const showLine =
        dropVisible &&
        isSondeAloft(mark.phase) &&
        mark.line.positions.some(visible);
      if (mark.line.show !== showLine) {
        mark.line.show = showLine;
        changed = true;
      }
    }
    const showBurst = !!burstPosition && visible(burstPosition);
    if (burst.show !== showBurst) {
      burst.show = showBurst;
      changed = true;
    }
    for (const tick of altitudeTicks)
      tick.show = dropVisible && visible(tick.position);
    const samples = trackPositions.filter(
      (p, i) =>
        i === 0 ||
        i === trackPositions.length - 1 ||
        i % policy.RADIOSONDE_TRAIL_CULL_STRIDE === 0,
    );
    const showTrail = samples.some(visible);
    if (trail && trailVisible !== showTrail) {
      trail.setVisible(showTrail);
      trailVisible = showTrail;
      changed = true;
    }
    return changed;
  }
  function labels(selected) {
    if (!overlayHost || !enabled) return false;
    const entries = [];
    if (burstPoint && burst.show)
      entries.push({
        ...RADIOSONDES_LABEL_STYLE,
        id: `sonde-burst:${selected}`,
        position: burstPosition,
        title: `${t('BURST')} · ${formatQuantity(burstPoint.altM, 'm', { maximumFractionDigits: 0 })}`,
        priority: Number.MAX_SAFE_INTEGER - 1,
      });
    for (const tick of altitudeTicks) {
      if (!tick.show) continue;
      entries.push({
        ...RADIOSONDES_LABEL_STYLE,
        id: `sonde-altitude:${selected}:${tick.altM}`,
        position: tick.position,
        title: `─ ${formatQuantity(tick.altM / 1000, 'km', { maximumFractionDigits: 0 })}`,
        priority: Number.MAX_SAFE_INTEGER - 2,
        placement: 'right',
        gapPx: 0,
      });
    }
    // Reject off-screen and far-side points before ranking. The overlay host
    // owns pixel collision handling; no second spacing filter thins the labels.
    const candidates = [];
    const heightM = viewer.camera?.positionCartographic?.height ?? Infinity;
    for (const mark of marks.values()) {
      if (!mark.sprite.show || mark.frame.serial === selected) continue;
      if (
        !isSondeAloft(mark.phase) &&
        heightM > policy.RADIOSONDE_TERMINAL_LABEL_MAX_HEIGHT_M
      )
        continue;
      const screen =
        services.project?.(scene, mark.sprite.position) ??
        Cesium.SceneTransforms.worldToWindowCoordinates(
          scene,
          mark.sprite.position,
        );
      if (
        !screen ||
        screen.x < -policy.LABEL_VIEW_MARGIN_PX ||
        screen.y < -policy.LABEL_VIEW_MARGIN_PX ||
        screen.x > scene.canvas.clientWidth + policy.LABEL_VIEW_MARGIN_PX ||
        screen.y > scene.canvas.clientHeight + policy.LABEL_VIEW_MARGIN_PX
      )
        continue;
      candidates.push(mark);
    }
    candidates.sort(
      (a, b) =>
        isSondeAloft(b.phase) - isSondeAloft(a.phase) ||
        (a.phase === 'descending') - (b.phase === 'descending') ||
        b.frame.altM - a.frame.altM ||
        b.frame.timeMs - a.frame.timeMs ||
        a.frame.serial.localeCompare(b.frame.serial),
    );
    for (const mark of candidates) {
      if (entries.length >= RADIOSONDES_OVERLAY_OPTIONS.cohortLimit) break;
      const label = buildSondeLabel(mark.frame, mark.phase);
      entries.push({
        ...label,
        position: mark.sprite.position,
        priority: policy.MAX_SONDES_RENDERED - entries.length,
      });
    }
    const signature = JSON.stringify(entries);
    if (signature === labelSignature) return false;
    labelSignature = signature;
    overlayHost.setEntries(
      RADIOSONDES_OVERLAY_SOURCE_ID,
      entries,
      RADIOSONDES_OVERLAY_OPTIONS,
    );
    return true;
  }
  return {
    sync,
    cull,
    labels,
    position,
    setEnabled(value) {
      enabled = value;
      billboards.show = lines.show = points.show = value;
      if (!value) {
        model.clear();
        altitudeTicks = [];
        selectedSerial = null;
        scaleSignature = '';
        labelSignature = '';
      }
    },
    setGeoidReady() {
      geoidReady = true;
      geometryRevision++;
    },
    setStyle(value) {
      style = value;
    },
    setTrail(renderer, positions) {
      if (trail !== renderer) trailVisible = null;
      trail = renderer;
      trackPositions = positions;
    },
    setBurst(point) {
      burstPoint = point;
      burstPosition = point ? position(point) : null;
      if (burstPosition) {
        if (!Cesium.Cartesian3.equals(burst.position, burstPosition))
          burst.position = burstPosition;
      } else if (burst.show) burst.show = false;
      syncAltitudeScale();
    },
    anchor: (serial) => marks.get(serial)?.sprite.position,
    destroy() {
      services.sprites?.unregisterSpriteCollection?.('radiosondes', billboards);
      services.sprites?.unregisterSpriteCollection?.(
        'radiosondes-burst',
        points,
      );
      for (const collection of [billboards, lines, points])
        scene.primitives.remove(collection);
      marks.clear();
      cache.clear();
    },
  };
}
