// The receiver's messages follow a language switch while anyone listens,
// reach a later listener in the current language, and stop following once
// the controller is destroyed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, t } from '../i18n/index.js';
import { SdrController } from './controller.js';

const UNAVAILABLE = 'WebUSB is unavailable in this browser';

test('a listener hears the message worded again after a switch', () => {
  const c = new SdrController({ storage: null, webUsb: null });
  const seen = [];
  const off = c.subscribe((state) => seen.push(state.message));
  try {
    setLocale('es');
    assert.equal(seen.at(-1), t(UNAVAILABLE));
    assert.notEqual(seen.at(-1), UNAVAILABLE);
  } finally {
    off();
    setLocale('en');
  }
});

test('a listener that subscribes after a switch gets the current language', () => {
  const c = new SdrController({ storage: null, webUsb: null });
  c.subscribe(() => {})();
  setLocale('ru');
  try {
    let first;
    const off = c.subscribe((state) => (first ??= state.message));
    off();
    assert.equal(first, t(UNAVAILABLE));
  } finally {
    setLocale('en');
  }
});

test('a destroyed controller no longer follows the language', async () => {
  const c = new SdrController({ storage: null, webUsb: null });
  c.subscribe(() => {});
  await c.destroy();
  let reworded = 0;
  c._reword = () => reworded++;
  setLocale('es');
  setLocale('en');
  assert.equal(reworded, 0);
});
