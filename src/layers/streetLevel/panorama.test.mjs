import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PANO_FOV_MAX_DEG,
  PANO_FOV_MIN_DEG,
  PANO_PITCH_LIMIT_DEG,
  clampFov,
  clampPitch,
  createPanoramaRenderer,
  rayToUv,
  wrapDegrees,
} from './panorama.js';

const close = (actual, expected) =>
  actual.forEach((value, i) =>
    assert.ok(Math.abs(value - expected[i]) < 1e-9, `${actual} ≉ ${expected}`),
  );

test('straight ahead samples the image centre; yaw turns right, pitch looks up', () => {
  close(rayToUv([0, 0, -1]), [0.5, 0.5]);
  close(rayToUv([0, 0, -1], { yaw: 90 }), [0.75, 0.5]);
  close(rayToUv([0, 0, -1], { yaw: -90 }), [0.25, 0.5]);
  close(rayToUv([0, 0, -1], { pitch: 45 }), [0.5, 0.25]);
  close(rayToUv([0, 0, -1], { pitch: -90 }), [0.5, 1]);
  // Pitch first, then yaw: looking up-right stays up.
  close(rayToUv([0, 0, -1], { yaw: 90, pitch: 45 }), [0.75, 0.25]);
  // A ray to the right of the screen is the same as turning right.
  close(rayToUv([1, 0, 0]), [0.75, 0.5]);
});

test('view limits: pitch stops short of the poles, field of view stays usable', () => {
  assert.equal(clampPitch(120), PANO_PITCH_LIMIT_DEG);
  assert.equal(clampPitch(-120), -PANO_PITCH_LIMIT_DEG);
  assert.equal(clampFov(5), PANO_FOV_MIN_DEG);
  assert.equal(clampFov(170), PANO_FOV_MAX_DEG);
  assert.equal(wrapDegrees(-30), 330);
  assert.equal(wrapDegrees(725), 5);
});

/**
 * A WebGL stand-in that records draw calls and uniform values; `lost` makes
 * it report a lost context.
 */
function stubGl() {
  const gl = {
    lost: false,
    calls: [],
    uniforms: {},
    isContextLost: () => gl.lost,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: (program, name) => name,
    getExtension: () => null,
    uniform1f: (name, value) => (gl.uniforms[name] = value),
  };
  return new Proxy(gl, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === 'string' && /^[A-Z_0-9]+$/.test(key)) return key;
      return (...args) => {
        target.calls.push(key);
        return { key, args };
      };
    },
  });
}

/** A panorama on a stub canvas, with frames run when the test says. */
function stubPanorama(t, { width = 400, height = 250 } = {}) {
  const gl = stubGl();
  const canvas = {
    clientWidth: width,
    clientHeight: height,
    width: 300,
    height: 150,
    getContext: () => gl,
  };
  const frames = [];
  const saved = {
    request: globalThis.requestAnimationFrame,
    cancel: globalThis.cancelAnimationFrame,
  };
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => {
    globalThis.requestAnimationFrame = saved.request;
    globalThis.cancelAnimationFrame = saved.cancel;
  });
  const renderer = createPanoramaRenderer(canvas);
  const runFrames = () => {
    while (frames.length) frames.shift()();
  };
  return { gl, canvas, renderer, runFrames };
}

const IMAGE = { width: 1024, height: 512 };

test('a panorama draws once it has an image; looking up and right are positive angles', (t) => {
  const { gl, renderer, runFrames } = stubPanorama(t);
  renderer.render();
  runFrames();
  assert.equal(gl.calls.includes('drawArrays'), false, 'nothing to draw yet');
  renderer.setImage(IMAGE);
  renderer.setView({ yaw: 30, pitch: 30 });
  runFrames();
  assert.ok(gl.calls.includes('drawArrays'));
  assert.ok(gl.uniforms.u_pitch > 0, `u_pitch ${gl.uniforms.u_pitch}`);
  assert.ok(Math.abs(gl.uniforms.u_pitch - Math.PI / 6) < 1e-9);
  assert.ok(Math.abs(gl.uniforms.u_yaw - Math.PI / 6) < 1e-9);
  renderer.setView({ pitch: -20 });
  runFrames();
  assert.ok(gl.uniforms.u_pitch < 0, 'looking down is negative');
});

test('a lost WebGL context draws nothing', (t) => {
  const { gl, renderer, runFrames } = stubPanorama(t);
  renderer.setImage(IMAGE);
  gl.lost = true;
  gl.calls.length = 0;
  runFrames();
  assert.deepEqual(
    gl.calls.filter((call) =>
      ['viewport', 'clear', 'drawArrays'].includes(call),
    ),
    [],
  );
});

test('the canvas is measured again when it draws, not only when its image arrived', (t) => {
  // The image arrives while the canvas is still hidden (0×0)…
  const { canvas, renderer, runFrames } = stubPanorama(t, {
    width: 0,
    height: 0,
  });
  renderer.setImage(IMAGE);
  assert.deepEqual([canvas.width, canvas.height], [1, 1]);
  // …and is laid out before the frame draws.
  canvas.clientWidth = 400;
  canvas.clientHeight = 250;
  runFrames();
  assert.deepEqual([canvas.width, canvas.height], [400, 250]);
});

test('an image uploads as RGBA and its bitmap is released; closing hands the texture back as 1×1', (t) => {
  const { gl, renderer } = stubPanorama(t);
  const uploads = [];
  gl.texImage2D = (...args) => uploads.push(args);
  let closed = false;
  renderer.setImage({
    width: 2048,
    height: 1024,
    close: () => (closed = true),
  });
  assert.equal(uploads.length, 1);
  assert.equal(
    uploads[0][2],
    'RGBA',
    'the format a decoded bitmap uploads without conversion',
  );
  assert.equal(closed, true, 'the decoded copy is freed once on the GPU');
  renderer.clear();
  const last = uploads.at(-1);
  assert.deepEqual(
    [last[3], last[4]],
    [1, 1],
    'a closed viewer keeps a 1×1 texture',
  );
  assert.equal(renderer.hasImage(), false);
});

test('a power-of-two bitmap wraps in longitude even though it is closed once uploaded', (t) => {
  const { gl, renderer } = stubPanorama(t);
  const wraps = [];
  gl.texParameteri = (target, name, value) => wraps.push([name, value]);
  gl.TEXTURE_WRAP_S = 'WRAP_S';
  gl.REPEAT = 'REPEAT';
  gl.CLAMP_TO_EDGE = 'CLAMP';
  const bitmap = {
    width: 2048,
    height: 1024,
    // A closed ImageBitmap measures 0×0.
    close() {
      this.width = 0;
      this.height = 0;
    },
  };
  renderer.setImage(bitmap);
  assert.deepEqual(
    wraps.find(([name]) => name === 'WRAP_S'),
    ['WRAP_S', 'REPEAT'],
  );
  wraps.length = 0;
  renderer.setImage({ width: 2000, height: 1000 });
  assert.deepEqual(
    wraps.find(([name]) => name === 'WRAP_S'),
    ['WRAP_S', 'CLAMP'],
    'other sizes clamp (WebGL 1 repeats powers of two only)',
  );
});
