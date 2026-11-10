import test from 'node:test';
import assert from 'node:assert/strict';
import { DetectionBracketRaster } from './detectionBracketRaster.js';

function fixture() {
  let strokes = 0,
    blits = 0;
  const paint = {
    setTransform() {},
    clearRect() {},
    stroke() {
      strokes++;
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => paint };
  const target = {
    globalCompositeOperation: 'source-over',
    getTransform: () => ({ a: 2, d: 2, b: 0, c: 0, e: 0, f: 0 }),
    drawImage() {
      blits++;
    },
  };
  const raster = new DetectionBracketRaster(() => canvas);
  const frame = { width: 500, height: 300, dpr: 2 };
  const cache = {
    count: 10000,
    paths: new Map([['cyan', [{ color: '#00ffff', alpha: 0.25, path: {} }]]]),
  };
  return {
    raster,
    frame,
    cache,
    target,
    canvas,
    strokes: () => strokes,
    blits: () => blits,
  };
}
test('unchanged dense brackets reuse their pixels; opacity, style, DPR and geometry invalidate the cache', () => {
  const f = fixture();
  assert.equal(f.raster.draw(f.target, f.cache, f.frame, 1, 0.8), true);
  assert.equal(f.strokes(), 1);
  assert.equal(f.raster.bytes, 500 * 300 * 4 * 4);
  f.raster.draw(f.target, f.cache, f.frame, 1, 0.8);
  assert.equal(f.strokes(), 1);
  assert.equal(f.blits(), 2);
  f.raster.draw(f.target, f.cache, f.frame, 1, 0.4);
  assert.equal(f.strokes(), 2);
  f.raster.draw(f.target, f.cache, f.frame, 1.25, 0.4);
  assert.equal(f.strokes(), 3);
  f.cache.paths = new Map(f.cache.paths);
  f.raster.draw(f.target, f.cache, f.frame, 1.25, 0.4);
  assert.equal(f.strokes(), 4);
  f.raster.clear();
  assert.equal(f.canvas.width, 0);
  assert.equal(f.raster.bytes, 0);
});
test('moving geometry, small populations, oversized surfaces and unsupported compositing keep the vector path', () => {
  const f = fixture();
  f.raster.draw(f.target, f.cache, f.frame, 1, 1);
  f.cache.paths = new Map(f.cache.paths);
  assert.equal(f.raster.draw(f.target, f.cache, f.frame, 1, 1), false);
  assert.equal(f.raster.bytes, 0);
  assert.equal(
    f.raster.draw(f.target, f.cache, f.frame, 1, 1),
    true,
    'a settled view can resume caching',
  );
  f.cache.count = 10;
  assert.equal(f.raster.draw(f.target, f.cache, f.frame, 1, 1), false);
  assert.equal(f.raster.bytes, 0);
  f.cache.count = 10000;
  assert.equal(
    f.raster.draw(f.target, f.cache, { ...f.frame, width: 8000 }, 1, 1),
    false,
  );
  f.target.globalCompositeOperation = 'screen';
  assert.equal(f.raster.draw(f.target, f.cache, f.frame, 1, 1), false);
});
