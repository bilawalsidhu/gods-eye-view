// OPT-IN HTTPS — the microphone needs a secure origin off localhost.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { httpsOptions } from '../../server/standalone/vite.config.js';
import { createBrowserViteConfig } from '../../build/vite.js';

test('HTTPS stays off unless both PEM paths are configured', () => {
  const read = (path) => `pem:${path}`;
  assert.equal(httpsOptions({}, read), undefined);
  assert.deepEqual(
    httpsOptions(
      {
        HTTPS_CERT_FILE: '/certs/gev.pem',
        HTTPS_KEY_FILE: '/certs/gev-key.pem',
      },
      read,
    ),
    { cert: 'pem:/certs/gev.pem', key: 'pem:/certs/gev-key.pem' },
  );
  assert.throws(
    () => httpsOptions({ HTTPS_CERT_FILE: '/certs/gev.pem' }, read),
    /both HTTPS_CERT_FILE and HTTPS_KEY_FILE/,
  );
});

test('the browser config passes TLS through and never serves key material', () => {
  const plain = createBrowserViteConfig({ host: 'localhost' });
  assert.equal(plain.server.https, undefined);
  const secure = createBrowserViteConfig({
    host: 'localhost',
    https: { cert: 'c', key: 'k' },
  });
  assert.deepEqual(secure.server.https, { cert: 'c', key: 'k' });
  assert.deepEqual(secure.server.allowedHosts, plain.server.allowedHosts);
  assert.ok(secure.server.fs.deny.includes('*.{crt,pem,key}'));
});
