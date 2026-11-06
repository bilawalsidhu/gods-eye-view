import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { StyleManager } from './applicationShell.js';

test('Sky mount failure does not log its exception or credentials', async () => {
  const previousDocument = globalThis.document;
  const previousWarn = console.warn;
  const logs = [];
  let resolveWarning;
  let timer;
  const warning = new Promise((resolve) => { resolveWarning = resolve; });
  const secret = 'Bearer synthetic-key-SECRETKEY123 https://user:pass@host/?api_key=SECRETKEY123';
  const failure = new Error(secret, { cause: new Error(secret) });
  failure.name = secret;
  globalThis.document = {
    createElement() { throw failure; },
    body: { append() {}, classList: { add() {}, remove() {} } },
    defaultView: null,
  };
  console.warn = (...args) => { logs.push(inspect(args, { depth: 8 })); resolveWarning(); };
  try {
    StyleManager.prototype._initSkyView.call({
      _disposed: false,
      viewer: { camera: { position: {} }, scene: { canvas: {} }, container: { append() {} } },
      _lifetime: null,
      _navigation: null,
      _showToast() {},
    });
    await Promise.race([warning, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Sky warning did not arrive')), 5000); })]);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Sky.*view unavailable/);
    assert.doesNotMatch(logs[0], /SECRETKEY123|user:pass|Bearer/);
  } finally {
    clearTimeout(timer);
    console.warn = previousWarn;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
