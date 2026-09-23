import test from 'node:test';
import assert from 'node:assert/strict';

import {
  internetRadioAudioActive,
  localSdrCardView,
  localSdrFmAudioActive,
} from './localSdrPresentation.js';

const idle = Object.freeze({
  webUsbSupported: true,
  connected: false,
  status: 'idle',
  message: 'Connect an RTL-SDR to begin.',
  mode: 'fm',
  frequencyHz: 98_500_000,
  volume: 0.8,
  gain: 'auto',
  seeking: false,
  seekMessage: '',
  decodedMessages: 0,
  messagesPerSecond: null,
  aircraftHeard: 0,
  aircraftPositioned: 0,
  deviceLabel: null,
  locationStatus: 'unknown',
  audioState: 'idle',
  samplesPerSecond: 0,
  workerBlocks: 0,
  iqLevelDbfs: null,
  audioLevelDbfs: null,
});

test('an idle card invites a connection and hides receiver stats', () => {
  const view = localSdrCardView(idle);
  assert.equal(view.statusText, 'Connect an RTL-SDR to begin.');
  assert.equal(view.connectLabel, 'CONNECT');
  assert.equal(view.connectDisabled, false);
  assert.equal(view.connectionLabel, 'IDLE');
  assert.equal(view.gainValue, 'auto');
  assert.equal(view.statsHidden, true);
  assert.equal(view.tuneDisabled, true);
  assert.equal(view.seekDisabled, true);
  assert.equal(view.frequencyValue, '98.5');
  const unsupported = localSdrCardView({
    ...idle,
    webUsbSupported: false,
    status: 'unsupported',
    message: 'WebUSB is unavailable in this browser',
  });
  assert.equal(unsupported.connectDisabled, true);
  assert.equal(unsupported.changeDeviceDisabled, true);
  assert.equal(unsupported.statusError, true);
});

test('streaming ADS-B shows message rate, heard, positioned and IQ level', () => {
  const view = localSdrCardView({
    ...idle,
    connected: true,
    status: 'streaming',
    mode: 'adsb',
    message: 'Receiving 1090 MHz ADS-B',
    gain: 20.7,
    messagesPerSecond: 13.8,
    aircraftHeard: 4,
    aircraftPositioned: 2,
    iqLevelDbfs: -21.44,
    samplesPerSecond: 2_000_000,
    decodedMessages: 276,
    deviceLabel: 'FlyCatcher_ADS_B',
  });
  assert.equal(view.statsHidden, false);
  assert.deepEqual(view.stats, {
    rate: '13.8',
    heard: '4',
    positioned: '2',
    iq: '-21.4 dBFS',
  });
  assert.equal(view.gainValue, '20.7');
  assert.equal(view.connectionLabel, '4 HEARD');
  assert.equal(view.connectLabel, 'DISCONNECT');
  assert.equal(view.frequencyDisabled, true);
  assert.equal(view.volumeDisabled, true);
  assert.equal(
    view.statusText,
    'Receiving 1090 MHz ADS-B · FlyCatcher_ADS_B · 2.00 MS/s IQ · 276 messages',
  );
});

test('local FM and internet radio audio states drive the one-listener rule', () => {
  assert.equal(localSdrFmAudioActive(idle), false);
  assert.equal(
    localSdrFmAudioActive({ ...idle, connected: true, status: 'streaming' }),
    true,
  );
  assert.equal(
    localSdrFmAudioActive({
      ...idle,
      connected: true,
      status: 'streaming',
      mode: 'adsb',
    }),
    false,
    'ADS-B produces no audio',
  );
  for (const audioState of ['loading', 'buffering', 'playing'])
    assert.equal(internetRadioAudioActive({ audioState }), true);
  assert.equal(internetRadioAudioActive({ audioState: 'paused' }), false);
  assert.equal(internetRadioAudioActive(null), false);
});
