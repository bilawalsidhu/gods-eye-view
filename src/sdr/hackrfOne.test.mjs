import test from 'node:test';
import assert from 'node:assert/strict';
import { openHackrfOne } from './hackrfOne.js';
import { HACKRF_GAIN_DEFAULTS } from './gain.js';

test('HackRF releases USB if claiming its interface fails', async () => {
  let closed = false;
  const device = {
    open: async () => {},
    selectConfiguration: async () => {},
    claimInterface: async () => {
      throw new Error('claim failed');
    },
    close: async () => {
      closed = true;
    },
  };
  await assert.rejects(openHackrfOne(device), /claim failed/);
  assert.equal(closed, true);
});

test('HackRF configures the wire protocol and returns transferable unsigned IQ', async () => {
  const calls = [];
  const device = {
    configuration: { configurationValue: 1 },
    open: async () => calls.push('open'),
    claimInterface: async (n) => calls.push(['claim', n]),
    controlTransferOut: async ({ request, value, index }, data) => {
      const words = data && [data.getUint32(0, true), data.getUint32(4, true)];
      calls.push([request, value, index, words ?? null]);
      return { status: 'ok', bytesWritten: data?.byteLength ?? 0 };
    },
    controlTransferIn: async ({ request, value, index }, length) => {
      calls.push([request, value, index, length]);
      return { status: 'ok', data: new DataView(Uint8Array.of(1).buffer) };
    },
    transferIn: async (endpoint, length) => {
      assert.equal(endpoint, 1);
      assert.equal(length, 4);
      return {
        status: 'ok',
        data: new DataView(
          Uint8Array.of(99, 128, 255, 0, 127, 98).buffer,
          1,
          4,
        ),
      };
    },
    close: async () => calls.push('close'),
  };
  const rx = await openHackrfOne(device);
  await assert.rejects(rx.readSamples(2), /not receiving/);
  await rx.configure({
    sampleRate: 2_048_000,
    frequencyHz: 98_500_000,
    gain: HACKRF_GAIN_DEFAULTS,
  });
  const { data } = await rx.readSamples(2);
  assert.deepEqual(Array.from(new Uint8Array(data)), [0, 127, 128, 255]);
  assert.deepEqual(calls, [
    'open',
    ['claim', 0],
    [6, 0, 0, [2_048_000, 1]],
    [7, 1_750_000 & 0xffff, 1_750_000 >>> 16, null],
    [16, 0, 0, [98, 500_000]],
    [17, 0, 0, null],
    [19, 0, 16, 1],
    [20, 0, 16, 1],
    [1, 1, 0, null],
  ]);

  await rx.configure({
    sampleRate: 2_000_000,
    frequencyHz: 1_090_000_000,
    gain: HACKRF_GAIN_DEFAULTS,
  });
  assert.deepEqual(
    calls[9],
    [1, 0, 0, null],
    'stop reception before reconfiguring',
  );
  assert.deepEqual(calls[12], [16, 0, 0, [1090, 0]]);
  device.transferIn = async () => ({ status: 'stall' });
  await assert.rejects(rx.readSamples(2), /IQ transfer failed/);
  await Promise.all([rx.close(), rx.close()]);
  assert.deepEqual(calls.slice(-2), [[1, 0, 0, null], 'close']);
  assert.equal(calls.filter((call) => call === 'close').length, 1);
});
