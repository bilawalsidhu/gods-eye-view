import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  getWorldPacket,
  semanticWorldPacketFingerprint,
} from './worldPacket.js';
import { createGevActionRunner } from '../voice/gevActions.js';

function harness() {
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.26, 500);
  const viewer = {
    trackedEntity: undefined,
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: {
      canvas: {
        clientWidth: 1200,
        clientHeight: 800,
        addEventListener() {},
        removeEventListener() {},
      },
      globe: { getHeight: () => 0 },
      tweens: [],
    },
    camera: {
      positionWC: position,
      positionCartographic: Cesium.Cartographic.fromCartesian(position),
      heading: 0,
      pitch: Cesium.Math.toRadians(-45),
      moveEnd: { addEventListener: () => () => {} },
      cancelFlight() {},
      lookAtTransform() {},
    },
  };
  const rows = [
    {
      id: 'traffic',
      name: 'Traffic',
      enabled: true,
      stats: {
        count: 3,
        source: 'fixture',
        lastUpdate: null,
      },
    },
  ];
  const dataManager = {
    layers: new Map([['traffic', { module: null }]]),
    getAll: () => rows,
  };
  const styleManager = {
    activeStyle: 'normal',
    getContextModeState: () => ({ mode: 'flights' }),
    getCockpitState: () => null,
    getControlState: () => ({ hud: { visible: 'auto' } }),
  };
  return { viewer, dataManager, styleManager };
}

test('World Packet preserves get_current_view_state parity', async () => {
  const { viewer, dataManager, styleManager } = harness();
  const packet = getWorldPacket({ viewer, dataManager, styleManager });
  const runner = createGevActionRunner({ viewer, dataManager, styleManager });
  const voice = await runner('get_current_view_state');

  assert.deepEqual(voice, packet);
  assert.equal(packet.context.mode, 'contacts');
  assert.equal(packet.context.modeInternal, 'flights');
  assert.equal(packet.layers[0].feedState, 'nominal');
  assert.equal(packet.feedProvenance.overall, 'nominal');
});

test('World Packet keeps stale/unavailable feed semantics distinct from empty', () => {
  const { viewer, dataManager, styleManager } = harness();
  dataManager.getAll = () => [
    {
      id: 'traffic',
      name: 'Traffic',
      enabled: true,
      stats: {
        count: 0,
        source: 'fixture',
        error: 'fixture unavailable',
        lastUpdate: null,
      },
    },
  ];

  const packet = getWorldPacket({ viewer, dataManager, styleManager });
  assert.equal(packet.layers[0].count, 0);
  assert.notEqual(packet.layers[0].feedState, 'nominal');
  assert.notEqual(packet.feedProvenance.overall, 'nominal');
  assert.match(packet.feedProvenance.note, /fixture unavailable/i);
});


test('semantic fingerprint ignores narration prose but changes with observed state', () => {
  const { viewer, dataManager, styleManager } = harness();
  const packet = getWorldPacket({ viewer, dataManager, styleManager });
  const original = semanticWorldPacketFingerprint(packet);

  const proseOnly = structuredClone(packet);
  proseOnly.feedProvenance.note = 'different generated narration';
  assert.equal(semanticWorldPacketFingerprint(proseOnly), original);

  const changed = structuredClone(packet);
  changed.layers[0].count += 1;
  assert.notEqual(semanticWorldPacketFingerprint(changed), original);
});
