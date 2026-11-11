import test from 'node:test';
import assert from 'node:assert/strict';
import { localSdrCardView } from './localSdrPresentation.js';
import { setLocale } from '../i18n/index.js';

const fmStreaming = {
  webUsbSupported: true,
  connected: true,
  status: 'streaming',
  message: 'Streaming',
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
  deviceLabel: 'RTL2838',
  locationStatus: 'unknown',
  audioState: 'running',
  samplesPerSecond: 2_400_000,
  workerBlocks: 3,
  iqLevelDbfs: -20,
  audioLevelDbfs: -12,
};

test('FM status line names the AudioContext state in the UI language', () => {
  try {
    for (const [locale, state] of [
      ['es', 'running'],
      ['ru', 'running'],
      ['es', 'suspended'],
      ['ru', 'closed'],
      ['es', 'idle'],
      ['ru', 'idle'],
    ]) {
      setLocale(locale);
      const text = localSdrCardView({
        ...fmStreaming,
        audioState: state,
      }).statusText;
      assert.doesNotMatch(
        text,
        new RegExp(`audio[: ]+${state}\\b|аудио[: ]+${state}\\b`),
        `${locale}: ${text}`,
      );
    }
  } finally {
    setLocale('en');
  }
});

test('FM status line keeps the English AudioContext state words', () => {
  setLocale('en');
  for (const state of ['running', 'suspended', 'closed', 'idle']) {
    const text = localSdrCardView({
      ...fmStreaming,
      audioState: state,
    }).statusText;
    assert.ok(text.endsWith(` · audio ${state}`), text);
  }
});
