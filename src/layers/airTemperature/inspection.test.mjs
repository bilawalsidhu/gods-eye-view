import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemperatureInspection } from './inspection.js';
import * as input from '../../data/inputOwnership.js';
import { field } from './fixtures.mjs';

function fixture(t) {
  let click;
  const document = new EventTarget();
  const inspection = createTemperatureInspection({
    cesium: {
      ScreenSpaceEventHandler: class {
        setInputAction(fn) {
          click = fn;
        }
        destroy() {}
      },
      ScreenSpaceEventType: { LEFT_CLICK: 1 },
      Ellipsoid: { WGS84: {} },
      Cartographic: { fromCartesian: () => ({ longitude: 0, latitude: 0 }) },
      Cartesian3: { fromDegrees: () => ({}) },
      Cartesian2: class {},
      Math: { toDegrees: (n) => n },
    },
    viewer: {
      scene: { canvas: { clientWidth: 100, clientHeight: 100 } },
      camera: { pickEllipsoid: () => ({}) },
    },
    input,
    container: { ownerDocument: document },
    getSnapshot: () => field(),
    onChange() {},
  });
  t.after(() => {
    inspection.destroy();
    input.resetPointerOwnership();
  });
  return { inspection, click: () => click({ position: {} }), document };
}

test('point sampling refuses another tool and holds its own lease for the complete click dispatch', (t) => {
  // Given
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const other = input.claimPointer('draw');
  f.inspection.setArmed(true);
  assert.equal(f.inspection.isArmed(), false);
  input.releasePointer(other);
  f.inspection.setArmed(true);
  // When
  f.click();
  // Then
  assert.equal(f.inspection.getReading().celsius, 0);
  assert.equal(f.inspection.isArmed(), false);
  assert.equal(input.isPointerFree(), false);
  t.mock.timers.tick(0);
  assert.equal(input.isPointerFree(), true);
});

test('Escape and destroy release an armed inspection without sampling', (t) => {
  // Given
  const f = fixture(t);
  f.inspection.setArmed(true);
  // When
  const escape = new Event('keydown');
  escape.key = 'Escape';
  f.document.dispatchEvent(escape);
  // Then
  assert.equal(input.isPointerFree(), true);
  assert.equal(f.inspection.getReading(), null);
});
