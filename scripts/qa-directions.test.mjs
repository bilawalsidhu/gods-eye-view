import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { pollPage } from './qa/ready.mjs';
import { createFakeEngine } from '../src/globe/testing/fakeEngine.js';

// Evaluate the browser wait without launching the executable scenario.
const source = readFileSync(
  new URL('./qa-directions.mjs', import.meta.url),
  'utf8',
);
const waitSource = source.slice(
  source.indexOf('const waitForFlight ='),
  source.indexOf('const waitForRoute ='),
);

for (const startsAt of [50, 12000, null]) {
  test(`directions FLY waits for owned route progress (${startsAt ?? 'never'} ms)`, async (t) => {
    const engine = createFakeEngine();
    t.after(() => engine.destroy());
    let motion = null;
    let disposed = 0;
    let observedAt;
    const before = engine.camera.pose().position;
    const waitForFlight = vm.runInNewContext(`${waitSource}\nwaitForFlight`, {
      pollPage,
      window: {
        __godsEyeView: {
          engine,
          dataManager: {
            layers: new Map([
              ['directions', { module: { getFlightProgress: () => motion } }],
            ]),
          },
        },
      },
      page: {
        async waitForFunction(check, options, origin) {
          const predicate = () => check(origin);
          assert.equal(options.timeout, 15000);
          assert.equal(options.polling, 50);
          assert.equal(predicate(), false, 'no owned flight yet');
          motion = { kind: 'route', traveledM: 0 };
          assert.equal(predicate(), false, 'arming is not a mid-flight frame');
          motion = { kind: 'orbit', traveledM: 20 };
          assert.equal(predicate(), false, 'another camera motion cannot pass');
          motion = { kind: 'route', traveledM: 20 };
          assert.equal(predicate(), false, 'the camera must have moved too');
          engine.fake.setPose({ position: { ...before, y: before.y + 60 } });
          for (let time = 0; time < options.timeout; time += options.polling) {
            motion =
              startsAt !== null && time >= startsAt
                ? { kind: 'route', traveledM: 20 }
                : null;
            if (predicate()) {
              observedAt = time;
              return {
                dispose: async () => {
                  disposed++;
                },
              };
            }
          }
          const error = new Error('flight did not start');
          error.name = 'TimeoutError';
          throw error;
        },
      },
    });
    assert.equal(await waitForFlight(before), startsAt !== null);
    assert.equal(observedAt, startsAt ?? undefined);
    assert.equal(disposed, startsAt === null ? 0 : 1);
  });
}
