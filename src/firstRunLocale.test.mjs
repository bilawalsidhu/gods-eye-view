import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRST_RUN_PT_BR,
  FIRST_RUN_PT_BR_BUSY,
  isPortugueseLocale,
  localizeFirstRun,
} from './firstRunLocale.js';

test('Portuguese regional variants use pt-BR copy; other locales preserve English', () => {
  assert.equal(isPortugueseLocale('pt-BR'), true);
  assert.equal(isPortugueseLocale('pt-PT'), true);
  assert.equal(isPortugueseLocale('en-US'), false);
  assert.equal(isPortugueseLocale('ptfoo'), false);
});

test('localization updates copy without changing mission controls', () => {
  const elements = new Map(
    Object.keys(FIRST_RUN_PT_BR).map((selector) => [
      selector,
      { textContent: 'English' },
    ]),
  );
  const attributes = new Map();
  const root = {
    querySelector: (selector) => elements.get(selector),
    setAttribute: (key, value) => attributes.set(key, value),
  };
  assert.equal(localizeFirstRun(root, 'en-US'), false);
  assert.equal(elements.get('#first-run-title').textContent, 'English');
  assert.equal(localizeFirstRun(root, 'pt-BR'), true);
  assert.equal(
    elements.get('#first-run-title').textContent,
    'Escolha sua primeira vista',
  );
  assert.equal(attributes.get('lang'), 'pt-BR');
  assert.ok(FIRST_RUN_PT_BR_BUSY.environmental.includes('eventos'));
});
