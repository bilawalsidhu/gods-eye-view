import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isTrustedOrigin,
  rejectUpgrade,
} from '../../server/providers/ollama/origin.js';

const req = (headers) => ({ headers });

test('loopback pages and non-browser clients are admitted', () => {
  const host = 'localhost';
  assert.equal(
    isTrustedOrigin(req({ host: 'localhost:4173' }), { host }),
    true,
  );
  assert.equal(
    isTrustedOrigin(
      req({ host: 'localhost:4173', origin: 'http://localhost:4173' }),
      { host },
    ),
    true,
  );
  assert.equal(
    isTrustedOrigin(
      req({ host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' }),
      { host },
    ),
    true,
  );
  assert.equal(
    isTrustedOrigin(
      req({ host: 'globe.local:4173', origin: 'https://globe.local:4173' }),
      { host },
    ),
    true,
  );
  // Unit tests and HTTP/1.0 clients may carry no headers at all.
  assert.equal(isTrustedOrigin({}, { host }), true);
  assert.equal(isTrustedOrigin(undefined, { host }), true);
});

test('cross-site pages and rebound hosts are refused on a localhost bind', () => {
  const host = 'localhost';
  // Cross-site WebSocket hijack: a foreign page talking to localhost.
  assert.equal(
    isTrustedOrigin(
      req({ host: 'localhost:4173', origin: 'https://evil.example' }),
      { host },
    ),
    false,
  );
  // DNS rebinding: the browser believes evil.example is this server.
  assert.equal(
    isTrustedOrigin(
      req({ host: 'evil.example:4173', origin: 'http://evil.example:4173' }),
      { host },
    ),
    false,
  );
  assert.equal(
    isTrustedOrigin(req({ host: 'localhost:4173', origin: 'null' }), { host }),
    false,
  );
  assert.equal(
    isTrustedOrigin(req({ host: 'localhost:4173', origin: '' }), { host }),
    false,
  );
});

test('a LAN bind admits same-origin pages from any host but still no cross-site ones', () => {
  const host = '0.0.0.0';
  assert.equal(
    isTrustedOrigin(
      req({ host: '192.168.1.20:4173', origin: 'http://192.168.1.20:4173' }),
      { host },
    ),
    true,
  );
  assert.equal(
    isTrustedOrigin(
      req({ host: '192.168.1.20:4173', origin: 'http://evil.example' }),
      { host },
    ),
    false,
  );
  // A specific bind address is itself a local name.
  assert.equal(
    isTrustedOrigin(
      req({ host: '192.168.1.20:4173', origin: 'http://192.168.1.20:4173' }),
      { host: '192.168.1.20' },
    ),
    true,
  );
  assert.equal(
    isTrustedOrigin(req({ host: '192.168.1.21:4173' }), {
      host: '192.168.1.20',
    }),
    false,
  );
});

test('rejectUpgrade answers 403 and destroys the socket', () => {
  const written = [];
  let destroyed = false;
  rejectUpgrade({
    write: (chunk) => written.push(chunk),
    destroy: () => {
      destroyed = true;
    },
  });
  assert.match(written.join(''), /^HTTP\/1\.1 403 Forbidden/);
  assert.equal(destroyed, true);
  // A socket that is already gone must not throw.
  rejectUpgrade({
    write() {
      throw new Error('EPIPE');
    },
    destroy() {},
  });
});
