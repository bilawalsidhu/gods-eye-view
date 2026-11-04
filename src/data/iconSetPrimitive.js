/**
 * @module iconSetPrimitive
 * @description Draws an {@link module:iconSet} in a Cesium scene: one instanced quad per
 * row, moved along its segment on the GPU at the set's render time. This replaces a
 * BillboardCollection for large moving fleets, so the CPU writes rows only when their
 * motion or style changes and uploads just the rows it wrote.
 *
 * It reproduces the billboard behaviour the aircraft layers used: pixel size by
 * `width × scale × NearFarScalar(distance)`, screen rotation along the course
 * (`alignedAxis` zero), depth test disabled at any distance (drawn on the near plane),
 * opaque and translucent passes, horizon culling, and per-row picks whose object is
 * `{ id, meta, primitive }` (`primitive.show` hides that one row, as drillPick expects).
 * Rows flagged to recede also take the aircraft limb recession, composed with focus.
 *
 * This module is the one place the icon sets touch Cesium's renderer internals.
 */
import * as Cesium from 'cesium';
import { ICON_SEGMENT_GLSL, SEGMENT_STRIDE } from './iconSegment.js';
import { ICON_CULL_HEIGHT_M, ICON_CULL_LIFT, STYLE_STRIDE } from './iconSet.js';
import { iconAtlas, MAX_ICON_SLOTS } from './iconAtlas.js';
import {
  cameraLimbDistanceM,
  getAircraftRecessionParams,
} from './aircraftRecession.js';

/** On-screen device pixels above which a row draws its near (large) image. */
const NEAR_IMAGE_PX = 76;

const ATTRIBUTE_LOCATIONS = Object.freeze({
  corner: 0,
  seg0: 1,
  seg1: 2,
  seg2: 3,
  seg3: 4,
  seg4: 5,
  seg5: 6,
  style0: 7,
  style1: 8,
  style2: 9,
  color: 10,
  pickColor: 11,
});

const VERTEX_SHADER = /* glsl */ `
in vec2 corner;
in vec4 seg0;
in vec4 seg1;
in vec4 seg2;
in vec4 seg3;
in vec4 seg4;
in vec4 seg5;
in vec4 style0; // width, height, scale, alpha
in vec4 style1; // far image, near image, flags, focus
in vec4 style2; // scale by distance (near, near value, far, far value)
in vec4 color;
in vec4 pickColor;

uniform float u_tau;
uniform vec3 u_cameraPosition;
uniform vec4 u_horizon; // camera in ellipsoid-scaled space, squared scaled limb distance
uniform vec3 u_cameraRight;
uniform vec3 u_cameraUp;
uniform vec4 u_recession; // limb distance, start ratio, strength, enabled
uniform vec3 u_recessionFloors; // scale, alpha, combined alpha
uniform vec4 u_slots[${MAX_ICON_SLOTS}];

out vec2 v_uv;
out vec4 v_color;
out vec4 v_pickColor;

// The row's anchor in clip space before screen offsets, for effects that wrap
// main() (cyber sonar) and must not change geometry or picks.
vec4 iconAnchorClip = vec4(0.0, 0.0, 0.0, -1.0);

${ICON_SEGMENT_GLSL}

bool iconFlag(float flags, float bit) {
  return mod(floor(flags / bit), 2.0) == 1.0;
}

// Raise a near-ground point to at least the cull height (iconSet.cullPoint).
vec3 iconCullPoint(vec3 world) {
  float radius = length(world);
  float height = radius * (1.0 - 1.0 / length(world * czm_ellipsoidInverseRadii));
  return world + world / radius * max(0.0, ${ICON_CULL_HEIGHT_M.toFixed(1)} - height);
}

bool occludedByEllipsoid(vec3 world) {
  vec3 cv = u_horizon.xyz;
  float vh2 = u_horizon.w;
  vec3 vt = world * czm_ellipsoidInverseRadii - cv;
  float vtDotVc = -dot(vt, cv);
  return vh2 < 0.0
    ? vtDotVc > 0.0
    : vtDotVc > vh2 && vtDotVc * vtDotVc / dot(vt, vt) > vh2;
}

void main() {
  v_pickColor = pickColor;
  v_uv = vec2(0.0);
  v_color = vec4(0.0);
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // outside the clip volume: not drawn

  float flags = style1.z;
  if (!iconFlag(flags, 1.0)) return;

  vec3 rte = iconSegmentPosition(seg0, seg1, seg2, seg3, seg4, u_tau);
  vec3 world = u_cameraPosition + rte;
  vec3 cullPoint = iconFlag(flags, ${ICON_CULL_LIFT.toFixed(1)}) ? iconCullPoint(world) : world;
  if (occludedByEllipsoid(cullPoint)) return;

  vec4 positionEC = czm_modelViewRelativeToEye * vec4(rte, 1.0);
  if (positionEC.z >= 0.0) return; // behind the camera
  iconAnchorClip = czm_projection * positionEC;

  float distanceSq = dot(positionEC.xyz, positionEC.xyz);
  float distanceScale = style2.z > 0.0 ? czm_nearFarScalar(style2, distanceSq) : 1.0;
  float scale = style0.z;
  float alpha = style0.w;
  float focus = clamp(style1.w, 0.0, 1.0);
  if (iconFlag(flags, 4.0) && u_recession.w > 0.0) {
    float ratio = sqrt(distanceSq) / u_recession.x;
    float t = clamp((ratio - u_recession.y) / (1.0 - u_recession.y), 0.0, 1.0);
    float ease = t * t * (3.0 - 2.0 * t) * u_recession.z;
    scale *= 1.0 + (u_recessionFloors.x - 1.0) * ease;
    alpha *= max(u_recessionFloors.z, focus * (1.0 + (u_recessionFloors.y - 1.0) * ease));
  } else if (iconFlag(flags, 4.0)) {
    alpha *= max(u_recessionFloors.z, focus); // recession off: the floor still holds
  } else {
    alpha *= focus;
  }

  float glyphPx = style0.x * scale * distanceScale * czm_pixelRatio;
  float slot = glyphPx > ${NEAR_IMAGE_PX.toFixed(1)} ? style1.y : style1.x;
  if (slot < 0.0) return; // no image set
  vec4 rect = u_slots[int(slot)];
  if (rect.z <= 0.0) return; // image not loaded yet

  vec2 halfSize = style0.xy * (scale * distanceScale * 0.5) * corner;
  if (iconFlag(flags, 2.0)) {
    float course = radians(iconSegmentCourse(seg3, seg4, seg5, u_tau));
    vec3 up = czm_geodeticSurfaceNormal(world, vec3(0.0), czm_ellipsoidInverseRadii * czm_ellipsoidInverseRadii);
    // East as Cesium's ENU frame builds it; at the poles it uses +y.
    vec2 horizontal = vec2(-world.y, world.x);
    vec3 east = dot(horizontal, horizontal) > 1.0 ? normalize(vec3(horizontal, 0.0)) : vec3(0.0, 1.0, 0.0);
    vec3 north = cross(up, east);
    vec3 forward = east * sin(course) + north * cos(course);
    float dx = dot(forward, u_cameraRight);
    float dy = -dot(forward, u_cameraUp);
    // Heading into or out of the screen: no stable direction, stay upright
    // (screenProjectedRotation's 0.5 m of a 2 km probe).
    if (dx * dx + dy * dy >= 6.25e-8) {
      float rotation = atan(-dx, -dy);
      float c = cos(rotation);
      float s = sin(rotation);
      halfSize = mat2(c, s, -s, c) * halfSize;
    }
  }
  positionEC.xy += halfSize * czm_metersPerPixel(positionEC);
  gl_Position = czm_projection * positionEC;

#ifdef LOG_DEPTH
  czm_vertexLogDepth();
#endif
  // Depth test disabled at any distance: draw on the near plane, as a billboard
  // with disableDepthTestDistance = Infinity.
  float zclip = gl_Position.z / gl_Position.w;
  if (zclip >= -1.0 && zclip <= 1.0) {
    gl_Position.z = -gl_Position.w;
#ifdef LOG_DEPTH
    v_depthFromNearPlusOne = 1.0;
#endif
  }

  v_uv = mix(rect.xy, rect.zw, vec2(corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5));
  v_color = vec4(color.rgb, color.a * alpha);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D u_atlas;

in vec2 v_uv;
in vec4 v_color;
in vec4 v_pickColor;

void main() {
  vec4 color = czm_gammaCorrect(texture(u_atlas, v_uv));
  color *= czm_gammaCorrect(v_color);
  if (color.a < 0.005) discard;
#ifdef OPAQUE
  if (color.a < 0.995) discard;
#else
  if (color.a >= 0.995) discard;
#endif
  out_FragColor = color;
#ifdef LOG_DEPTH
  czm_writeLogDepth(v_depthFromNearPlusOne);
#endif
}
`;

const SEGMENT_BYTES = SEGMENT_STRIDE * 4;
const STYLE_BYTES = STYLE_STRIDE * 4;
const EARTH_BOUNDS = new Cesium.BoundingSphere(
  Cesium.Cartesian3.ZERO,
  6_500_000,
);

/**
 * @param {{ set: object, renderTime: () => Cesium.JulianDate }} options `renderTime`
 *   gives the instant to draw at (the layer's delayed clock).
 */
export class IconSetPrimitive {
  constructor({ set, renderTime }) {
    this.set = set;
    this.renderTime = renderTime;
    this.show = true;
    this._tau = 0;
    this._generation = -1;
    this._buffers = null;
    this._vertexArray = null;
    this._pickColors = null;
    this._programs = null;
    this._commands = null;
    this._texture = null;
    this._atlasVersion = -1;
    this._slots = Array.from(
      { length: MAX_ICON_SLOTS },
      () => new Cesium.Cartesian4(),
    );
    this._horizon = new Cesium.Cartesian4();
    this._cameraPosition = new Cesium.Cartesian3();
    this._cameraRight = new Cesium.Cartesian3();
    this._cameraUp = new Cesium.Cartesian3();
    this._recession = new Cesium.Cartesian4();
    this._recessionFloors = new Cesium.Cartesian3();
    this._destroyed = false;
    set.onRelease = (handle) => handle.pickId.destroy();
    const primitive = this;
    this._uniforms = {
      u_tau: () => primitive._tau,
      u_cameraPosition: () => primitive._cameraPosition,
      u_horizon: () => primitive._horizon,
      u_cameraRight: () => primitive._cameraRight,
      u_cameraUp: () => primitive._cameraUp,
      u_recession: () => primitive._recession,
      u_recessionFloors: () => primitive._recessionFloors,
      u_slots: () => primitive._slots,
      u_atlas: () => primitive._texture,
    };
  }

  update(frameState) {
    const set = this.set;
    if (
      !this.show ||
      !set.show ||
      (!frameState.passes.render && !frameState.passes.pick)
    )
      return;
    const context = frameState.context;
    this._syncAtlas(context);
    if (!this._texture) return;
    const renderTime = this.renderTime();
    set.rebase(renderTime);
    if (this._generation !== set.generation) this._allocate(context);
    this._upload(context);
    if (set.count === 0) return;

    this._tau = set.seconds(renderTime);
    this._syncCamera(frameState);
    if (!this._programs) this._createCommands(context);
    for (const command of this._commands) {
      command.instanceCount = set.count;
      frameState.commandList.push(command);
    }
  }

  _syncAtlas(context) {
    if (iconAtlas.version === this._atlasVersion || !iconAtlas.canvas) return;
    this._atlasVersion = iconAtlas.version;
    this._texture?.destroy();
    this._texture = new Cesium.Texture({
      context,
      source: iconAtlas.canvas,
      flipY: false,
      sampler: new Cesium.Sampler({
        wrapS: Cesium.TextureWrap.CLAMP_TO_EDGE,
        wrapT: Cesium.TextureWrap.CLAMP_TO_EDGE,
        minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
        magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
      }),
    });
    for (let slot = 0; slot < MAX_ICON_SLOTS; slot++)
      Cesium.Cartesian4.unpack(iconAtlas.rects, slot * 4, this._slots[slot]);
  }

  _allocate(context) {
    const set = this.set;
    this._destroyBuffers();
    const capacity = set.capacity;
    const usage = Cesium.BufferUsage.DYNAMIC_DRAW;
    const buffers = {
      corner: Cesium.Buffer.createVertexBuffer({
        context,
        typedArray: new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]),
        usage: Cesium.BufferUsage.STATIC_DRAW,
      }),
      index: Cesium.Buffer.createIndexBuffer({
        context,
        typedArray: new Uint16Array([0, 1, 2, 0, 2, 3]),
        usage: Cesium.BufferUsage.STATIC_DRAW,
        indexDatatype: Cesium.IndexDatatype.UNSIGNED_SHORT,
      }),
      segments: Cesium.Buffer.createVertexBuffer({
        context,
        sizeInBytes: capacity * SEGMENT_BYTES,
        usage,
      }),
      style: Cesium.Buffer.createVertexBuffer({
        context,
        sizeInBytes: capacity * STYLE_BYTES,
        usage,
      }),
      colors: Cesium.Buffer.createVertexBuffer({
        context,
        sizeInBytes: capacity * 4,
        usage,
      }),
      picks: Cesium.Buffer.createVertexBuffer({
        context,
        sizeInBytes: capacity * 4,
        usage,
      }),
    };
    const float = Cesium.ComponentDatatype.FLOAT;
    const byte = Cesium.ComponentDatatype.UNSIGNED_BYTE;
    const attributes = [
      {
        index: ATTRIBUTE_LOCATIONS.corner,
        vertexBuffer: buffers.corner,
        componentsPerAttribute: 2,
        componentDatatype: float,
      },
    ];
    for (let i = 0; i < 6; i++)
      attributes.push({
        index: ATTRIBUTE_LOCATIONS[`seg${i}`],
        vertexBuffer: buffers.segments,
        componentsPerAttribute: 4,
        componentDatatype: float,
        offsetInBytes: i * 16,
        strideInBytes: SEGMENT_BYTES,
        instanceDivisor: 1,
      });
    for (let i = 0; i < 3; i++)
      attributes.push({
        index: ATTRIBUTE_LOCATIONS[`style${i}`],
        vertexBuffer: buffers.style,
        componentsPerAttribute: 4,
        componentDatatype: float,
        offsetInBytes: i * 16,
        strideInBytes: STYLE_BYTES,
        instanceDivisor: 1,
      });
    for (const [name, buffer] of [
      ['color', buffers.colors],
      ['pickColor', buffers.picks],
    ])
      attributes.push({
        index: ATTRIBUTE_LOCATIONS[name],
        vertexBuffer: buffer,
        componentsPerAttribute: 4,
        componentDatatype: byte,
        normalize: true,
        instanceDivisor: 1,
      });
    this._buffers = buffers;
    this._vertexArray = new Cesium.VertexArray({
      context,
      attributes,
      indexBuffer: buffers.index,
    });
    this._pickColors = new Uint8Array(capacity * 4);
    this._generation = set.generation;
    for (const rows of Object.values(set.dirty)) rows.markAll();
    if (this._commands)
      for (const command of this._commands)
        command.vertexArray = this._vertexArray;
  }

  _upload(context) {
    const set = this.set;
    const { segments, style, colors } = set.dirty;
    const count = set.count;
    for (const [from, to] of segments.runs(count))
      this._buffers.segments.copyFromArrayView(
        set.segments.subarray(from * SEGMENT_STRIDE, (to + 1) * SEGMENT_STRIDE),
        from * SEGMENT_BYTES,
      );
    for (const [from, to] of style.runs(count)) {
      this._buffers.style.copyFromArrayView(
        set.style.subarray(from * STYLE_STRIDE, (to + 1) * STYLE_STRIDE),
        from * STYLE_BYTES,
      );
      // Rows that are new or moved by a removal: (re)write their pick colours.
      for (let row = from; row <= to; row++) this._writePick(context, row);
      this._buffers.picks.copyFromArrayView(
        this._pickColors.subarray(from * 4, (to + 1) * 4),
        from * 4,
      );
    }
    for (const [from, to] of colors.runs(count))
      this._buffers.colors.copyFromArrayView(
        set.colors.subarray(from * 4, (to + 1) * 4),
        from * 4,
      );
    segments.clear();
    style.clear();
    colors.clear();
  }

  _writePick(context, row) {
    const set = this.set;
    let handle = set.handleAt(row);
    if (!handle) {
      const id = set.idAt(row);
      const facade = {
        id,
        get show() {
          const at = set.row(id);
          return at >= 0 && set.shown(at);
        },
        set show(value) {
          const at = set.row(id);
          if (at >= 0) set.setShown(at, value);
        },
      };
      handle = {
        pickId: context.createPickId({
          id,
          get meta() {
            const at = set.row(id);
            return at >= 0 ? set.metaAt(at) : undefined;
          },
          primitive: facade,
        }),
      };
      set.setHandle(row, handle);
    }
    const color = handle.pickId.color;
    const o = row * 4;
    this._pickColors[o] = Cesium.Color.floatToByte(color.red);
    this._pickColors[o + 1] = Cesium.Color.floatToByte(color.green);
    this._pickColors[o + 2] = Cesium.Color.floatToByte(color.blue);
    this._pickColors[o + 3] = Cesium.Color.floatToByte(color.alpha);
  }

  _syncCamera(frameState) {
    const camera = frameState.camera;
    const radii = Cesium.Ellipsoid.WGS84.oneOverRadii;
    const position = camera.positionWC;
    Cesium.Cartesian3.clone(position, this._cameraPosition);
    Cesium.Cartesian3.clone(camera.rightWC, this._cameraRight);
    Cesium.Cartesian3.clone(camera.upWC, this._cameraUp);
    const cx = position.x * radii.x;
    const cy = position.y * radii.y;
    const cz = position.z * radii.z;
    Cesium.Cartesian4.fromElements(
      cx,
      cy,
      cz,
      cx * cx + cy * cy + cz * cz - 1,
      this._horizon,
    );

    const tuning = getAircraftRecessionParams();
    const height = camera.positionCartographic?.height;
    const limb = cameraLimbDistanceM(height, tuning.earthRadiusM);
    const active =
      Number.isFinite(height) &&
      height > 0 &&
      height < tuning.globeViewBlendEndM &&
      limb > 0;
    let strength = 0;
    if (active) {
      const g = Math.min(
        1,
        Math.max(
          0,
          (height - tuning.globeViewBlendStartM) /
            (tuning.globeViewBlendEndM - tuning.globeViewBlendStartM),
        ),
      );
      strength = 1 - g * g * (3 - 2 * g);
    }
    Cesium.Cartesian4.fromElements(
      active ? limb : 1,
      tuning.startLimbRatio,
      strength,
      active ? 1 : 0,
      this._recession,
    );
    Cesium.Cartesian3.fromElements(
      tuning.scaleFloor,
      tuning.alphaFloor,
      tuning.combinedAlphaFloor,
      this._recessionFloors,
    );
  }

  _createCommands(context) {
    const programFor = (pass) =>
      Cesium.ShaderProgram.fromCache({
        context,
        vertexShaderSource: new Cesium.ShaderSource({
          sources: [VERTEX_SHADER],
        }),
        fragmentShaderSource: new Cesium.ShaderSource({
          defines: pass === 'opaque' ? ['OPAQUE'] : ['TRANSLUCENT'],
          sources: [FRAGMENT_SHADER],
        }),
        attributeLocations: ATTRIBUTE_LOCATIONS,
      });
    this._programs = {
      opaque: programFor('opaque'),
      translucent: programFor('translucent'),
    };
    const depthTest = { enabled: true, func: Cesium.DepthFunction.LESS };
    const command = (pass, program, renderState) =>
      new Cesium.DrawCommand({
        owner: this,
        pass,
        primitiveType: Cesium.PrimitiveType.TRIANGLES,
        vertexArray: this._vertexArray,
        count: 6,
        instanceCount: 0,
        shaderProgram: program,
        uniformMap: this._uniforms,
        renderState,
        boundingVolume: EARTH_BOUNDS,
        pickId: 'v_pickColor',
      });
    this._commands = [
      command(
        Cesium.Pass.OPAQUE,
        this._programs.opaque,
        Cesium.RenderState.fromCache({ depthTest, depthMask: true }),
      ),
      command(
        Cesium.Pass.TRANSLUCENT,
        this._programs.translucent,
        Cesium.RenderState.fromCache({
          depthTest,
          depthMask: false,
          blending: Cesium.BlendingState.ALPHA_BLEND,
        }),
      ),
    ];
  }

  _destroyBuffers() {
    this._vertexArray?.destroy(); // destroys its buffers too
    this._vertexArray = null;
    this._buffers = null;
  }

  isDestroyed() {
    return this._destroyed;
  }

  destroy() {
    this._destroyBuffers();
    this._programs?.opaque.destroy();
    this._programs?.translucent.destroy();
    this._texture?.destroy();
    // The set outlives its renderer: release only the pick ids this one made.
    const set = this.set;
    for (let row = 0; row < set.count; row++) {
      set.handleAt(row)?.pickId.destroy();
      set.setHandle(row, undefined);
    }
    set.onRelease = null;
    for (const rows of Object.values(set.dirty)) rows.markAll();
    this._destroyed = true;
    return Cesium.destroyObject(this);
  }
}
