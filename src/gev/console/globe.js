import * as Cesium from 'cesium';
import { coverageColor } from './model.js';

/**
 * Everything the Ops console draws on the globe, owned in one place so it
 * can be cleared and destroyed cleanly. No Cesium text labels (repo rule):
 * names stay in the panel; the globe gets shapes, lines and points.
 */

const AIR = Cesium.Color.fromCssColorString('#00d4ff');
const SEA = Cesium.Color.fromCssColorString('#f0a63c');
const FENCE = Cesium.Color.fromCssColorString('#ff5c8a');
const TRACK = Cesium.Color.fromCssColorString('#7CFFB2');
const DRAW = Cesium.Color.fromCssColorString('#ffffff');
const BOTH = Cesium.ClassificationType.BOTH;

export function createOpsGlobe(viewer) {
  const source = new Cesium.CustomDataSource('gev-ops');
  viewer.dataSources.add(source);
  const points = viewer.scene.primitives.add(
    new Cesium.PointPrimitiveCollection(),
  );
  /** key -> PointPrimitive */
  const pointByKey = new Map();
  let coverage = null;
  let fenceEntities = [];
  let trackEntities = [];
  let footprintEntities = [];
  let drawEntities = [];
  let handler = null;
  const render = () => viewer.scene.requestRender?.();

  function clear(list) {
    for (const e of list) source.entities.remove(e);
    return [];
  }

  function setFences(fences) {
    fenceEntities = clear(fenceEntities);
    for (const f of fences || []) {
      const s = f.shape;
      if (s.type === 'circle') {
        fenceEntities.push(
          source.entities.add({
            position: Cesium.Cartesian3.fromDegrees(s.center[0], s.center[1]),
            ellipse: {
              semiMajorAxis: s.radiusM,
              semiMinorAxis: s.radiusM,
              material: FENCE.withAlpha(0.14),
              classificationType: BOTH,
            },
          }),
        );
        const ring = [];
        for (let i = 0; i <= 72; i++)
          ring.push(...offsetDeg(s.center[1], s.center[0], i * 5, s.radiusM));
        fenceEntities.push(
          source.entities.add({
            polyline: borderLine(
              Cesium.Cartesian3.fromDegreesArray(ring),
              FENCE,
            ),
          }),
        );
      } else {
        const flat = s.coords.flat();
        fenceEntities.push(
          source.entities.add({
            polygon: {
              hierarchy: Cesium.Cartesian3.fromDegreesArray(flat),
              material: FENCE.withAlpha(0.14),
              classificationType: BOTH,
            },
          }),
        );
        fenceEntities.push(
          source.entities.add({
            polyline: borderLine(
              Cesium.Cartesian3.fromDegreesArray([...flat, ...s.coords[0]]),
              FENCE,
            ),
          }),
        );
      }
    }
    render();
  }

  function setTrack(fixes, domain) {
    trackEntities = clear(trackEntities);
    if (!fixes?.length) return render();
    const air = domain === 'air';
    const positions = fixes.map((f) =>
      Cesium.Cartesian3.fromDegrees(
        f.lon,
        f.lat,
        air && Number.isFinite(f.alt) ? f.alt : 0,
      ),
    );
    trackEntities.push(
      source.entities.add({
        polyline: air
          ? {
              positions,
              width: 2.5,
              material: TRACK,
              depthFailMaterial: TRACK.withAlpha(0.35),
            }
          : borderLine(positions, TRACK),
      }),
    );
    const last = fixes[fixes.length - 1];
    trackEntities.push(
      source.entities.add({
        position: Cesium.Cartesian3.fromDegrees(
          last.lon,
          last.lat,
          air && Number.isFinite(last.alt) ? last.alt : 0,
        ),
        point: {
          pixelSize: 9,
          color: TRACK,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }),
    );
    render();
  }

  /** Replace replay heads. items: [{key, domain, lat, lon, alt}] */
  function setReplay(items) {
    const seen = new Set();
    for (const it of items) {
      seen.add(it.key);
      const pos = Cesium.Cartesian3.fromDegrees(
        it.lon,
        it.lat,
        it.domain === 'air' && Number.isFinite(it.alt) ? it.alt : 0,
      );
      let p = pointByKey.get(it.key);
      if (!p) {
        p = points.add({
          position: pos,
          pixelSize: it.domain === 'air' ? 6 : 7,
          color: it.domain === 'air' ? AIR : SEA,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
        pointByKey.set(it.key, p);
      } else p.position = pos;
      p.show = true;
    }
    for (const [key, p] of pointByKey) {
      if (seen.has(key)) continue;
      points.remove(p);
      pointByKey.delete(key);
    }
    render();
  }

  function setCoverage(grid) {
    if (coverage) {
      viewer.scene.primitives.remove(coverage);
      coverage = null;
    }
    footprintEntities = clear(footprintEntities);
    if (!grid) return render();
    const { rows, cols, dLat, dLon, bbox } = grid;
    const counts = expand(grid.counts, rows * cols);
    const instances = [];
    // Merge horizontal runs of equal count into one rectangle each.
    for (let r = 0; r < rows && instances.length < 60_000; r++) {
      let c = 0;
      while (c < cols) {
        const v = counts[r * cols + c];
        let e = c + 1;
        while (e < cols && counts[r * cols + e] === v) e++;
        const rgba = coverageColor(v);
        if (rgba) {
          const color = new Cesium.Color(
            rgba[0] / 255,
            rgba[1] / 255,
            rgba[2] / 255,
            rgba[3],
          );
          instances.push(
            new Cesium.GeometryInstance({
              geometry: new Cesium.RectangleGeometry({
                rectangle: Cesium.Rectangle.fromDegrees(
                  bbox.minLon + c * dLon,
                  bbox.minLat + r * dLat,
                  bbox.minLon + e * dLon,
                  bbox.minLat + (r + 1) * dLat,
                ),
              }),
              attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
              },
            }),
          );
        }
        c = e;
      }
    }
    if (instances.length) {
      coverage = viewer.scene.primitives.add(
        new Cesium.GroundPrimitive({
          geometryInstances: instances,
          appearance: new Cesium.PerInstanceColorAppearance({
            flat: true,
            translucent: true,
          }),
          classificationType: BOTH,
        }),
      );
    }
    for (const fp of grid.footprints || []) {
      if (fp.polygon) {
        footprintEntities.push(
          source.entities.add({
            polyline: borderLine(
              Cesium.Cartesian3.fromDegreesArray(fp.polygon.flat()),
              fp.lowConfidence
                ? Cesium.Color.WHITE.withAlpha(0.35)
                : Cesium.Color.WHITE.withAlpha(0.8),
              1,
            ),
          }),
        );
      } else {
        footprintEntities.push(
          source.entities.add({
            position: Cesium.Cartesian3.fromDegrees(fp.lon, fp.lat),
            point: {
              pixelSize: 5,
              color: Cesium.Color.WHITE.withAlpha(0.5),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }),
        );
      }
    }
    render();
  }

  function pickLonLat(screen) {
    const scene = viewer.scene;
    let cart;
    if (scene.pickPositionSupported) {
      try {
        cart = scene.pickPosition(screen);
      } catch {
        cart = undefined;
      }
    }
    if (!cart)
      cart = viewer.camera.pickEllipsoid(screen, scene.globe.ellipsoid);
    if (!cart) return null;
    const c = Cesium.Cartographic.fromCartesian(cart);
    return {
      lat: Cesium.Math.toDegrees(c.latitude),
      lon: Cesium.Math.toDegrees(c.longitude),
    };
  }

  /**
   * Interactive fence drawing. Left click adds a point; for circles the
   * second click sets the radius; for polygons right click or double click
   * finishes. Escape cancels.
   * @returns {Promise<{lat:number, lon:number}[]|null>} Points or null.
   */
  function draw(mode) {
    stopDraw();
    const pts = [];
    handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    const redraw = () => {
      drawEntities = clear(drawEntities);
      for (const p of pts)
        drawEntities.push(
          source.entities.add({
            position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
            point: {
              pixelSize: 8,
              color: DRAW,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }),
        );
      if (pts.length > 1)
        drawEntities.push(
          source.entities.add({
            polyline: borderLine(
              Cesium.Cartesian3.fromDegreesArray(
                pts.flatMap((p) => [p.lon, p.lat]),
              ),
              DRAW,
              2,
            ),
          }),
        );
      render();
    };
    return new Promise((resolve) => {
      const finish = (value) => {
        stopDraw();
        window.removeEventListener('keydown', onKey, true);
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') finish(null);
        if (e.key === 'Enter' && mode === 'polygon' && pts.length >= 3)
          finish(pts.slice());
      };
      window.addEventListener('keydown', onKey, true);
      handler.setInputAction((e) => {
        const p = pickLonLat(e.position);
        if (!p) return;
        pts.push(p);
        redraw();
        if (mode === 'circle' && pts.length === 2) finish(pts.slice());
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      const close = () => {
        if (mode === 'polygon' && pts.length >= 3) finish(pts.slice());
      };
      handler.setInputAction(close, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
      handler.setInputAction(
        close,
        Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
      );
    });
  }

  function stopDraw() {
    if (handler) {
      handler.destroy();
      handler = null;
    }
    drawEntities = clear(drawEntities);
    render();
  }

  function viewRect() {
    const r = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
    if (!r) return null;
    return {
      west: Cesium.Math.toDegrees(r.west),
      south: Cesium.Math.toDegrees(r.south),
      east: Cesium.Math.toDegrees(r.east),
      north: Cesium.Math.toDegrees(r.north),
    };
  }

  function flyTo(lat, lon, height = 6000) {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      duration: 1.6,
    });
  }

  return {
    setFences,
    setTrack,
    setReplay,
    setCoverage,
    draw,
    stopDraw,
    viewRect,
    flyTo,
    destroy() {
      stopDraw();
      setCoverage(null);
      viewer.scene.primitives.remove(points);
      viewer.dataSources.remove(source, true);
    },
  };
}

function borderLine(positions, color, width = 2) {
  return {
    positions,
    width,
    material: color,
    clampToGround: true,
    classificationType: BOTH,
  };
}

function offsetDeg(lat, lon, bearingDeg, distM) {
  const R = 6371008.8;
  const d = Math.PI / 180;
  const b = bearingDeg * d;
  const la = lat * d;
  const ad = distM / R;
  const la2 = Math.asin(
    Math.sin(la) * Math.cos(ad) + Math.cos(la) * Math.sin(ad) * Math.cos(b),
  );
  const lo2 =
    lon * d +
    Math.atan2(
      Math.sin(b) * Math.sin(ad) * Math.cos(la),
      Math.cos(ad) - Math.sin(la) * Math.sin(la2),
    );
  return [lo2 / d, la2 / d];
}

function expand(pairs, length) {
  const out = new Uint8Array(length);
  let k = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    out.fill(pairs[i], k, k + pairs[i + 1]);
    k += pairs[i + 1];
  }
  return out;
}
