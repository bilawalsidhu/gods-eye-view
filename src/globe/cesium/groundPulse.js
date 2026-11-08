// A ground pulse field: one unpickable ellipse with uniform-only pulse updates.
import * as Cesium from 'cesium';

/** The pulse disc's Cesium material type, one cached template per page. */
const MATERIAL_TYPE = 'GevGroundPulseField';

// Ellipse texture coordinates put the centre at (0.5, 0.5) and the rim at
// distance 0.5, so `r` is the fraction of the range. Each pulse is a line
// `lineWidth` CSS pixels wide whose outer `haloWidth` is a dark halo, half
// on each side, as Cesium's polyline outline material draws it, with a band
// behind it that is strongest at the line and fades to nothing `depth`
// inward. Widths come from the screen-space gradient of `r`, as Cesium's
// contour material measures its lines; without derivatives the lines are
// left out and only the band shows.
const SOURCE = `
uniform vec4 color;
uniform vec4 lineColor;
uniform vec4 haloColor;
uniform vec4 radii;
uniform vec4 alphas;
uniform float depth;
uniform float lineWidth;
uniform float haloWidth;
vec4 over(vec4 top, vec4 under) {
  float a = top.a + under.a * (1.0 - top.a);
  if (a <= 0.0) return vec4(0.0);
  return vec4((top.rgb * top.a + under.rgb * under.a * (1.0 - top.a)) / a, a);
}
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  float r = length(materialInput.st - vec2(0.5)) * 2.0;
  float band = 0.0;
  for (int i = 0; i < 4; i++) {
    float inside = radii[i] - r;
    if (inside >= 0.0 && inside <= depth) {
      float t = 1.0 - inside / depth;
      band += alphas[i] * t * t;
    }
  }
  vec4 result = vec4(color.rgb, clamp(band * color.a, 0.0, 1.0));
#if (__VERSION__ == 300 || defined(GL_OES_standard_derivatives))
  // Change in r per CSS pixel: the gradient's length per device pixel,
  // times the device pixels in one CSS pixel.
  float cssPx = max(length(vec2(dFdx(r), dFdy(r))), 1e-7) * czm_pixelRatio;
  float outerHalf = lineWidth * 0.5;
  float coreHalf = max(lineWidth - haloWidth, 0.0) * 0.5;
  for (int i = 0; i < 4; i++) {
    float d = abs(radii[i] - r) / cssPx;
    float cover = clamp(outerHalf + 0.5 - d, 0.0, 1.0);
    if (cover <= 0.0) continue;
    float core = clamp(coreHalf + 0.5 - d, 0.0, 1.0);
    vec4 pulse = mix(haloColor, lineColor, core);
    result = over(vec4(pulse.rgb, pulse.a * cover * alphas[i]), result);
  }
#endif
  material.diffuse = result.rgb;
  material.alpha = result.a;
  return material;
}
`;

const toColor = ([red, green, blue, alpha]) =>
  new Cesium.Color(red, green, blue, alpha);

/**
 * The rotation about the Earth's centre that carries `from` onto `to`, as a
 * model matrix, so a disc built around `from` sits around `to`.
 * @param {Cesium.Cartesian3} from Where the disc was built.
 * @param {Cesium.Cartesian3} to Where it should be.
 * @param {Cesium.Matrix4} [result]
 * @returns {Cesium.Matrix4}
 */
function discFollowMatrix(from, to, result = new Cesium.Matrix4()) {
  const a = Cesium.Cartesian3.normalize(from, new Cesium.Cartesian3());
  const b = Cesium.Cartesian3.normalize(to, new Cesium.Cartesian3());
  const axis = Cesium.Cartesian3.cross(a, b, new Cesium.Cartesian3());
  const sin = Cesium.Cartesian3.magnitude(axis);
  if (sin < 1e-12) return Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY, result);
  const angle = Math.atan2(sin, Cesium.Cartesian3.dot(a, b));
  const rotation = Cesium.Matrix3.fromQuaternion(
    Cesium.Quaternion.fromAxisAngle(
      Cesium.Cartesian3.divideByScalar(axis, sin, axis),
      angle,
    ),
  );
  return Cesium.Matrix4.fromRotationTranslation(
    rotation,
    Cesium.Cartesian3.ZERO,
    result,
  );
}

function createDisc(center, radiusM, heightM, material) {
  return new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: new Cesium.EllipseGeometry({
        center,
        semiMajorAxis: radiusM,
        semiMinorAxis: radiusM,
        height: heightM,
        granularity: Cesium.Math.toRadians(0.25),
        vertexFormat:
          Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
      }),
    }),
    appearance: new Cesium.MaterialAppearance({
      material,
      flat: true,
      translucent: true,
      faceForward: true,
    }),
    asynchronous: false,
    allowPicking: false,
  });
}

/**
 * The pulse disc on a Cesium viewer, or null when its scene has no
 * primitive collection: `draw({ radii, alphas, level })`, `move(center)`,
 * `destroy()`. Colours are rgba arrays in 0..1.
 */
export function createCesiumPulseField(
  viewer,
  {
    center,
    radiusM,
    heightM,
    color,
    lineColor,
    haloColor,
    depth,
    lineWidth,
    haloWidth,
  },
) {
  const primitives = viewer?.scene?.primitives;
  if (!primitives?.add) return null;
  const uniforms = {
    color: toColor(color),
    lineColor: toColor(lineColor),
    haloColor: toColor(haloColor),
    radii: new Cesium.Cartesian4(),
    alphas: new Cesium.Cartesian4(),
    depth,
    lineWidth,
    haloWidth,
  };
  // A named type: Cesium caches every material type for the page's
  // lifetime, so an unnamed fabric (a fresh GUID each time) would leave one
  // entry per new visual. Built from the cached template, the uniforms come
  // back as plain copies; restore this disc's own.
  const material = new Cesium.Material({
    fabric: { type: MATERIAL_TYPE, uniforms, source: SOURCE },
    translucent: true,
  });
  Object.assign(material.uniforms, uniforms);
  const built = Cesium.Cartesian3.clone(center);
  let disc = primitives.add(createDisc(built, radiusM, heightM, material));
  let destroyed = false;
  return {
    draw({ radii, alphas, level }) {
      if (destroyed) return;
      disc.show = level > 0;
      Cesium.Cartesian4.fromArray(radii, 0, material.uniforms.radii);
      Cesium.Cartesian4.fromArray(alphas, 0, material.uniforms.alphas);
    },
    /**
     * Centres the disc on `next`: within 20 km of where it was
     * built by its model matrix (the ellipsoid curves a little differently
     * from that sphere, tens of metres in height at 20 km), further away by
     * a rebuild, which costs a few milliseconds.
     */
    move(next) {
      if (destroyed) return;
      if (Cesium.Cartesian3.distance(built, next) < 20000) {
        disc.modelMatrix = discFollowMatrix(built, next, disc.modelMatrix);
        return;
      }
      const previous = disc;
      Cesium.Cartesian3.clone(next, built);
      disc = primitives.add(createDisc(built, radiusM, heightM, material));
      disc.show = previous.show;
      // Primitive.destroy leaves the material alone, so the new disc keeps
      // sharing it.
      primitives.remove(previous);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      primitives.remove(disc);
    },
  };
}
