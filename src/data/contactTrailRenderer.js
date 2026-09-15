import * as Cesium from 'cesium';

const ALPHA_STOPS = [
  [0, 0.8],
  [120000, 0.45],
  [600000, 0.2],
  [900000, 0.08],
];
export function trailAlpha(ageMs) {
  const stops = ALPHA_STOPS;
  for (let i = 1; i < stops.length; i++) {
    if (ageMs === stops[i][0]) return stops[i][1];
    if (ageMs < stops[i][0]) {
      const [a, x] = stops[i - 1],
        [b, y] = stops[i];
      return x + ((y - x) * Math.max(0, ageMs - a)) / (b - a);
    }
  }
  return 0.08;
}

/** One static history batch and one frequently updated head. Never entities. */
export function createContactTrailRenderer(scene) {
  const heads = scene.primitives.add(new Cesium.PolylineCollection());
  const backing = heads.add({
    positions: [],
    width: 4,
    show: false,
    material: Cesium.Material.fromType('Color', {
      color: new Cesium.Color(0.02, 0.03, 0.05, 0.8),
    }),
  });
  const head = heads.add({
    positions: [],
    width: 2,
    show: false,
    material: Cesium.Material.fromType('Color', {
      color: Cesium.Color.WHITE.clone(),
    }),
  });
  let body = null,
    segments = [],
    revision = -1,
    visible = true,
    style = '#5EF08A';
  let lastSecond = -1,
    completed = -1,
    active = null;
  const styleColor = Cesium.Color.fromCssColorString(style);
  const attributeIds = [];
  const color = new Cesium.Color(),
    endpoint = new Cesium.Cartesian3();
  const headPositions = [new Cesium.Cartesian3(), endpoint];
  let rebuilds = 0;
  function tint(alpha, dark = false) {
    if (dark) {
      color.red = 0.02;
      color.green = 0.03;
      color.blue = 0.05;
    } else Cesium.Color.clone(styleColor, color);
    color.alpha = alpha;
    return color;
  }
  function replaceHistory(next) {
    if (next.revision === revision) return;
    revision = next.revision;
    segments = next.segments;
    completed = -1;
    lastSecond = -1;
    active = null;
    if (body) scene.primitives.remove(body);
    body = null;
    const instances = [];
    attributeIds.length = 0;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      attributeIds.push([`${i}:0`, `${i}:1`]);
      if (segment.positions.length < 2) continue;
      for (let lane = 0; lane < 2; lane++) {
        instances.push(
          new Cesium.GeometryInstance({
            id: `${i}:${lane}`,
            geometry: new Cesium.PolylineGeometry({
              positions: segment.positions,
              width: lane ? 2 : 4,
              arcType: Cesium.ArcType.NONE,
              vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                tint(0.8, !lane),
              ),
              depthFailColor: Cesium.ColorGeometryInstanceAttribute.fromColor(
                tint(0.8, !lane),
              ),
              show: new Cesium.ShowGeometryInstanceAttribute(false),
            },
          }),
        );
      }
    }
    if (instances.length) {
      const depthFailAppearance = new Cesium.PolylineColorAppearance({
        translucent: true,
        fragmentShaderSource:
          'in vec4 v_color; void main() { out_FragColor = czm_gammaCorrect(vec4(v_color.rgb, v_color.a * 0.2)); }',
      });
      body = scene.primitives.add(
        new Cesium.Primitive({
          geometryInstances: instances,
          appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
          depthFailAppearance,
          allowPicking: false,
          asynchronous: false,
          show: visible,
        }),
      );
      rebuilds++;
    }
  }
  function setDisplaySample(sample, renderedPosition) {
    if (!sample || !renderedPosition) {
      head.show = false;
      backing.show = false;
      return;
    }
    const second = Math.floor(sample.displayT / 1000);
    let lo = 0,
      hi = segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (segments[mid].toT <= sample.displayT) lo = mid + 1;
      else hi = mid;
    }
    const done = lo - 1;
    const candidate = segments[lo];
    const segment =
      candidate &&
      candidate.fromT <= sample.displayT &&
      candidate.fromSeq === sample.fromSeq &&
      candidate.toSeq === sample.toSeq
        ? candidate
        : null;
    if (body?.ready && done !== completed) {
      for (
        let i = Math.min(done, completed) + 1;
        i <= Math.max(done, completed);
        i++
      ) {
        for (let lane = 0; lane < 2; lane++) {
          const attributes = body.getGeometryInstanceAttributes(
            attributeIds[i][lane],
          );
          if (!attributes) continue;
          attributes.show[0] = i <= done ? 1 : 0;
          attributes.show = attributes.show;
        }
      }
      completed = done;
    }
    if (body?.ready && second !== lastSecond) {
      for (let i = 0; i < segments.length; i++) {
        const alpha = trailAlpha(sample.displayT - segments[i].toT);
        for (let lane = 0; lane < 2; lane++) {
          const attributes = body.getGeometryInstanceAttributes(
            attributeIds[i][lane],
          );
          if (!attributes) continue;
          Cesium.ColorGeometryInstanceAttribute.toValue(
            tint(alpha, !lane),
            attributes.color,
          );
          attributes.color = attributes.color;
          Cesium.ColorGeometryInstanceAttribute.toValue(
            tint(alpha, !lane),
            attributes.depthFailColor,
          );
          attributes.depthFailColor = attributes.depthFailColor;
        }
      }
      lastSecond = second;
    }
    const show = visible && !!segment && sample.fraction < 1;
    head.show = show;
    backing.show = show;
    if (!show) return;
    if (active !== segment) {
      active = segment;
      headPositions[0] = segment.positions[0];
      headPositions[1] = endpoint;
    }
    Cesium.Cartesian3.clone(renderedPosition, endpoint);
    head.positions = headPositions;
    backing.positions = headPositions;
    Cesium.Color.clone(tint(0.8), head.material.uniforms.color);
  }
  return {
    replaceHistory,
    setDisplaySample,
    setStyle(next) {
      if (next === style) return;
      style = next;
      Cesium.Color.fromCssColorString(style, styleColor);
      lastSecond = -1;
    },
    setVisible(next) {
      visible = next;
      heads.show = next;
      if (body) body.show = next;
    },
    destroy() {
      if (body) scene.primitives.remove(body);
      scene.primitives.remove(heads);
      body = null;
      segments = [];
    },
    diagnostics() {
      return {
        revision,
        rebuilds,
        segments: segments.length,
        body,
        head,
        backing,
        entitiesAdded: 0,
      };
    },
  };
}
