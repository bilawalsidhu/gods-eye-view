import * as Cesium from 'cesium';
import { loadBundledJson } from '../data/bundledJson.js';
import { governorRequestRender } from '../renderGovernor.js';
import { buildStarVertices, STAR_VERTEX_FLOATS } from './stars.js';

/**
 * Space background in the `Scene#skyBox` slot: catalogue stars as point
 * sprites over a soft Milky Way cube map, both turned by one ICRF→fixed
 * rotation at the scene clock (TEME until Cesium's tables load). Scene runs
 * the command from `update()` first in the environment pass, so the sky
 * stays behind everything without depth. Revalidate on engine upgrades.
 */
export const STARRY_SKY_CESIUM_VERSION = '1.138.0';

/** Brightness of the Milky Way glow; the stars carry the sky. */
export const MILKY_WAY_INTENSITY = 0.4;
/** Clock change, in seconds, below which the sky rotation is reused. */
export const SKY_ROTATION_EPSILON_SECONDS = 1;

const STAR_PACK_URL = new URL(
  '../data/local_data/sky/bright_stars.json',
  import.meta.url,
);
const MILKY_WAY_FACE_URLS = Object.freeze({
  positiveX: new URL(
    '../data/local_data/sky/milkyway_px.webp',
    import.meta.url,
  ),
  negativeX: new URL(
    '../data/local_data/sky/milkyway_nx.webp',
    import.meta.url,
  ),
  positiveY: new URL(
    '../data/local_data/sky/milkyway_py.webp',
    import.meta.url,
  ),
  negativeY: new URL(
    '../data/local_data/sky/milkyway_ny.webp',
    import.meta.url,
  ),
  positiveZ: new URL(
    '../data/local_data/sky/milkyway_pz.webp',
    import.meta.url,
  ),
  negativeZ: new URL(
    '../data/local_data/sky/milkyway_nz.webp',
    import.meta.url,
  ),
});

// Directions, not points: w = 0 drops the camera translation, and z just
// under w keeps every fragment at the far plane, inside any frustum.
const SKY_DIRECTION_GLSL = `
uniform mat3 u_icrfToFixed;
vec4 skyClipPosition(vec3 icrfDirection)
{
    vec3 eye = czm_viewRotation * (u_icrfToFixed * icrfDirection);
    vec4 clip = czm_projection * vec4(eye, 0.0);
    clip.z = clip.w * 0.99999;
    return clip;
}
`;

const MILKY_WAY_VS = `${SKY_DIRECTION_GLSL}
in vec3 position;
out vec3 v_direction;
void main()
{
    gl_Position = skyClipPosition(position);
    v_direction = position;
}
`;

const MILKY_WAY_FS = `
uniform samplerCube u_milkyWay;
uniform float u_intensity;
in vec3 v_direction;
void main()
{
    vec3 color = czm_textureCube(u_milkyWay, normalize(v_direction)).rgb * u_intensity;
    // Interleaved-gradient dither: the dim glow spans only a few 8-bit steps.
    float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    color = max(color + (noise - 0.5) / 255.0, 0.0);
    out_FragColor = vec4(czm_gammaCorrect(color), 1.0);
}
`;

const STAR_VS = `${SKY_DIRECTION_GLSL}
in vec3 position;
in float sigma;
in vec4 color;
out vec4 v_color;
out float v_sigma;
out float v_radius;
void main()
{
    gl_Position = skyClipPosition(position);
    // σ is in CSS pixels; the sprite holds ±3σ plus a pixel of margin.
    v_sigma = sigma * czm_pixelRatio;
    v_radius = ceil(3.0 * v_sigma) + 1.0;
    gl_PointSize = 2.0 * v_radius;
    v_color = color;
}
`;

const STAR_FS = `
in vec4 v_color;
in float v_sigma;
in float v_radius;
void main()
{
    vec2 offset = (gl_PointCoord - 0.5) * (2.0 * v_radius);
    float alpha = v_color.a *
        exp(-0.5 * dot(offset, offset) / (v_sigma * v_sigma));
    if (alpha < 1.0 / 512.0) discard;
    out_FragColor = vec4(czm_gammaCorrect(v_color.rgb) * alpha, alpha);
}
`;

/** Pick the ICRF→fixed rotation for `time`, or TEME while tables load. */
export function computeSkyRotation(time, result) {
  const { Transforms } = Cesium;
  const icrf = Transforms.computeIcrfToFixedMatrix(time, result);
  if (icrf) return { matrix: icrf, precise: true };
  return {
    matrix: Transforms.computeTemeToPseudoFixedMatrix(time, result),
    precise: false,
  };
}

/** Whether a cached rotation at `cachedTime` still serves `time`. */
export function isSkyRotationCurrent(cachedTime, time) {
  return (
    cachedTime !== undefined &&
    Math.abs(Cesium.JulianDate.secondsDifference(time, cachedTime)) <
      SKY_ROTATION_EPSILON_SECONDS
  );
}

export class StarrySky {
  /**
   * @param {object} [options]
   * @param {() => void} [options.requestRender] renders one frame when an
   *   asset or the precise rotation arrives; the idle governor by default.
   */
  constructor({
    requestRender = () => governorRequestRender('sky-assets'),
  } = {}) {
    /** Matches `SkyBox#show`. */
    this.show = true;
    this.milkyWayIntensity = MILKY_WAY_INTENSITY;
    /** 0..1 multiplier a style sets to hide the glow (see visualEffects.js). */
    this.milkyWayVisibility = 1;
    this._requestRender = requestRender;
    this._rotation = Cesium.Matrix3.clone(Cesium.Matrix3.IDENTITY);
    this._rotationTime = undefined;
    this._rotationPrecise = false;
    this._icrfRequest = undefined;
    this._icrfUnavailable = false;
    this._icrfMissing = undefined;
    this._loading = false;
    this._starData = undefined;
    this._faceImages = undefined;
    // Scene reads `_cubeMap` for model lighting. Keep it dark as on main;
    // Cesium's fallback is white, and the ICRF glow is only a background.
    this._cubeMap = undefined;
    this._milkyWayCubeMap = undefined;
    this._milkyWayCommand = undefined;
    this._milkyWayAttributes = undefined;
    this._starCommand = undefined;
    this._useHdr = undefined;
    this._destroyed = false;
    const uniforms = {
      u_icrfToFixed: () => this._rotation,
    };
    this._milkyWayUniforms = {
      ...uniforms,
      u_milkyWay: () => this._milkyWayCubeMap,
      u_intensity: () => this.milkyWayIntensity * this.milkyWayVisibility,
    };
    this._starUniforms = uniforms;
    const commands = [];
    this._commands = commands;
    // The environment pass reads `derivedCommands` (log depth, HDR, picking)
    // before calling `execute`; none apply to a far-plane background.
    this._compositeCommand = {
      derivedCommands: {},
      execute(context, passState) {
        for (const command of commands) command.execute(context, passState);
      },
    };
  }

  /** Start loading assets; failures leave a plain black sky. */
  _load() {
    if (this._loading) return;
    this._loading = true;
    loadBundledJson(STAR_PACK_URL)
      .then((pack) => {
        if (this._destroyed) return;
        this._starData = buildStarVertices(pack);
        this._requestRender();
      })
      .catch((error) =>
        console.warn('[sky] star catalogue unavailable', error),
      );
    const faces = Object.entries(MILKY_WAY_FACE_URLS);
    Promise.all(
      faces.map(([, url]) => Cesium.Resource.fetchImage({ url: url.href })),
    )
      .then((images) => {
        if (this._destroyed) return;
        this._faceImages = Object.fromEntries(
          faces.map(([face], index) => [face, images[index]]),
        );
        this._requestRender();
      })
      .catch((error) => console.warn('[sky] Milky Way unavailable', error));
  }

  _updateRotation(time) {
    // An approximate rotation is final only while nothing better can come.
    const settled =
      this._rotationPrecise || this._icrfRequest || !this._canPreloadIcrf(time);
    if (settled && isSkyRotationCurrent(this._rotationTime, time)) return;
    const { precise } = computeSkyRotation(time, this._rotation);
    this._rotationPrecise = precise;
    this._rotationTime = Cesium.JulianDate.clone(time, this._rotationTime);
    if (!precise) this._preloadIcrf(time);
  }

  /** Whether loading Cesium's IAU 2006 tables could still help at `time`. */
  _canPreloadIcrf(time) {
    return (
      !this._icrfUnavailable &&
      !(
        this._icrfMissing &&
        Cesium.TimeInterval.contains(this._icrfMissing, time)
      )
    );
  }

  /** Fetch Cesium's IAU 2006 tables around `time` once per span. */
  _preloadIcrf(time) {
    if (this._icrfRequest || !this._canPreloadIcrf(time)) return;
    const interval = new Cesium.TimeInterval({
      start: Cesium.JulianDate.addDays(time, -1, new Cesium.JulianDate()),
      stop: Cesium.JulianDate.addDays(time, 1, new Cesium.JulianDate()),
    });
    this._icrfRequest = Promise.resolve(
      Cesium.Transforms.preloadIcrfFixed(interval),
    )
      .then(
        () => {
          // The tables cover roughly 1975–2050; outside them the preload
          // resolves with nothing, and TEME stays for this span.
          if (!Cesium.Transforms.computeIcrfToFixedMatrix(time)) {
            this._icrfMissing = interval;
            return;
          }
          this._rotationTime = undefined;
          if (!this._destroyed) this._requestRender();
        },
        (error) => {
          // TEME is within a fraction of a degree; do not retry every frame.
          this._icrfUnavailable = true;
          console.warn('[sky] ICRF tables unavailable, using TEME', error);
        },
      )
      .finally(() => {
        this._icrfRequest = undefined;
      });
  }

  _createMilkyWayCommand(context) {
    const cubeMap = new Cesium.CubeMap({
      context,
      source: this._faceImages,
      flipY: false,
    });
    cubeMap.generateMipmap();
    cubeMap.sampler = new Cesium.Sampler({
      minificationFilter: Cesium.TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
    });
    this._milkyWayCubeMap = cubeMap;
    this._faceImages = undefined;
    const geometry = Cesium.BoxGeometry.createGeometry(
      Cesium.BoxGeometry.fromDimensions({
        dimensions: new Cesium.Cartesian3(2, 2, 2),
        vertexFormat: Cesium.VertexFormat.POSITION_ONLY,
      }),
    );
    const attributeLocations =
      Cesium.GeometryPipeline.createAttributeLocations(geometry);
    this._milkyWayCommand = new Cesium.DrawCommand({
      owner: this,
      vertexArray: Cesium.VertexArray.fromGeometry({
        context,
        geometry,
        attributeLocations,
        bufferUsage: Cesium.BufferUsage.STATIC_DRAW,
      }),
      renderState: Cesium.RenderState.fromCache({}),
      uniformMap: this._milkyWayUniforms,
    });
    this._milkyWayAttributes = attributeLocations;
  }

  _createStarCommand(context) {
    const { count, vertices } = this._starData;
    this._starData = undefined;
    if (count === 0) return;
    const vertexBuffer = Cesium.Buffer.createVertexBuffer({
      context,
      typedArray: vertices,
      usage: Cesium.BufferUsage.STATIC_DRAW,
    });
    const stride = STAR_VERTEX_FLOATS * Float32Array.BYTES_PER_ELEMENT;
    const attribute = (index, components, offsetFloats) => ({
      index,
      vertexBuffer,
      componentsPerAttribute: components,
      componentDatatype: Cesium.ComponentDatatype.FLOAT,
      offsetInBytes: offsetFloats * Float32Array.BYTES_PER_ELEMENT,
      strideInBytes: stride,
    });
    this._starCommand = new Cesium.DrawCommand({
      owner: this,
      primitiveType: Cesium.PrimitiveType.POINTS,
      count,
      vertexArray: new Cesium.VertexArray({
        context,
        attributes: [
          attribute(0, 3, 0),
          attribute(1, 1, 3),
          attribute(2, 4, 4),
        ],
      }),
      // Premultiplied additive: starlight adds to the Milky Way glow and
      // leaves the framebuffer alpha alone.
      renderState: Cesium.RenderState.fromCache({
        blending: {
          enabled: true,
          equationRgb: Cesium.BlendEquation.ADD,
          equationAlpha: Cesium.BlendEquation.ADD,
          functionSourceRgb: Cesium.BlendFunction.ONE,
          functionDestinationRgb: Cesium.BlendFunction.ONE,
          functionSourceAlpha: Cesium.BlendFunction.ZERO,
          functionDestinationAlpha: Cesium.BlendFunction.ONE,
        },
      }),
      uniformMap: this._starUniforms,
    });
  }

  _updateShaders(context, useHdr) {
    if (this._useHdr === useHdr) return;
    this._useHdr = useHdr;
    const defines = useHdr ? ['HDR'] : [];
    for (const [command, vs, fs, attributeLocations] of [
      [
        this._milkyWayCommand,
        MILKY_WAY_VS,
        MILKY_WAY_FS,
        this._milkyWayAttributes,
      ],
      [
        this._starCommand,
        STAR_VS,
        STAR_FS,
        { position: 0, sigma: 1, color: 2 },
      ],
    ]) {
      if (!command) continue;
      command.shaderProgram?.destroy();
      command.shaderProgram = Cesium.ShaderProgram.fromCache({
        context,
        vertexShaderSource: vs,
        fragmentShaderSource: new Cesium.ShaderSource({
          defines,
          sources: [fs],
        }),
        attributeLocations,
      });
    }
  }

  /** `Scene#skyBox` contract: the command to draw this frame, if any. */
  update(frameState, useHdr) {
    if (!this.show) return undefined;
    const { mode, passes, context } = frameState;
    if (mode !== Cesium.SceneMode.SCENE3D) return undefined;
    if (!passes.render) return undefined;
    if (!this._cubeMap) {
      const face = {
        width: 1,
        height: 1,
        arrayBufferView: new Uint8Array([0, 0, 0, 255]),
      };
      this._cubeMap = new Cesium.CubeMap({
        context,
        source: {
          positiveX: face,
          negativeX: face,
          positiveY: face,
          negativeY: face,
          positiveZ: face,
          negativeZ: face,
        },
        flipY: false,
      });
    }
    this._load();
    let rebuilt = false;
    if (this._faceImages && !this._milkyWayCommand) {
      this._createMilkyWayCommand(context);
      rebuilt = true;
    }
    if (this._starData && !this._starCommand) {
      this._createStarCommand(context);
      rebuilt = true;
    }
    if (rebuilt) this._useHdr = undefined;
    this._updateShaders(context, Boolean(useHdr));
    this._commands.length = 0;
    if (this._milkyWayCommand) this._commands.push(this._milkyWayCommand);
    if (this._starCommand) this._commands.push(this._starCommand);
    if (this._commands.length === 0) return undefined;
    this._updateRotation(frameState.time);
    return this._compositeCommand;
  }

  isDestroyed() {
    return this._destroyed;
  }

  destroy() {
    for (const command of [this._milkyWayCommand, this._starCommand]) {
      if (!command) continue;
      command.vertexArray?.destroy();
      command.shaderProgram?.destroy();
    }
    this._milkyWayCubeMap = this._milkyWayCubeMap?.destroy();
    this._cubeMap = this._cubeMap?.destroy();
    this._milkyWayCommand = undefined;
    this._starCommand = undefined;
    this._commands.length = 0;
    this._destroyed = true;
    return undefined;
  }
}
