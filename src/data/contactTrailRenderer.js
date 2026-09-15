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
  const ground =
    !!scene.frameState?.context &&
    Cesium.GroundPolylinePrimitive.isSupported(scene);
  const collection = ground ? scene.groundPrimitives : scene.primitives;
  // One 25 m corridor is clipped in material coordinates. Only subdivision
  // crossings build geometry; frame updates write a scalar, never vertex buffers.
  const headMaterial = (alpha) =>
    new Cesium.Material({
      fabric: {
        type: 'TransitTrailHead',
        uniforms: {
          color: new Cesium.Color(0.37, 0.94, 0.54, alpha),
          fraction: 0,
          backing: true,
        },
        source: `czm_material czm_getMaterial(czm_materialInput materialInput) {
        if (materialInput.st.s > fraction) discard;
        czm_material m = czm_getDefaultMaterial(materialInput);
        bool edge = abs(materialInput.st.t - 0.5) > 0.3;
        m.diffuse = czm_gammaCorrect(vec4(edge && backing ? vec3(0.02, 0.03, 0.05) : color.rgb, 1.0)).rgb;
        m.alpha = color.a;
        return m;
      }`,
      },
      translucent: true,
    });
  const material = headMaterial(0.8),
    depthMaterial = headMaterial(0.55);
  depthMaterial.uniforms.backing = false;
  const head = { positions: [], show: false, width: 3, material };
  const backing = { positions: [], show: false, width: 5 };
  let headPrimitive = null,
    headRebuilds = 0;
  const classificationType = Cesium.ClassificationType.CESIUM_3D_TILE;
  function geometry(positions, width, material = false) {
    return ground
      ? new Cesium.GroundPolylineGeometry({ positions, width, granularity: 0 })
      : new Cesium.PolylineGeometry({
          positions,
          width,
          arcType: Cesium.ArcType.NONE,
          vertexFormat: material
            ? Cesium.PolylineMaterialAppearance.VERTEX_FORMAT
            : Cesium.PolylineColorAppearance.VERTEX_FORMAT,
        });
  }
  function primitive(instances, appearance, depthFailAppearance) {
    return ground
      ? new Cesium.GroundPolylinePrimitive({
          geometryInstances: instances,
          appearance,
          classificationType:
            scene.globe?.show === false
              ? classificationType
              : Cesium.ClassificationType.BOTH,
          allowPicking: false,
          asynchronous: true,
          show: visible,
        })
      : new Cesium.Primitive({
          geometryInstances: instances,
          appearance,
          depthFailAppearance,
          allowPicking: false,
          asynchronous: false,
          show: visible,
        });
  }
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
    if (headPrimitive) collection.remove(headPrimitive);
    headPrimitive = null;
    head.show = backing.show = false;
    if (body) collection.remove(body);
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
            geometry: geometry(segment.positions, lane ? 3 : 5),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                tint(0.8, !lane),
              ),
              depthFailColor: Cesium.ColorGeometryInstanceAttribute.fromColor(
                tint(0.55),
              ),
              show: new Cesium.ShowGeometryInstanceAttribute(false),
            },
          }),
        );
      }
    }
    if (instances.length) {
      body = collection.add(
        primitive(
          instances,
          new Cesium.PolylineColorAppearance({ translucent: true }),
          new Cesium.PolylineColorAppearance({ translucent: true }),
        ),
      );
      rebuilds++;
    }
  }
  function setDisplaySample(sample, renderedPosition) {
    if (!sample || !renderedPosition) {
      head.show = false;
      backing.show = false;
      if (headPrimitive) headPrimitive.show = false;
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
          if (!ground) {
            Cesium.ColorGeometryInstanceAttribute.toValue(
              tint(0.55),
              attributes.depthFailColor,
            );
            attributes.depthFailColor = attributes.depthFailColor;
          }
        }
      }
      lastSecond = second;
    }
    const show = visible && !!segment && sample.fraction < 1;
    head.show = show;
    backing.show = show;
    if (headPrimitive) headPrimitive.show = show;
    if (!show) return;
    if (active !== segment) {
      active = segment;
      if (headPrimitive) collection.remove(headPrimitive);
      headPrimitive = collection.add(
        primitive(
          new Cesium.GeometryInstance({
            geometry: geometry(segment.positions, 5, true),
          }),
          new Cesium.PolylineMaterialAppearance({
            material,
            translucent: true,
          }),
          new Cesium.PolylineMaterialAppearance({
            material: depthMaterial,
            translucent: true,
          }),
        ),
      );
      headRebuilds++;
      headPositions[0] = segment.positions[0];
      headPositions[1] = endpoint;
    }
    Cesium.Cartesian3.clone(renderedPosition, endpoint);
    head.positions = headPositions;
    backing.positions = headPositions;
    material.uniforms.fraction = Math.max(
      0,
      Math.min(
        1,
        (sample.displayT - segment.fromT) / (segment.toT - segment.fromT),
      ),
    );
    depthMaterial.uniforms.fraction = material.uniforms.fraction;
    Cesium.Color.clone(tint(0.8), material.uniforms.color);
    Cesium.Color.clone(tint(0.55), depthMaterial.uniforms.color);
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
      if (headPrimitive) headPrimitive.show = next && head.show;
      if (body) body.show = next;
    },
    destroy() {
      if (body) collection.remove(body);
      if (headPrimitive) collection.remove(headPrimitive);
      headPrimitive = null;
      material.destroy();
      depthMaterial.destroy();
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
        headPrimitive,
        headStrategy: ground
          ? 'draped corridor with material clip'
          : 'depth-fail corridor with material clip',
        ground,
        headRebuilds,
        entitiesAdded: 0,
      };
    },
  };
}
