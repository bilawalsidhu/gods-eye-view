/**
 * Asks the GPU, per contact, whether the scene drew something in front of it,
 * without waiting for the answer.
 *
 * The scene already keeps the depth of the frame it has just drawn (for
 * picking). `scene.pickPosition` reads one texel of it back and waits, a
 * fraction of a millisecond to over a millisecond per call; asking once per
 * labelled contact turns a 2 ms frame into a 40 ms one. Copying the whole
 * depth image back instead is no better where it matters: Chromium answers
 * `getBufferSubData` with a round trip to its GPU process even after a sync
 * object has signalled, measured here at 1.5 ms on a quiet machine and 15 to
 * 25 ms on a busy one.
 *
 * So nothing is read back at all. Each tested contact becomes one point drawn
 * into a private 1x1 target, inside an occlusion query. The vertex shader looks
 * up the frame's depth at the contact's pixel, decodes it, and throws the point
 * away when the drawn surface is nearer than the contact's threshold (see
 * `projectContact`). The query's "did anything draw" bit is the answer, and
 * asking whether a query result is in is the one question WebGL 2 lets a page
 * put to the GPU without waiting (Chromium publishes results to the page
 * through shared memory between frames): `_collect` just looks.
 *
 * - `beginFrame(scene, now)` collects the answers that have arrived.
 * - `add(contact, position)` queues a contact for testing against this frame.
 * - `endFrame()` draws the queued points. Answers land a frame or two later.
 *
 * A WebGL 1 context has no queries. There the probe falls back to reading the
 * frame's depth back synchronously, at most every `SYNC_READ_INTERVAL_MS`, and
 * answering on the CPU; `mode` then reads `'sync'`. Where the scene keeps no
 * pick depth, or is not a 3D perspective view, `mode` reads `'off'`, nothing
 * is tested and callers carry on as if no contact were hidden.
 *
 * Every read of renderer internals is in `readSceneDepthSource` below; the
 * rest of the file is plain WebGL on the handles that function returns.
 */
import * as Cesium from 'cesium';
import { DepthSnapshot, projectContact } from './detectionOcclusion.js';

/**
 * Depth ranges tested, nearest first. Logarithmic depth draws nearly every
 * view in one or two; anything past the fourth is beyond where depth-tested
 * contacts are labelled.
 */
export const PROBE_MAX_FRUSTUMS = 4;

/** Contacts tested per frame; the rest wait for the next one. */
export const PROBE_MAX_PER_FRAME = 256;

/** Painted frames a batch of queries may stay unanswered before it is dropped. */
export const PROBE_MAX_PENDING_FRAMES = 120;

/** Batches in a row whose control point failed before the probe stands down. */
export const PROBE_MAX_CONTROL_FAILURES = 3;

/** How long the probe stands down after a failure before trying again. */
export const PROBE_RETRY_AFTER_MS = 10_000;

/** Shortest gap between two synchronous depth reads (WebGL 1 fallback). */
export const SYNC_READ_INTERVAL_MS = 125;

/**
 * Everything this module takes from the renderer, in one place.
 *
 * RENDERER INTERNALS. Checked against cesium 1.138.0 (@cesium/engine 22.3.0);
 * re-check on an engine upgrade. Undocumented members used, and what each is
 * assumed to be:
 *
 * - `scene.context._gl`: the WebGL context. `scene.context.webgl2` says which.
 * - `scene.view.frustumCommandsList[i].near` / `.far`: the depth ranges the
 *   last frame was drawn in, nearest first.
 * - `scene.view.pickDepths[i].framebuffer`: one framebuffer per depth range,
 *   refreshed every frame while `scene.useDepthPicking` is on and
 *   `scene._environmentState.useGlobeDepthFramebuffer` is true, whose first
 *   colour attachment is an RGBA8 texture holding window-space depth packed
 *   four bytes to a texel (`czm_packDepth`; see `unpackDepth`).
 *   `framebuffer._framebuffer` is the raw WebGL framebuffer, and
 *   `framebuffer.getColorTexture(0)` the texture (`._texture` its raw handle).
 * - Opaque geometry in every range but the nearest is drawn with its near
 *   plane pulled in by `scene.opaqueFrustumNearOffset` (public), exactly as
 *   `scene.pickPosition` assumes when it decodes the same textures.
 * - `scene.frameState.useLogDepth`: whether depth is logarithmic (see
 *   `depthToViewDistance`). Anything but a boolean there is "no depth".
 *
 * Any of these missing or shaped differently returns null, which callers treat
 * as "no depth".
 *
 * @param {Cesium.Scene} scene
 * @param {Float64Array} [viewScratch] Sixteen numbers to write the view matrix
 *   into instead of allocating; the result's `view` is then this array.
 * @returns {null | {
 *   gl: WebGLRenderingContext|WebGL2RenderingContext, webgl2: boolean,
 *   width: number, height: number, framebuffers: WebGLFramebuffer[],
 *   textures: WebGLTexture[],
 *   frustums: Array<{near: number, far: number}>, logDepth: boolean,
 *   view: Float64Array, tanHalfFovX: number, tanHalfFovY: number,
 * }}
 */
export function readSceneDepthSource(scene, viewScratch) {
  try {
    if (!scene || scene.mode !== Cesium.SceneMode.SCENE3D) return null;
    if (scene.useDepthPicking !== true) return null;
    const context = scene.context;
    const gl = context?._gl;
    if (!gl || context.depthTexture !== true) return null;
    if (scene._environmentState?.useGlobeDepthFramebuffer !== true) return null;

    const camera = scene.camera;
    const frustum = camera?.frustum;
    const fovy = frustum?.fovy;
    const aspectRatio = frustum?.aspectRatio;
    if (!(fovy > 0 && fovy < Math.PI) || !(aspectRatio > 0)) return null;
    if (frustum.xOffset || frustum.yOffset) return null;

    const view = scene.view;
    const ranges = view?.frustumCommandsList;
    const pickDepths = view?.pickDepths;
    if (!ranges?.length || !pickDepths?.length) return null;
    const count = Math.min(
      ranges.length,
      pickDepths.length,
      PROBE_MAX_FRUSTUMS,
    );
    const nearOffset = Number(scene.opaqueFrustumNearOffset) || 1;
    const framebuffers = [];
    const textures = [];
    const frustums = [];
    let width = 0;
    let height = 0;
    for (let i = 0; i < count; i++) {
      const framebuffer = pickDepths[i]?.framebuffer;
      const raw = framebuffer?._framebuffer;
      const texture = framebuffer?.getColorTexture?.(0);
      const near = ranges[i]?.near * (i === 0 ? 1 : nearOffset);
      const far = ranges[i]?.far;
      if (!raw || !texture?._texture || !(near > 0) || !(far > near))
        return null;
      if (i === 0) {
        width = texture.width;
        height = texture.height;
      } else if (texture.width !== width || texture.height !== height) {
        return null;
      }
      framebuffers.push(raw);
      textures.push(texture._texture);
      frustums.push({ near, far });
    }
    if (!(width > 0) || !(height > 0)) return null;
    // Read as standard depth, logarithmic depth puts every surface a few
    // metres from the camera and would hide every contact: unknown is "no".
    const logDepth = scene.frameState?.useLogDepth;
    if (typeof logDepth !== 'boolean') return null;

    const tanHalfFovY = Math.tan(fovy / 2);
    return {
      gl,
      webgl2: context.webgl2 === true,
      width,
      height,
      framebuffers,
      textures,
      frustums,
      logDepth,
      view: Cesium.Matrix4.toArray(
        camera.viewMatrix,
        viewScratch || new Float64Array(16),
      ),
      tanHalfFovX: tanHalfFovY * aspectRatio,
      tanHalfFovY,
    };
  } catch {
    return null;
  }
}

/**
 * One point per contact. `a_contact` is (u, v, threshold): where the contact
 * is in the frame, and the view distance a drawn surface must be under to hide
 * it. A hidden contact's point is moved outside the clip volume, so nothing is
 * drawn and its query reports no samples. A visible one lands on the single
 * pixel of the 1x1 target (the viewport is set to match while these draw).
 */
export const PROBE_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;
layout(location = 0) in vec3 a_contact;
uniform sampler2D u_depth0;
uniform sampler2D u_depth1;
uniform sampler2D u_depth2;
uniform sampler2D u_depth3;
uniform int u_count;
uniform bool u_logDepth;
uniform vec4 u_near;
uniform vec4 u_far;

float viewDistance(sampler2D depthTexture, float near, float far) {
  ivec2 size = textureSize(depthTexture, 0);
  ivec2 texel = min(ivec2(a_contact.xy * vec2(size)), size - 1);
  float depth = dot(
    texelFetch(depthTexture, texel, 0),
    vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
  if (depth <= 0.0 || depth >= 1.0) return -1.0;
  if (u_logDepth) return near + exp2(depth * log2(far - near + 1.0)) - 1.0;
  return near * far / (far - depth * (far - near));
}

void main() {
  float surface = viewDistance(u_depth0, u_near.x, u_far.x);
  if (surface < 0.0 && u_count > 1) surface = viewDistance(u_depth1, u_near.y, u_far.y);
  if (surface < 0.0 && u_count > 2) surface = viewDistance(u_depth2, u_near.z, u_far.z);
  if (surface < 0.0 && u_count > 3) surface = viewDistance(u_depth3, u_near.w, u_far.w);
  bool hidden = surface > 0.0 && surface < a_contact.z;
  gl_Position = hidden ? vec4(2.0, 2.0, 2.0, 1.0) : vec4(0.0, 0.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
out vec4 color;
void main() { color = vec4(1.0); }
`;

function canQuery(gl) {
  return (
    typeof gl.createQuery === 'function' &&
    typeof gl.beginQuery === 'function' &&
    typeof gl.getQueryParameter === 'function' &&
    typeof gl.createVertexArray === 'function'
  );
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** Owns the GPU objects and the query batches in flight. */
export class SceneOcclusionProbe {
  /**
   * @param {{
   *   now?: () => number,
   *   readSource?: typeof readSceneDepthSource,
   * }} [options]
   */
  constructor({
    now = () => performance.now(),
    readSource = readSceneDepthSource,
  } = {}) {
    this._clock = now;
    this._readSource = readSource;
    /** Most tests one frame takes; read by whoever schedules them. */
    this.maxPerFrame = PROBE_MAX_PER_FRAME;
    /** `'async'` (queries), `'sync'` (blocking read), or `'off'`. */
    this.mode = 'off';
    /** Milliseconds the last frame spent collecting answers and drawing. */
    this.lastFrameMs = 0;
    /** Contact tests started in the last frame. */
    this.lastFrameTests = 0;
    this._scene = null;
    this._now = 0;
    this._source = undefined;
    this._gl = null;
    /** A context the probe's shader failed to build on; never retried. */
    this._unsupportedGl = null;
    this._resources = null;
    this._queryPool = [];
    this._batches = [];
    this._attributes = new Float32Array((PROBE_MAX_PER_FRAME + 1) * 3);
    this._queued = [];
    this._projected = { u: 0, v: 0, threshold: 0 };
    this._controlFailures = 0;
    this._retryAt = Number.NEGATIVE_INFINITY;
    this._frame = 0;
    this._view = new Float64Array(16);
    this._snapshot = null;
    this._snapshotAt = Number.NEGATIVE_INFINITY;
    this._spent = 0;
  }

  /**
   * Open a frame: take in the answers that have arrived. Call after the scene
   * has rendered (a post-render listener), before `add`.
   * @param {Cesium.Scene} scene
   * @param {number} now The caller's clock, in milliseconds. Answers are
   *   dated by it, so it must be the clock the caller judges their age on.
   */
  beginFrame(scene, now) {
    const started = this._clock();
    this._scene = scene;
    this._now = now;
    this._frame++;
    this._source = undefined;
    // A frame that never reached `endFrame` leaves its contacts untested.
    this._release(this._queued);
    this._queued.length = 0;
    this.lastFrameTests = 0;
    this._collect();
    this._spent = this._clock() - started;
  }

  /**
   * Queue a contact for testing against the frame just drawn.
   * @param {{lastHiddenAt: number, pending: boolean, answered: boolean}}
   *   contact Updated when the answer arrives: `pending` cleared, `answered`
   *   set and, if the contact was hidden, `lastHiddenAt` set to the time of
   *   the frame it was tested against.
   * @param {{x: number, y: number, z: number}} position
   * @returns {boolean} False when the contact cannot be tested now.
   */
  add(contact, position) {
    if (this._source === undefined) this._openSource();
    const source = this._source;
    if (!source) return false;
    if (this.mode === 'sync') {
      const hidden = this._snapshot?.hides(position);
      if (hidden === null || hidden === undefined) return false;
      contact.answered = true;
      if (hidden) contact.lastHiddenAt = this._now;
      this.lastFrameTests++;
      return true;
    }
    const queued = this._queued;
    if (queued.length >= PROBE_MAX_PER_FRAME) return false;
    const projected = this._projected;
    if (
      !projectContact(
        source.view,
        source.tanHalfFovX,
        source.tanHalfFovY,
        position,
        projected,
      )
    )
      return false;
    // Slot 0 is the control point; contacts start at 1.
    const at = (queued.length + 1) * 3;
    const attributes = this._attributes;
    attributes[at] = projected.u;
    attributes[at + 1] = projected.v;
    attributes[at + 2] = projected.threshold;
    queued.push(contact);
    contact.pending = true;
    this.lastFrameTests++;
    return true;
  }

  /** Close the frame: draw the queued contacts' queries. */
  endFrame() {
    const started = this._clock();
    if (this._queued.length > 0 && this._source && this.mode === 'async') {
      try {
        this._draw(this._source);
      } catch {
        this._release(this._queued);
        this._fail();
      }
    }
    this._queued.length = 0;
    this._source = undefined;
    this.lastFrameMs = this._spent + (this._clock() - started);
  }

  /**
   * Drop every test in flight but keep the GPU objects, so that switching the
   * overlay off and on again does not compile the shader a second time.
   */
  reset() {
    const gl = this._gl;
    for (const batch of this._batches) this._release(batch.contacts);
    this._release(this._queued);
    try {
      if (gl && !gl.isContextLost?.()) {
        for (const batch of this._batches)
          for (let i = batch.cursor; i < batch.queries.length; i++)
            this._queryPool.push(batch.queries[i]);
      }
    } catch {
      // A context that is going away has already released them.
    }
    this._batches.length = 0;
    this._queued.length = 0;
    this._source = undefined;
    this._snapshot = null;
    this._snapshotAt = Number.NEGATIVE_INFINITY;
    this._controlFailures = 0;
    this._retryAt = Number.NEGATIVE_INFINITY;
    this.mode = 'off';
  }

  /** Delete the GPU objects and drop every test in flight. */
  destroy() {
    this.reset();
    const gl = this._gl;
    try {
      if (gl && !gl.isContextLost?.()) {
        for (const query of this._queryPool) gl.deleteQuery(query);
        const resources = this._resources;
        if (resources) {
          gl.deleteProgram(resources.program);
          gl.deleteVertexArray(resources.vertexArray);
          gl.deleteBuffer(resources.buffer);
          gl.deleteFramebuffer(resources.framebuffer);
          gl.deleteTexture(resources.texture);
        }
      }
    } catch {
      // A context that is going away has already released them.
    }
    this._queryPool.length = 0;
    this._resources = null;
    this._gl = null;
    this._unsupportedGl = null;
  }

  /** Tests that will never be answered stop counting as in flight. */
  _release(contacts) {
    for (const contact of contacts) if (contact) contact.pending = false;
  }

  /**
   * Something in the query path broke: stand down for a while and keep
   * everything drawn, then try again in case the cause was passing.
   */
  _fail() {
    this._retryAt = this._now + PROBE_RETRY_AFTER_MS;
    this._controlFailures = 0;
    this.mode = 'off';
  }

  /** Read this frame's depth source, once, when the first contact asks. */
  _openSource() {
    this._source = null;
    if (this._now < this._retryAt) return;
    const source = this._readSource(this._scene, this._view);
    if (!source) {
      this.mode = 'off';
      return;
    }
    if (source.gl !== this._gl) {
      // A different context (a rebuilt viewer) orphans whatever was in flight.
      this.destroy();
      this._gl = source.gl;
    }
    try {
      if (source.gl.isContextLost?.()) {
        // Everything made on the lost context went with it.
        this.reset();
        this._queryPool.length = 0;
        this._resources = null;
        return;
      }
      if (source.gl === this._unsupportedGl) {
        // The shader did not build on this context: nothing is tested here.
        this.mode = 'off';
        return;
      }
      if (source.webgl2 && canQuery(source.gl)) {
        if (!this._resources && !this._createResources(source.gl)) {
          this._fail();
          return;
        }
        this.mode = 'async';
      } else {
        this.mode = 'sync';
        if (this._now - this._snapshotAt >= SYNC_READ_INTERVAL_MS) {
          this._snapshot = this._readSync(source);
          this._snapshotAt = this._now;
        }
      }
      this._source = source;
    } catch {
      this._fail();
    }
  }

  /**
   * Compile the shader and make the 1x1 target. This is the one place the
   * probe does wait on the GPU process (compile, link and framebuffer status
   * are answered synchronously): once per WebGL context, on the first frame a
   * depth-tested contact is in view. `reset` keeps the result.
   */
  _createResources(gl) {
    const vertex = compile(gl, gl.VERTEX_SHADER, PROBE_VERTEX_SHADER);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vertex || !fragment) {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
      // The same source will not compile on this context next time either.
      this._unsupportedGl = gl;
      return false;
    }
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      this._unsupportedGl = gl;
      return false;
    }
    const uniform = (name) => gl.getUniformLocation(program, name);
    const previousArray = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
    const previousBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const previousDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);

    const vertexArray = gl.createVertexArray();
    const buffer = gl.createBuffer();
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(previousArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, previousBuffer);

    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 1, 1);
    gl.bindTexture(gl.TEXTURE_2D, previousTexture);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.DRAW_FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    const complete =
      gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) ===
      gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previousDraw);
    if (!complete) {
      // Leave nothing half-made behind, so a later retry starts from scratch.
      gl.deleteProgram(program);
      gl.deleteVertexArray(vertexArray);
      gl.deleteBuffer(buffer);
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      return false;
    }

    this._resources = {
      program,
      vertexArray,
      buffer,
      texture,
      framebuffer,
      depth: [0, 1, 2, 3].map((i) => uniform(`u_depth${i}`)),
      count: uniform('u_count'),
      logDepth: uniform('u_logDepth'),
      near: uniform('u_near'),
      far: uniform('u_far'),
    };
    return true;
  }

  /**
   * Draw one query per queued contact, preceded by a control point that must
   * always draw. The renderer caches the framebuffer, viewport and scissor
   * state it last set, so those are put back exactly as found, along with
   * every binding touched here. Depth, stencil, blending and the colour mask
   * need no care: the target has no depth or stencil attachment, and a query
   * counts samples whether or not they are written.
   */
  _draw(source) {
    const gl = source.gl;
    const resources = this._resources;
    const contacts = this._queued.slice();
    const count = contacts.length + 1;
    const attributes = this._attributes;
    // The control point: mid-frame, with a threshold nothing can be under.
    attributes[0] = 0.5;
    attributes[1] = 0.5;
    attributes[2] = -1;
    const layers = source.textures.length;
    const frustums = source.frustums;

    const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM);
    const previousArray = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
    const previousBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    const previousDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    const previousUnit = gl.getParameter(gl.ACTIVE_TEXTURE);
    const previousViewport = gl.getParameter(gl.VIEWPORT);
    const previousTextures = [];
    const scissor = gl.isEnabled(gl.SCISSOR_TEST);
    const queries = [];
    const pool = this._queryPool;
    let open = false;
    try {
      for (let i = 0; i < layers; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        previousTextures.push(gl.getParameter(gl.TEXTURE_BINDING_2D));
        gl.bindTexture(gl.TEXTURE_2D, source.textures[i]);
      }
      if (scissor) gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resources.framebuffer);
      gl.viewport(0, 0, 1, 1);
      gl.useProgram(resources.program);
      // Samplers past the ranges in use point at the first range's texture:
      // every sampler a program declares must be drawable, read or not.
      for (let i = 0; i < PROBE_MAX_FRUSTUMS; i++)
        gl.uniform1i(resources.depth[i], i < layers ? i : 0);
      gl.uniform1i(resources.count, layers);
      gl.uniform1i(resources.logDepth, source.logDepth ? 1 : 0);
      gl.uniform4f(
        resources.near,
        frustums[0].near,
        frustums[1]?.near ?? 1,
        frustums[2]?.near ?? 1,
        frustums[3]?.near ?? 1,
      );
      gl.uniform4f(
        resources.far,
        frustums[0].far,
        frustums[1]?.far ?? 2,
        frustums[2]?.far ?? 2,
        frustums[3]?.far ?? 2,
      );
      gl.bindVertexArray(resources.vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, resources.buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        attributes.subarray(0, count * 3),
        gl.STREAM_DRAW,
      );
      for (let i = 0; i < count; i++) {
        const query = pool.pop() || gl.createQuery();
        queries.push(query);
        gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, query);
        open = true;
        gl.drawArrays(gl.POINTS, i, 1);
        gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
        open = false;
      }
    } catch (error) {
      // Leave no query open and none unaccounted for; the caller stands down.
      try {
        if (open) gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
        for (const query of queries) gl.deleteQuery(query);
      } catch {
        // Nothing more can be done for them.
      }
      throw error;
    } finally {
      gl.bindBuffer(gl.ARRAY_BUFFER, previousBuffer);
      gl.bindVertexArray(previousArray);
      gl.useProgram(previousProgram);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previousDraw);
      if (previousViewport)
        gl.viewport(
          previousViewport[0],
          previousViewport[1],
          previousViewport[2],
          previousViewport[3],
        );
      if (scissor) gl.enable(gl.SCISSOR_TEST);
      for (let i = previousTextures.length - 1; i >= 0; i--) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, previousTextures[i]);
      }
      gl.activeTexture(previousUnit);
    }

    this._batches.push({
      queries,
      contacts,
      at: this._now,
      frame: this._frame,
      cursor: 0,
      control: false,
    });
  }

  /**
   * Take in whatever answers have arrived, oldest batch first, without
   * waiting for any that have not. An answer is dated to the frame its test
   * was drawn on, so one that arrives late (the overlay was not painting for
   * a while) is as stale as it is old.
   */
  _collect() {
    const batches = this._batches;
    if (batches.length === 0) return;
    const gl = this._gl;
    try {
      if (gl.isContextLost?.()) {
        // Queries made on a lost context are gone with it.
        this.reset();
        this._queryPool.length = 0;
        this._resources = null;
        return;
      }
      while (batches.length > 0) {
        const batch = batches[0];
        const { queries, contacts } = batch;
        while (batch.cursor < queries.length) {
          const query = queries[batch.cursor];
          if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
          const drew = !!gl.getQueryParameter(query, gl.QUERY_RESULT);
          if (batch.cursor === 0) {
            batch.control = drew;
          } else {
            const contact = contacts[batch.cursor - 1];
            contact.pending = false;
            // Without the control point's yes the batch means nothing: not a
            // "hidden", and not a first answer that ends a new contact's
            // hold-back either.
            if (batch.control) {
              contact.answered = true;
              if (!drew && batch.at > contact.lastHiddenAt)
                contact.lastHiddenAt = batch.at;
            }
          }
          this._queryPool.push(query);
          batch.cursor++;
        }
        if (batch.cursor < queries.length) break;
        batches.shift();
        if (batch.control) {
          this._controlFailures = 0;
        } else if (++this._controlFailures >= PROBE_MAX_CONTROL_FAILURES) {
          this._fail();
        }
      }
      // Whatever is still unanswered after too many frames is dropped,
      // wherever it stands in the queue, so its contacts can be tested again.
      const overdue = this._frame - PROBE_MAX_PENDING_FRAMES;
      for (let i = batches.length - 1; i >= 0; i--) {
        const batch = batches[i];
        if (batch.frame >= overdue) continue;
        for (let k = batch.cursor; k < batch.queries.length; k++)
          gl.deleteQuery(batch.queries[k]);
        for (
          let k = Math.max(0, batch.cursor - 1);
          k < batch.contacts.length;
          k++
        )
          batch.contacts[k].pending = false;
        batches.splice(i, 1);
      }
    } catch {
      for (const batch of batches) this._release(batch.contacts);
      batches.length = 0;
      this._fail();
    }
  }

  /**
   * No queries (WebGL 1): read each depth range at full size and wait for it.
   * Costs milliseconds per read; used only where nothing better exists.
   */
  _readSync(source) {
    const gl = source.gl;
    const { width, height } = source;
    const layers = source.framebuffers.length;
    const layerBytes = width * height * 4;
    const byteLength = layerBytes * layers;
    const bytes =
      this._snapshot?.bytes.length === byteLength
        ? this._snapshot.bytes
        : new Uint8Array(byteLength);
    const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    for (let i = 0; i < layers; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, source.framebuffers[i]);
      gl.readPixels(
        0,
        0,
        width,
        height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        bytes.subarray(i * layerBytes, (i + 1) * layerBytes),
      );
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
    return new DepthSnapshot({
      width,
      height,
      bytes,
      frustums: source.frustums,
      logDepth: source.logDepth,
      // The source's matrix is a scratch array the next frame overwrites.
      view: Float64Array.from(source.view),
      tanHalfFovX: source.tanHalfFovX,
      tanHalfFovY: source.tanHalfFovY,
    });
  }
}
