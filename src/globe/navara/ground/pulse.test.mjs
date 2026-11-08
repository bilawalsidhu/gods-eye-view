import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../../geo/index.js';
import { registerHooks } from 'node:module';

const hook = registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === '@navaramap/three' &&
      context.parentURL?.endsWith('/ground/pulse.js')
    )
      return {
        url: 'data:text/javascript,export class EffectDesc {} export class Effect {}',
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
let createNavaraPulseField;
try {
  ({ createNavaraPulseField } = await import('./pulse.js'));
} finally {
  hook.deregister();
}

test('the Navara pulse disc draws only while the pulses run', () => {
  const effects = [];
  const view = {
    registerEffect() {},
    forceUpdate() {},
    addEffect(config) {
      const handle = {
        config,
        visible: config.visible,
        deleted: false,
        update(next) {
          handle.visible = next.visible;
        },
        delete() {
          handle.deleted = true;
        },
      };
      effects.push(handle);
      return handle;
    },
  };
  const disc = createNavaraPulseField(
    { view },
    {
      center: geo.cartesian3.fromDegrees(3, 27, 0),
      radiusM: 250_000,
      heightM: 2500,
      color: [0, 0, 1, 0.2],
      lineColor: [0, 0, 1, 1],
      haloColor: [0, 0, 0, 0.8],
      depth: 0.35,
      lineWidth: 3,
      haloWidth: 1,
    },
  );
  disc.draw({ level: 0, radii: [0.1, 0.4, 0.7], alphas: [0, 0, 0] });
  assert.equal(effects.length, 0, 'nothing drawn at rest');
  disc.draw({ level: 1, radii: [0.1, 0.4, 0.7], alphas: [0.5, 0.3, 0.2] });
  assert.equal(effects.length, 1);
  const owner = effects[0].config.gevGroundPulses.owner;
  assert.deepEqual(owner.radii, [0.1, 0.4, 0.7, 0]);
  assert.deepEqual(owner.alphas, [0.5, 0.3, 0.2, 0]);
  assert.ok(Math.abs(owner.center.length() - 1) < 1e-9, 'a unit direction');
  disc.draw({ level: 0, radii: [0, 0, 0], alphas: [0, 0, 0] });
  assert.equal(effects[0].visible, false);
  disc.destroy();
  assert.equal(effects[0].deleted, true);
});
