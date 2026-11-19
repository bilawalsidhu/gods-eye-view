import test from 'node:test';
import assert from 'node:assert/strict';
import { clientNetworkKey, isLoopbackPeer } from './rate-limit.js';

const req = (remoteAddress) => ({ socket: { remoteAddress } });

test('clientNetworkKey keys IPv6 peers by /64 and folds IPv4-mapped peers', () => {
  assert.equal(clientNetworkKey(req('2001:db8:1:2::1')), '2001:db8:1:2::/64');
  assert.equal(
    clientNetworkKey(req('2001:0db8:0001:0002:abcd:ef01:2345:6789')),
    '2001:db8:1:2::/64',
  );
  assert.equal(clientNetworkKey(req('2001:DB8::1')), '2001:db8:0:0::/64');
  assert.equal(clientNetworkKey(req('fe80::1%en0')), 'fe80:0:0:0::/64');
  assert.equal(clientNetworkKey(req('::1')), '0:0:0:0::/64');
  assert.equal(clientNetworkKey(req('::ffff:10.0.0.5')), '10.0.0.5');
  assert.equal(clientNetworkKey(req('10.0.0.5')), '10.0.0.5');
  assert.equal(clientNetworkKey(req(undefined)), 'local');
  assert.equal(clientNetworkKey(req('not-an-address')), 'not-an-address');
});

test('isLoopbackPeer recognizes every loopback form and nothing else', () => {
  for (const address of ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackPeer(address), true, address);
  }
  for (const address of [
    '10.0.0.1',
    '::ffff:10.0.0.1',
    '2001:db8::1',
    '::2',
    'local',
    '',
    undefined,
  ]) {
    assert.equal(isLoopbackPeer(address), false, String(address));
  }
});
