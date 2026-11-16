/**
 * A stand-in scene and WebGL context for tests of the occlusion probe: just
 * the members `sceneOcclusionProbe.js` uses, with depth images the test
 * controls.
 *
 * The fake context cannot run GLSL. When the probe draws a point inside a
 * query, the fake decides whether the point draws by applying the same rule
 * to the same inputs the vertex shader gets (the uploaded attributes, the
 * bound depth textures and the uniforms), using the CPU decode from
 * `detectionOcclusion.js`. That checks everything around the shader; the
 * shader itself is checked against `scene.pickPosition` in a real browser.
 */
import * as Cesium from 'cesium';
import { depthToViewDistance, unpackDepth } from '../detectionOcclusion.js';

/** Inverse of `unpackDepth`: four base-255 digits, most significant first. */
export function packDepth(depth) {
  const bytes = [];
  let rest = Math.min(Math.max(depth, 0), 1);
  for (let i = 0; i < 4; i++) {
    rest *= 255;
    const digit = Math.min(255, Math.floor(rest));
    bytes.push(digit);
    rest -= digit;
  }
  return bytes;
}

/** Inverse of `depthToViewDistance`. */
export function viewDistanceToDepth(distance, near, far, logDepth) {
  if (logDepth)
    return Math.log2(distance - near + 1) / Math.log2(far - near + 1);
  return (far * (distance - near)) / (distance * (far - near));
}

/**
 * An RGBA8 depth image filled from a function of the texel.
 * @param {number} width
 * @param {number} height
 * @param {(column: number, row: number) => number} depthAt Window depth; rows
 *   count from the bottom.
 */
export function depthImage(width, height, depthAt) {
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++)
    for (let column = 0; column < width; column++)
      data.set(packDepth(depthAt(column, row)), (row * width + column) * 4);
  return { width, height, data };
}

const GL = {
  FRAMEBUFFER: 0x8d40,
  READ_FRAMEBUFFER: 0x8ca8,
  DRAW_FRAMEBUFFER: 0x8ca9,
  FRAMEBUFFER_BINDING: 0x8ca6,
  DRAW_FRAMEBUFFER_BINDING: 0x8ca6,
  READ_FRAMEBUFFER_BINDING: 0x8caa,
  TEXTURE_BINDING_2D: 0x8069,
  TEXTURE_2D: 0x0de1,
  TEXTURE0: 0x84c0,
  ACTIVE_TEXTURE: 0x84e0,
  COLOR_ATTACHMENT0: 0x8ce0,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  ARRAY_BUFFER: 0x8892,
  ARRAY_BUFFER_BINDING: 0x8894,
  VERTEX_ARRAY_BINDING: 0x85b5,
  CURRENT_PROGRAM: 0x8b8d,
  STREAM_DRAW: 0x88e0,
  SCISSOR_TEST: 0x0c11,
  VIEWPORT: 0x0ba2,
  POINTS: 0x0000,
  FLOAT: 0x1406,
  RGBA: 0x1908,
  RGBA8: 0x8058,
  UNSIGNED_BYTE: 0x1401,
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  ANY_SAMPLES_PASSED_CONSERVATIVE: 0x8d6a,
  QUERY_RESULT: 0x8866,
  QUERY_RESULT_AVAILABLE: 0x8867,
};

/**
 * A recording WebGL context. `webgl2: false` leaves out queries, vertex
 * arrays and immutable textures, as a WebGL 1 context does. Query results
 * stay unavailable until `finishGpu()`.
 */
export function createFakeGl({ webgl2 = true } = {}) {
  const state = {
    read: null,
    draw: null,
    units: [null, null, null, null, null, null, null, null],
    unit: 0,
    array: null,
    vertexArray: null,
    program: null,
    scissor: false,
    viewport: [0, 0, 1920, 1080],
    lost: false,
    /** Whether a point that should draw does (false: a broken draw path). */
    drawsLand: true,
    /** Whether shaders compile: a boolean, or a function of the shader type. */
    compiles: true,
  };
  const counts = {
    readPixels: 0,
    queries: 0,
    draws: 0,
    resultReads: 0,
    deleted: 0,
  };
  const liveQueries = new Set();
  const liveShaders = new Set();
  let activeQuery = null;
  const gl = {
    ...GL,
    state,
    counts,
    liveQueries,
    liveShaders,
    isContextLost: () => state.lost,
    getParameter(name) {
      if (name === GL.READ_FRAMEBUFFER_BINDING) return state.read;
      if (name === GL.DRAW_FRAMEBUFFER_BINDING) return state.draw;
      if (name === GL.TEXTURE_BINDING_2D) return state.units[state.unit];
      if (name === GL.ACTIVE_TEXTURE) return GL.TEXTURE0 + state.unit;
      if (name === GL.ARRAY_BUFFER_BINDING) return state.array;
      if (name === GL.VERTEX_ARRAY_BINDING) return state.vertexArray;
      if (name === GL.CURRENT_PROGRAM) return state.program;
      if (name === GL.VIEWPORT) return Int32Array.from(state.viewport);
      return null;
    },
    isEnabled: (cap) => cap === GL.SCISSOR_TEST && state.scissor,
    enable(cap) {
      if (cap === GL.SCISSOR_TEST) state.scissor = true;
    },
    disable(cap) {
      if (cap === GL.SCISSOR_TEST) state.scissor = false;
    },
    createFramebuffer: () => ({ image: null }),
    createTexture: () => ({ image: null }),
    createBuffer: () => ({ data: null }),
    deleteFramebuffer() {
      counts.deleted++;
    },
    deleteTexture() {
      counts.deleted++;
    },
    deleteBuffer() {
      counts.deleted++;
    },
    activeTexture(unit) {
      state.unit = unit - GL.TEXTURE0;
    },
    bindTexture(_target, texture) {
      state.units[state.unit] = texture;
    },
    bindFramebuffer(target, framebuffer) {
      if (target !== GL.DRAW_FRAMEBUFFER) state.read = framebuffer;
      if (target !== GL.READ_FRAMEBUFFER) state.draw = framebuffer;
    },
    bindBuffer(_target, buffer) {
      state.array = buffer;
    },
    readPixels(x, y, width, height, _format, _type, destination) {
      counts.readPixels++;
      const image = state.read.image;
      for (let row = 0; row < height; row++) {
        const from = ((y + row) * image.width + x) * 4;
        destination.set(
          image.data.subarray(from, from + width * 4),
          row * width * 4,
        );
      }
    },
  };
  if (webgl2) {
    Object.assign(gl, {
      texStorage2D(_target, _levels, _format, width, height) {
        state.units[state.unit].image = {
          width,
          height,
          data: new Uint8Array(width * height * 4),
        };
      },
      framebufferTexture2D(_target, _attachment, _kind, texture) {
        state.draw.image = texture.image;
      },
      checkFramebufferStatus: () => GL.FRAMEBUFFER_COMPLETE,
      createShader(type) {
        const shader = { type };
        liveShaders.add(shader);
        return shader;
      },
      shaderSource() {},
      compileShader() {},
      getShaderParameter: (shader) =>
        typeof state.compiles === 'function'
          ? state.compiles(shader.type)
          : state.compiles,
      deleteShader(shader) {
        liveShaders.delete(shader);
      },
      createProgram: () => ({ uniforms: {} }),
      attachShader() {},
      linkProgram() {},
      getProgramParameter: () => true,
      deleteProgram() {
        counts.deleted++;
      },
      getUniformLocation: (_program, name) => name,
      useProgram(program) {
        state.program = program;
      },
      viewport(x, y, width, height) {
        state.viewport = [x, y, width, height];
      },
      uniform1i(name, value) {
        state.program.uniforms[name] = value;
      },
      uniform4f(name, x, y, z, w) {
        state.program.uniforms[name] = [x, y, z, w];
      },
      createVertexArray: () => ({ buffer: null }),
      deleteVertexArray() {
        counts.deleted++;
      },
      bindVertexArray(vertexArray) {
        state.vertexArray = vertexArray;
      },
      enableVertexAttribArray() {},
      vertexAttribPointer() {
        state.vertexArray.buffer = state.array;
      },
      bufferData(_target, data) {
        state.array.data = Float32Array.from(data);
      },
      createQuery() {
        const query = { drew: false, available: false, ended: false };
        liveQueries.add(query);
        return query;
      },
      deleteQuery(query) {
        liveQueries.delete(query);
      },
      beginQuery(_target, query) {
        counts.queries++;
        query.drew = false;
        query.available = false;
        query.ended = false;
        activeQuery = query;
      },
      endQuery() {
        activeQuery.ended = true;
        activeQuery = null;
      },
      /** The vertex shader's rule, applied to what the shader would be given. */
      drawArrays(_mode, first) {
        counts.draws++;
        const uniforms = state.program.uniforms;
        const data = state.vertexArray.buffer.data;
        const u = data[first * 3];
        const v = data[first * 3 + 1];
        const threshold = data[first * 3 + 2];
        let surface = -1;
        for (let i = 0; i < uniforms.u_count && surface < 0; i++) {
          const image = state.units[uniforms[`u_depth${i}`]].image;
          const column = Math.min(image.width - 1, Math.floor(u * image.width));
          const row = Math.min(image.height - 1, Math.floor(v * image.height));
          const distance = depthToViewDistance(
            unpackDepth(image.data, (row * image.width + column) * 4),
            uniforms.u_near[i],
            uniforms.u_far[i],
            uniforms.u_logDepth === 1,
          );
          if (distance === distance) surface = distance;
        }
        const hidden = surface > 0 && surface < threshold;
        // A point at the middle of the viewport lands only if that is the
        // target's one pixel and the scissor test is not in the way. A
        // sampler left on a unit with no texture fails the whole draw.
        const samplersBound = [0, 1, 2, 3].every(
          (i) => state.units[uniforms[`u_depth${i}`]]?.image,
        );
        const lands =
          state.drawsLand &&
          samplersBound &&
          !state.scissor &&
          state.draw?.image?.width === 1 &&
          state.viewport.join() === '0,0,1,1';
        if (activeQuery && !hidden && lands) activeQuery.drew = true;
      },
      getQueryParameter(query, name) {
        if (name === GL.QUERY_RESULT_AVAILABLE) return query.available;
        counts.resultReads++;
        return query.available && query.drew ? 1 : 0;
      },
    });
  }
  /** Let every query issued so far finish. */
  gl.finishGpu = () => {
    for (const query of liveQueries) if (query.ended) query.available = true;
  };
  return gl;
}

/**
 * A scene drawn in the given depth ranges, nearest first.
 * @param {{
 *   gl?: object,
 *   ranges: Array<{near: number, far: number, image: object}>,
 *   logDepth?: boolean, fovy?: number, aspectRatio?: number,
 *   viewMatrix?: Cesium.Matrix4,
 * }} options
 */
export function createFakeDepthScene({
  gl = createFakeGl(),
  ranges,
  logDepth = true,
  fovy = Math.PI / 2,
  aspectRatio = 1,
  viewMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
}) {
  return {
    mode: Cesium.SceneMode.SCENE3D,
    useDepthPicking: true,
    opaqueFrustumNearOffset: 0.9999,
    context: { _gl: gl, depthTexture: true, webgl2: !!gl.createQuery },
    _environmentState: { useGlobeDepthFramebuffer: true },
    frameState: { useLogDepth: logDepth },
    camera: { frustum: { fovy, aspectRatio }, viewMatrix },
    view: {
      frustumCommandsList: ranges.map(({ near, far }) => ({ near, far })),
      pickDepths: ranges.map(({ image }) => {
        const texture = { image };
        return {
          framebuffer: {
            _framebuffer: { image },
            getColorTexture: () => ({
              width: image.width,
              height: image.height,
              _texture: texture,
            }),
          },
        };
      }),
    },
  };
}
