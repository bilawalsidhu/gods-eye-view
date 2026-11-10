import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from './fakeEngine.js';
import { createContractMonitor } from './contractMonitor.js';

const destination = { x: 7000000, y: 1000000, z: 0 };
const violations = (monitor) => monitor.records.map((row) => row.invariant);

test('normal flights, moves, in-frame requests and destruction preserve the contract', async () => {
  const engine = createFakeEngine();
  const monitor = createContractMonitor(engine);
  engine.camera.flyTo({ destination, duration: 0 });
  engine.camera.flyTo({ destination, duration: 1 });
  engine.camera.cancelFlight();
  engine.camera.flyToSphere({ center: destination, radius: 100 });
  engine.camera.completeFlight();
  let remove = engine.frames.postRender.addEventListener(() => {
    remove();
    engine.render.request();
  });
  engine.fake.frames(3);
  await Promise.resolve();
  await monitor.finish();
  engine.destroy();
  assert.deepEqual(monitor.records, []);
  monitor.dispose();
});

test('terminal callbacks are counted even without caller callbacks', () => {
  for (const endings of [
    [],
    ['complete', 'cancel'],
    ['complete', 'complete'],
  ]) {
    const engine = createFakeEngine();
    engine.camera.flyTo = (options) =>
      endings.forEach((name) => options[name]());
    const monitor = createContractMonitor(engine);
    engine.camera.flyTo({ destination });
    monitor.finish();
    assert.ok(violations(monitor).includes('flight-terminal'));
    monitor.dispose();
  }
});

test('complete callbacks and explicit flight termination must see an inactive flight', () => {
  for (const at of ['complete', 'cancelFlight', 'completeFlight']) {
    const engine = createFakeEngine();
    if (at === 'complete')
      engine.camera.flyTo = (options) => options.complete();
    else engine.camera[at] = () => {};
    engine.camera.flightActive = () => true;
    const monitor = createContractMonitor(engine);
    if (at === 'complete') engine.camera.flyTo({ destination });
    else engine.camera[at]();
    assert.ok(
      monitor.records.some(
        (row) => row.invariant === 'flight-active' && row.at === at,
      ),
    );
    monitor.dispose();
  }
});

test('a cancelled flight that loses its callback is reported at cancellation', () => {
  const engine = createFakeEngine();
  engine.camera.flyTo = () => {};
  const monitor = createContractMonitor(engine);
  engine.camera.flyTo({ destination });
  engine.camera.cancelFlight();
  assert.ok(violations(monitor).includes('flight-terminal'));
});

test('moveStart and moveEnd must alternate', () => {
  for (const events of [
    ['moveEnd'],
    ['moveStart', 'moveStart'],
    ['moveStart', 'moveEnd', 'moveEnd'],
  ]) {
    const engine = createFakeEngine();
    const monitor = createContractMonitor(engine);
    for (const name of events) engine.fake.emit(`camera.${name}`);
    assert.ok(violations(monitor).includes('move-alternation'));
  }
});

test('a swallowed in-frame render request leaves a missing next frame', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const engine = createFakeEngine();
  engine.render.request = () => {};
  const monitor = createContractMonitor(engine);
  engine.frames.postRender.addEventListener(() => engine.render.request());
  engine.fake.frame();
  const finish = monitor.finish();
  t.mock.timers.tick(2000);
  await finish;
  assert.ok(violations(monitor).includes('render-request-lost'));
});

test('a request in the next frame must also draw a later frame', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const engine = createFakeEngine();
  engine.render.request = () => {};
  const monitor = createContractMonitor(engine);
  engine.frames.preRender.addEventListener(() => engine.render.request());
  engine.fake.frames(2);
  const finish = monitor.finish();
  t.mock.timers.tick(2000);
  await finish;
  assert.ok(violations(monitor).includes('render-request-lost'));
});

test('an update without a draw does not mark later requests as in-frame', async () => {
  const engine = createFakeEngine();
  const monitor = createContractMonitor(engine);
  engine.fake.emit('frames.preUpdate');
  await Promise.resolve();
  engine.render.request();
  await monitor.finish();
  assert.deepEqual(monitor.records, []);
});

test('the active engine must finish with inputs enabled and without a flight', () => {
  const engine = createFakeEngine();
  const monitor = createContractMonitor(engine);
  engine.input.suspendCameraInputs();
  engine.camera.flyTo({ destination });
  monitor.finish();
  assert.ok(violations(monitor).includes('final-inputs-disabled'));
  assert.ok(violations(monitor).includes('final-flight-active'));
});

test('events emitted after destroy remain observable until disposal', () => {
  const engine = createFakeEngine();
  const monitor = createContractMonitor(engine);
  engine.destroy();
  engine.fake.emit('camera.changed');
  engine.fake.emit('frames.postRender');
  assert.deepEqual(violations(monitor), [
    'event-after-destroy',
    'event-after-destroy',
  ]);
  monitor.dispose();
  engine.fake.emit('camera.changed');
  assert.equal(monitor.records.length, 2);
});

test('wrappers preserve callback arguments, receivers, returns, and thrown commands', () => {
  const engine = createFakeEngine();
  const receiver = {};
  engine.camera.flyTo = (options) => options.complete.call(receiver, 7);
  const original = engine.camera.flyTo;
  const monitor = createContractMonitor(engine);
  assert.equal(
    engine.camera.flyTo({
      complete(value) {
        assert.equal(this, receiver);
        return value;
      },
    }),
    7,
  );
  monitor.dispose();
  assert.equal(engine.camera.flyTo, original);
  const real = createFakeEngine();
  const other = createContractMonitor(real);
  assert.throws(() => real.camera.flyTo({}), /destination/);
  other.finish();
  assert.deepEqual(other.records, []);
});

test('a final in-frame request may draw its next frame before evidence closes', async () => {
  const engine = createFakeEngine();
  const monitor = createContractMonitor(engine);
  let remove = engine.frames.postRender.addEventListener(() => {
    remove();
    engine.render.request();
  });
  engine.fake.frame();
  const finish = monitor.finish();
  engine.fake.frame();
  await finish;
  assert.deepEqual(monitor.records, []);
});
