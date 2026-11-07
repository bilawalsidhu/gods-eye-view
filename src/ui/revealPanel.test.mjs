import assert from 'node:assert/strict';
import test from 'node:test';
import { StyleManager } from './applicationShell.js';

function reveal({ phone }) {
  const sheets = [];
  const scrolls = [];
  const panel = { scrollIntoView: (options) => scrolls.push(options) };
  const saved = globalThis.document;
  const savedMatchMedia = globalThis.matchMedia;
  globalThis.document = {
    getElementById: (id) => (id === 'street-level-panel' ? panel : null),
  };
  globalThis.matchMedia = (query) => ({
    matches: phone && query === '(max-width: 720px)',
  });
  try {
    StyleManager.prototype.revealPanel.call(
      { _mobileShell: { setSheet: (sheet) => sheets.push(sheet) } },
      'street-level-panel',
    );
  } finally {
    globalThis.document = saved;
    globalThis.matchMedia = savedMatchMedia;
  }
  return { sheets, scrolls };
}

test('revealing a panel opens its phone sheet and scrolls the panel into view', () => {
  const { sheets, scrolls } = reveal({ phone: true });
  assert.deepEqual(sheets, ['cameras']);
  // The panel sits below the sheet's first screen at 375×812.
  assert.deepEqual(scrolls, [{ block: 'nearest' }]);
});

test('revealing a panel above 720px neither opens a sheet nor scrolls the rail', () => {
  assert.deepEqual(reveal({ phone: false }), { sheets: [], scrolls: [] });
});
