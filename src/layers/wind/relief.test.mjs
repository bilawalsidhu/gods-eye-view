import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindRelief, WIND_RELIEF_STRENGTH } from './relief.js';

// A viewer whose globe port records the shading it is asked for.
function fixture({ shading = true } = {}) {
  const calls = [];
  const port = (name) => ({
    name,
    ...(shading
      ? {
          setSurfaceShading(next) {
            calls.push([name, next]);
          },
        }
      : {}),
  });
  const ports = new Map();
  const viewer = { isDestroyed: () => false };
  ports.set(viewer, port('first'));
  let current = viewer;
  const relief = createWindRelief({
    getViewer: () => current,
    globeOf: (given) => ports.get(given) ?? null,
  });
  return {
    relief,
    calls,
    viewer,
    ports,
    port,
    use: (next) => (current = next),
  };
}

test('relief asks the globe port for hillshade once and gives it back on clear', () => {
  const f = fixture();
  assert.equal(f.relief.attach(), true);
  assert.equal(f.relief.attach(), true);
  assert.deepEqual(f.calls, [
    ['first', { kind: 'hillshade', strength: WIND_RELIEF_STRENGTH }],
  ]);
  assert.equal(WIND_RELIEF_STRENGTH, 0.28);
  assert.equal(f.relief.getDiagnostics().active, true);
  assert.equal(f.relief.getDiagnostics().maxOpacity, 0.28);
  f.relief.clear();
  assert.deepEqual(f.calls.at(-1), ['first', null]);
  f.relief.clear();
  assert.equal(f.calls.length, 2, 'a second clear asks nothing');
  assert.equal(f.relief.getDiagnostics().active, false);
  assert.equal(f.relief.attach(), true);
  f.relief.destroy();
  assert.deepEqual(f.calls.at(-1), ['first', null]);
  assert.equal(f.relief.attach(), false);
  assert.equal(f.relief.getDiagnostics().reason, 'Destroyed');
});

test('a globe with no surface shading, or one that refuses it, is reported', () => {
  const f = fixture({ shading: false });
  assert.equal(f.relief.attach(), false);
  assert.equal(f.relief.getDiagnostics().reason, 'Globe material unavailable');
  const refusing = fixture();
  const asked = [];
  refusing.ports.get(refusing.viewer).setSurfaceShading = (next) => {
    asked.push(next);
    if (next) throw new TypeError('no hillshade');
  };
  assert.equal(refusing.relief.attach(), false);
  assert.equal(
    refusing.relief.getDiagnostics().reason,
    'Relief material unavailable',
  );
  assert.equal(refusing.relief.getDiagnostics().active, false);
  assert.deepEqual(
    asked.at(-1),
    null,
    'a refused request is taken back so it never shows later',
  );
});

test('moving to a new viewer releases the old globe and shades only the new one', () => {
  const f = fixture();
  f.relief.attach();
  const next = { isDestroyed: () => false };
  f.ports.set(next, f.port('second'));
  f.use(next);
  assert.equal(f.relief.attach(), true);
  assert.deepEqual(f.calls, [
    ['first', { kind: 'hillshade', strength: 0.28 }],
    ['first', null],
    ['second', { kind: 'hillshade', strength: 0.28 }],
  ]);
  f.relief.destroy();
  assert.deepEqual(f.calls.at(-1), ['second', null]);
});

test('a destroyed viewer is never asked to give the shading back', () => {
  const f = fixture();
  f.relief.attach();
  f.viewer.isDestroyed = () => true;
  f.relief.clear();
  assert.equal(f.calls.length, 1);
});
