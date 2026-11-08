import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { isEngineEvent } from '../contract.js';
import { bridgeEvent } from './events.js';

test('a bridged event is a contract event that subscribes to Cesium lazily', () => {
  const source = new Cesium.Event();
  const { event, detach } = bridgeEvent(source);
  assert.ok(isEngineEvent(event));
  assert.equal(source.numberOfListeners, 0, 'creation must not subscribe');
  const seen = [];
  const remove = event.addEventListener((value) => seen.push(value));
  assert.equal(source.numberOfListeners, 1);
  source.raiseEvent(0.25);
  assert.deepEqual(seen, [0.25]);
  remove();
  assert.equal(source.numberOfListeners, 0, 'last removal unsubscribes');
  source.raiseEvent(0.5);
  assert.deepEqual(seen, [0.25]);
  detach();
});

test('a bridged event maps Cesium arguments and keeps contract semantics', () => {
  const source = new Cesium.Event();
  const { event } = bridgeEvent(source, { unary: (scene, time) => time * 2 });
  const seen = [];
  const listener = (value) => seen.push(value);
  event.addEventListener(listener);
  event.addEventListener(listener);
  assert.equal(source.numberOfListeners, 1);
  source.raiseEvent({}, 3);
  assert.deepEqual(seen, [6], 'a listener added twice fires once');
  assert.equal(event.removeEventListener(listener), true);
  assert.equal(source.numberOfListeners, 0);
  assert.equal(event.removeEventListener(listener), false);
});

test('a listener removed during dispatch unsubscribes after the dispatch', () => {
  const source = new Cesium.Event();
  const { event } = bridgeEvent(source);
  let calls = 0;
  const once = () => {
    calls++;
    event.removeEventListener(once);
  };
  event.addEventListener(once);
  source.raiseEvent();
  source.raiseEvent();
  assert.equal(calls, 1);
  assert.equal(source.numberOfListeners, 0);
});

test('detach drops the Cesium subscription for good', () => {
  const source = new Cesium.Event();
  const { event, detach } = bridgeEvent(source);
  event.addEventListener(() => {});
  detach();
  assert.equal(source.numberOfListeners, 0);
  event.addEventListener(() => assert.fail('detached event fired'));
  assert.equal(source.numberOfListeners, 0);
  source.raiseEvent();
});

test('a bridge detaches through the remover the source returned', () => {
  // Cesium.Event.addEventListener returns a remover; the bridge relies on it
  // alone, so event-like sources without removeEventListener work too.
  const listeners = new Set();
  const source = {
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const { event, detach } = bridgeEvent(source);
  const remove = event.addEventListener(() => {});
  assert.equal(listeners.size, 1);
  remove();
  assert.equal(listeners.size, 0);
  event.addEventListener(() => {});
  detach();
  assert.equal(listeners.size, 0);
});

test('a unary bridge raises one mapped value', () => {
  const source = new Cesium.Event();
  const { event, detach } = bridgeEvent(source, {
    unary: (scene, time) => time * 2,
  });
  const seen = [];
  event.addEventListener((...values) => seen.push(values));
  source.raiseEvent({}, 4);
  assert.deepEqual(seen, [[8]]);
  detach();
});
