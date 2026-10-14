/**
 * A minimal equirectangular panorama renderer on WebGL: one full-screen
 * triangle whose fragment shader turns each pixel's view ray into texture
 * coordinates. The image centre is the camera's forward direction; yaw turns
 * right from it, pitch looks up.
 */

export const PANO_FOV_DEFAULT_DEG = 80;
export const PANO_FOV_MIN_DEG = 30;
export const PANO_FOV_MAX_DEG = 100;
export const PANO_PITCH_LIMIT_DEG = 85;

const VERTEX = `
attribute vec2 a_position;
varying vec2 v_ndc;
void main() {
  v_ndc = a_position;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAGMENT = `
precision highp float;
uniform sampler2D u_image;
uniform float u_yaw;
uniform float u_pitch;
uniform float u_tanHalfFov;
uniform float u_aspect;
varying vec2 v_ndc;
const float PI = 3.141592653589793;
void main() {
  vec3 ray = normalize(vec3(v_ndc.x * u_tanHalfFov * u_aspect, v_ndc.y * u_tanHalfFov, -1.0));
  float cp = cos(u_pitch), sp = sin(u_pitch);
  ray = vec3(ray.x, ray.y * cp - ray.z * sp, ray.y * sp + ray.z * cp);
  float cy = cos(u_yaw), sy = sin(u_yaw);
  ray = vec3(ray.x * cy - ray.z * sy, ray.y, ray.x * sy + ray.z * cy);
  float lon = atan(ray.x, -ray.z);
  float lat = asin(clamp(ray.y, -1.0, 1.0));
  gl_FragColor = texture2D(u_image, vec2(0.5 + lon / (2.0 * PI), 0.5 - lat / PI));
}`;

/** Wrap degrees into [0, 360). */
export function wrapDegrees(value) {
  return ((value % 360) + 360) % 360;
}

export function clampPitch(degrees) {
  return Math.max(
    -PANO_PITCH_LIMIT_DEG,
    Math.min(PANO_PITCH_LIMIT_DEG, degrees),
  );
}

export function clampFov(degrees) {
  return Math.max(PANO_FOV_MIN_DEG, Math.min(PANO_FOV_MAX_DEG, degrees));
}

/**
 * Texture coordinates the shader samples for a view ray, for tests and
 * picking: `yaw`/`pitch` in degrees, the ray in camera space (x right, y up,
 * z backward).
 */
export function rayToUv(ray, { yaw = 0, pitch = 0 } = {}) {
  const p = (pitch * Math.PI) / 180;
  const w = (yaw * Math.PI) / 180;
  const length = Math.hypot(ray[0], ray[1], ray[2]) || 1;
  let [x, y, z] = ray.map((v) => v / length);
  [y, z] = [
    y * Math.cos(p) - z * Math.sin(p),
    y * Math.sin(p) + z * Math.cos(p),
  ];
  [x, z] = [
    x * Math.cos(w) - z * Math.sin(w),
    x * Math.sin(w) + z * Math.cos(w),
  ];
  const lon = Math.atan2(x, -z);
  const lat = Math.asin(Math.max(-1, Math.min(1, y)));
  return [0.5 + lon / (2 * Math.PI), 0.5 - lat / Math.PI];
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Panorama shader failed: ${log}`);
  }
  return shader;
}

const isPowerOfTwo = (n) => n > 0 && (n & (n - 1)) === 0;

/**
 * A panorama view on `canvas`. Throws when WebGL is unavailable, so the
 * caller can fall back to a flat picture.
 * @param {HTMLCanvasElement} canvas
 * @returns {{setImage: (image: TexImageSource) => void, setView: (view: {yaw?: number, pitch?: number, fov?: number}) => void, getView: () => {yaw: number, pitch: number, fov: number}, resize: () => void, render: () => void, hasImage: () => boolean, destroy: () => void}}
 */
export function createPanoramaRenderer(canvas) {
  const gl =
    canvas.getContext('webgl', {
      antialias: false,
      depth: false,
      preserveDrawingBuffer: false,
    }) || canvas.getContext('experimental-webgl');
  if (!gl) throw new Error('WebGL is unavailable');

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error('Panorama program failed to link');
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  // One triangle covering the screen.
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  const position = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const uniforms = Object.fromEntries(
    ['u_image', 'u_yaw', 'u_pitch', 'u_tanHalfFov', 'u_aspect'].map((name) => [
      name,
      gl.getUniformLocation(program, name),
    ]),
  );
  const texture = gl.createTexture();
  let loaded = false;
  let frame = 0;
  const view = { yaw: 0, pitch: 0, fov: PANO_FOV_DEFAULT_DEG };

  /** Match the drawing buffer to the canvas's laid-out size. */
  function syncSize() {
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function resize() {
    syncSize();
    scheduleRender();
  }

  function draw() {
    frame = 0;
    if (gl.isContextLost()) return;
    // Every frame: the canvas may have been laid out since the last one.
    syncSize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!loaded) return;
    gl.uniform1i(uniforms.u_image, 0);
    gl.uniform1f(uniforms.u_yaw, (view.yaw * Math.PI) / 180);
    gl.uniform1f(uniforms.u_pitch, (view.pitch * Math.PI) / 180);
    gl.uniform1f(uniforms.u_tanHalfFov, Math.tan((view.fov * Math.PI) / 360));
    gl.uniform1f(uniforms.u_aspect, canvas.width / Math.max(1, canvas.height));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function scheduleRender() {
    if (frame) return;
    frame = requestAnimationFrame(draw);
  }

  return {
    setImage(image) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      // RGBA: the format a decoded ImageBitmap uploads without conversion.
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image,
      );
      // The pixels are on the GPU now; a bitmap's copy can go.
      image.close?.();
      // Linear only: a mipmapped lookup draws a seam where longitude wraps.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      const repeat =
        isPowerOfTwo(image.width) && isPowerOfTwo(image.height)
          ? gl.REPEAT
          : gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      loaded = true;
      resize();
      scheduleRender();
    },
    setView(next = {}) {
      if (Number.isFinite(next.yaw)) view.yaw = wrapDegrees(next.yaw);
      if (Number.isFinite(next.pitch)) view.pitch = clampPitch(next.pitch);
      if (Number.isFinite(next.fov)) view.fov = clampFov(next.fov);
      scheduleRender();
    },
    getView: () => ({ ...view }),
    resize,
    render: scheduleRender,
    hasImage: () => loaded,
    clear() {
      loaded = false;
      // Hand the 32 MB texture back: a closed viewer keeps only 1×1.
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array(4),
      );
      scheduleRender();
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      loaded = false;
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
