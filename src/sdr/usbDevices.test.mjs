import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SDR_DEVICE_STORAGE_KEY,
  createRememberingWebUsb,
  createSdrDeviceMemory,
  requestHackrfOne,
  readHackrfBoardId,
  sameSdrDevice,
  sdrDeviceLabel,
  selectAuthorizedSdrDevice,
} from './usbDevices.js';

const RTL_FILTERS = [
  { vendorId: 0x0bda, productId: 0x2832 },
  { vendorId: 0x0bda, productId: 0x2838 },
];

// A FlyCatcher enumerates as two RTL2832U devices that may share a serial.
const flyCatcherUat = {
  vendorId: 0x0bda,
  productId: 0x2838,
  productName: 'FlyCatcher_UAT',
  serialNumber: '00000001',
};
const flyCatcherAdsb = {
  vendorId: 0x0bda,
  productId: 0x2838,
  productName: 'FlyCatcher_ADS_B',
  serialNumber: '00000001',
};
const genericDongle = {
  vendorId: 0x0bda,
  productId: 0x2838,
  productName: 'RTL2838UHIDIR',
  serialNumber: '00000001',
};
const unrelated = { vendorId: 0x1234, productId: 0x5678, productName: 'Other' };

test('HackRF One selection filters the picker and reuses the authorized receiver', async () => {
  const hackrf = { vendorId: 0x1d50, productId: 0x6089 };
  const authorized = [genericDongle, { vendorId: 0x1d50, productId: 0x604b }];
  let pickerCalls = 0;
  const usb = createRememberingWebUsb({
    getDevices: async () => authorized,
    async requestDevice({ filters }) {
      assert.deepEqual(filters, [hackrf]);
      pickerCalls++;
      authorized.push(hackrf);
      return hackrf;
    },
  });
  assert.equal(await requestHackrfOne(usb), hackrf);
  assert.equal(await requestHackrfOne(usb), hackrf);
  assert.equal(pickerCalls, 1);
  assert.equal(sdrDeviceLabel(hackrf), 'HackRF One');
  assert.equal(
    selectAuthorizedSdrDevice([hackrf], { filters: RTL_FILTERS }),
    null,
  );
});

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test('ADS-B mode prefers the 1090 MHz channel of a dual-channel board', () => {
  const devices = [unrelated, flyCatcherUat, flyCatcherAdsb];
  assert.equal(
    selectAuthorizedSdrDevice(devices, { filters: RTL_FILTERS, mode: 'adsb' }),
    flyCatcherAdsb,
  );
  assert.equal(
    selectAuthorizedSdrDevice(
      [genericDongle, { ...flyCatcherAdsb, productName: 'Receiver 1090' }],
      {
        filters: RTL_FILTERS,
        mode: 'adsb',
      },
    ).productName,
    'Receiver 1090',
  );
  assert.equal(
    selectAuthorizedSdrDevice([genericDongle], {
      filters: RTL_FILTERS,
      mode: 'adsb',
    }),
    genericDongle,
    'a single generic dongle is still used for ADS-B',
  );
});

test('FM mode avoids ADS-B/UAT channels, and nothing matches unrelated devices', () => {
  assert.equal(
    selectAuthorizedSdrDevice([flyCatcherAdsb, flyCatcherUat, genericDongle], {
      filters: RTL_FILTERS,
      mode: 'fm',
    }),
    genericDongle,
  );
  assert.equal(
    selectAuthorizedSdrDevice([unrelated], {
      filters: RTL_FILTERS,
      mode: 'fm',
    }),
    null,
  );
  assert.equal(selectAuthorizedSdrDevice([], { mode: 'adsb' }), null);
});

test('a remembered device wins, matched by the full identity rather than serial alone', () => {
  const devices = [flyCatcherAdsb, flyCatcherUat];
  assert.equal(
    selectAuthorizedSdrDevice(devices, {
      filters: RTL_FILTERS,
      mode: 'adsb',
      remembered: { ...flyCatcherUat },
    }),
    flyCatcherUat,
    'an explicit earlier choice is honored even for ADS-B',
  );
  assert.equal(sameSdrDevice(flyCatcherAdsb, flyCatcherUat), false);
  assert.equal(sameSdrDevice(flyCatcherAdsb, { ...flyCatcherAdsb }), true);
  assert.equal(
    selectAuthorizedSdrDevice(devices, {
      filters: RTL_FILTERS,
      mode: 'adsb',
      remembered: { ...flyCatcherAdsb, serialNumber: 'unplugged' },
    }),
    flyCatcherAdsb,
    'an absent remembered device falls back to the ADS-B preference',
  );
});

test('device memory is per mode and tolerates unavailable storage', () => {
  const storage = memoryStorage();
  const memory = createSdrDeviceMemory(storage);
  memory.set('adsb', flyCatcherAdsb);
  memory.set('fm', genericDongle);
  assert.deepEqual(memory.get('adsb'), flyCatcherAdsb);
  assert.deepEqual(memory.get('fm'), genericDongle);
  assert.ok(
    storage.values.get(SDR_DEVICE_STORAGE_KEY).includes('FlyCatcher_ADS_B'),
  );
  const blocked = createSdrDeviceMemory({
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  });
  assert.equal(blocked.get('adsb'), null);
  assert.doesNotThrow(() => blocked.set('adsb', flyCatcherAdsb));
});

test('the WebUSB wrapper reuses the remembered channel without the picker', async () => {
  const memory = createSdrDeviceMemory(memoryStorage());
  memory.set('adsb', flyCatcherAdsb);
  let pickerCalls = 0;
  const selected = [];
  const webUsb = createRememberingWebUsb(
    {
      async getDevices() {
        return [flyCatcherUat, flyCatcherAdsb];
      },
      async requestDevice() {
        pickerCalls += 1;
        return null;
      },
    },
    {
      getMode: () => 'adsb',
      memory,
      onSelected: (device) => selected.push(device),
    },
  );
  assert.equal(
    await webUsb.requestDevice({ filters: RTL_FILTERS }),
    flyCatcherAdsb,
  );
  assert.equal(pickerCalls, 0);
  assert.deepEqual(selected, [flyCatcherAdsb]);
});

test('CHANGE DEVICE forces the picker once and remembers the choice for the mode', async () => {
  const memory = createSdrDeviceMemory(memoryStorage());
  memory.set('adsb', flyCatcherAdsb);
  let force = true;
  let pickerCalls = 0;
  const webUsb = createRememberingWebUsb(
    {
      async getDevices() {
        return [flyCatcherUat, flyCatcherAdsb];
      },
      async requestDevice() {
        pickerCalls += 1;
        return flyCatcherUat;
      },
    },
    {
      getMode: () => 'adsb',
      memory,
      consumeForcePicker: () => {
        const value = force;
        force = false;
        return value;
      },
    },
  );
  assert.equal(
    await webUsb.requestDevice({ filters: RTL_FILTERS }),
    flyCatcherUat,
  );
  assert.equal(pickerCalls, 1);
  assert.deepEqual(memory.get('adsb'), flyCatcherUat);
  assert.equal(
    await webUsb.requestDevice({ filters: RTL_FILTERS }),
    flyCatcherUat,
  );
  assert.equal(pickerCalls, 1, 'the next connection reuses the new choice');
});

test('automatic selection is not remembered, so a fallback never becomes sticky', async () => {
  const memory = createSdrDeviceMemory(memoryStorage());
  const webUsb = createRememberingWebUsb(
    {
      async getDevices() {
        return [flyCatcherUat];
      },
      async requestDevice() {
        throw new Error('picker should not open');
      },
    },
    { getMode: () => 'adsb', memory },
  );
  assert.equal(
    await webUsb.requestDevice({ filters: RTL_FILTERS }),
    flyCatcherUat,
  );
  assert.equal(memory.get('adsb'), null);
});

test('HackRF board ID probe reads one byte and releases USB even on a stall', async () => {
  const calls = [];
  const device = {
    open: async () => calls.push('open'),
    selectConfiguration: async (n) => calls.push(['configure', n]),
    claimInterface: async (n) => calls.push(['claim', n]),
    controlTransferIn: async (setup, length) => {
      assert.deepEqual(setup, {
        requestType: 'vendor',
        recipient: 'device',
        request: 14,
        value: 0,
        index: 0,
      });
      assert.equal(length, 1);
      return { status: 'ok', data: new DataView(Uint8Array.of(2).buffer) };
    },
    close: async () => calls.push('close'),
  };
  assert.equal(await readHackrfBoardId(device), 2);
  assert.deepEqual(calls, ['open', ['configure', 1], ['claim', 0], 'close']);
  device.controlTransferIn = async () => ({ status: 'stall' });
  await assert.rejects(readHackrfBoardId(device), /board ID read failed/);
  assert.equal(calls.at(-1), 'close');
});
