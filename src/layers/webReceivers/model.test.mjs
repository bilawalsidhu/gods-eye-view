import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptCatalogRows,
  freezeWebReceiver,
  isValidWebReceiver,
} from './model.js';

const row = {
  id: 'ABCDEF123456',
  type: 'kiwisdr',
  name: '  Kiwi  Arvika ',
  site: 'Arvika',
  url: 'http://sa4bna.hopto.org:8073/',
  lat: 59.546,
  lon: 12.526,
  bands: [{ lowHz: 0, highHz: 30_000_000, label: '0–30 MHz' }, { lowHz: 'x' }],
  users: '3.4',
  usersMax: 8,
  online: true,
  antenna: 'beverage',
  sources: ['receiverbook', 'kiwisdr'],
};

test('rows are re-validated in the browser rather than trusted from the wire', () => {
  assert.equal(isValidWebReceiver(row), true);
  assert.equal(isValidWebReceiver(null), false);
  assert.equal(isValidWebReceiver({ ...row, id: 'not-hex' }), false);
  assert.equal(isValidWebReceiver({ ...row, type: 'sdrplay' }), false);
  assert.equal(isValidWebReceiver({ ...row, url: 'ftp://x.example/' }), false);
  assert.equal(isValidWebReceiver({ ...row, lat: 91 }), false);
  assert.equal(isValidWebReceiver({ ...row, lat: 0, lon: 0 }), false);
  assert.equal(isValidWebReceiver({ ...row, name: '  ' }), false);
});

test('freezing normalizes text, numbers and the online tri-state', () => {
  const receiver = freezeWebReceiver(row);
  assert.equal(receiver.id, 'abcdef123456');
  assert.equal(receiver.name, 'Kiwi Arvika');
  assert.equal(receiver.typeLabel, 'KiwiSDR');
  assert.deepEqual(receiver.bands, [
    { lowHz: 0, highHz: 30_000_000, label: '0–30 MHz' },
  ]);
  assert.equal(receiver.users, 3);
  assert.equal(receiver.usersMax, 8);
  assert.equal(receiver.online, true);
  assert.equal(freezeWebReceiver({ ...row, online: 'yes' }).online, null);
  assert.equal(freezeWebReceiver({ ...row, users: null }).users, null);
  assert.deepEqual(receiver.sources, ['receiverbook', 'kiwisdr']);
  assert.ok(Object.isFrozen(receiver));
  assert.ok(Object.isFrozen(receiver.bands));
});

test('acceptCatalogRows keeps only the valid rows and tolerates a malformed body', () => {
  const accepted = acceptCatalogRows({
    receivers: [row, { ...row, id: 'bad id' }, null],
  });
  assert.equal(accepted.length, 1);
  assert.deepEqual(acceptCatalogRows({}), []);
  assert.deepEqual(acceptCatalogRows(null), []);
});
