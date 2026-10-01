import assert from 'node:assert/strict';
import test from 'node:test';
import { clientKey } from './rate-limit.js';

function withAppService(t, value) {
  const before = process.env.WEBSITE_INSTANCE_ID;
  if (value === undefined) delete process.env.WEBSITE_INSTANCE_ID;
  else process.env.WEBSITE_INSTANCE_ID = value;
  t.after(() => {
    if (before === undefined) delete process.env.WEBSITE_INSTANCE_ID;
    else process.env.WEBSITE_INSTANCE_ID = before;
  });
}

const req = (remoteAddress, xff) => ({
  socket: { remoteAddress },
  headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
});

test('T2: clientKey ignores X-Forwarded-For outside App Service', (t) => {
  withAppService(t, undefined);
  assert.equal(clientKey(req('10.0.0.5', '203.0.113.9')), '10.0.0.5');
  assert.equal(clientKey({ headers: {} }), 'local');
});

test('T2: clientKey keys on the right-most X-Forwarded-For hop on App Service', (t) => {
  withAppService(t, 'abc123');
  // A client-supplied left-hand value must not mint a fresh bucket: App
  // Service appends the real peer, so only the right-most entry is trusted.
  assert.equal(
    clientKey(req('169.254.0.1', 'spoofed-1, 198.51.100.7:51234')),
    '198.51.100.7',
  );
  assert.equal(
    clientKey(req('169.254.0.1', 'spoofed-2,198.51.100.7')),
    '198.51.100.7',
  );
});

test('T2: clientKey strips the port and brackets from IPv6 App Service hops', (t) => {
  withAppService(t, 'abc123');
  assert.equal(
    clientKey(req('169.254.0.1', '[2001:db8::1]:443')),
    '2001:db8::1',
  );
  assert.equal(clientKey(req('169.254.0.1', '2001:db8::2')), '2001:db8::2');
});

test('T2: clientKey falls back to the socket peer when App Service sends no X-Forwarded-For', (t) => {
  withAppService(t, 'abc123');
  assert.equal(clientKey(req('169.254.0.1')), '169.254.0.1');
  assert.equal(clientKey(req('169.254.0.1', ' , ')), '169.254.0.1');
  assert.equal(
    clientKey(req('169.254.0.1', ['1.1.1.1', '192.0.2.4:80'])),
    '192.0.2.4',
  );
});
