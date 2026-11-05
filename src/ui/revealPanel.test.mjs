import assert from 'node:assert/strict';
import test from 'node:test';
import { StyleManager } from './applicationShell.js';

test('revealing a panel opens its phone sheet and scrolls the panel into view', () => {
  const sheets = [];
  const scrolls = [];
  const panel = { scrollIntoView: (options) => scrolls.push(options) };
  const saved = globalThis.document;
  globalThis.document = {
    getElementById: (id) => (id === 'street-level-panel' ? panel : null),
  };
  try {
    StyleManager.prototype.revealPanel.call(
      { _mobileShell: { setSheet: (sheet) => sheets.push(sheet) } },
      'street-level-panel',
    );
  } finally {
    globalThis.document = saved;
  }
  assert.deepEqual(sheets, ['cameras']);
  // The panel sits below the sheet's first screen at 375×812.
  assert.deepEqual(scrolls, [{ block: 'nearest' }]);
});
