// The message-sign card follows the UI language around MnDOT's own text,
// which stays as MnDOT wrote it. cards.test.mjs pins the English card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, tn } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import { sourceLabel } from '../../ui/layerNames.js';
import { buildSignCard } from './cards.js';

test('es: card labels translate; location and message do not', () => {
  setLocale('es');
  try {
    const card = buildSignCard(
      {
        location: 'I-35W NB @ 40th St',
        multi: 'SLOW TRAFFIC AHEAD[np]USE CAUTION',
      },
      { ageMs: 185_000, stale: true },
    );
    assert.equal(card.title, 'PANEL · I-35W NB @ 40th St');
    assert.deepEqual(card.details, [
      'Página 1 de 2',
      'SLOW TRAFFIC AHEAD',
      'Página 2 de 2',
      'USE CAUTION',
      'DESACTUALIZADO · datos de MnDOT hace 3 minutos',
    ]);
    assert.match(card.spoken, /^Panel de mensajes, I-35W NB @ 40th St\. /);
    assert.equal(
      buildSignCard(
        { location: 'I-94 WB', multi: '[g1,8,1]' },
        { ageMs: 0, stale: false },
      ).details[0],
      'Solo gráfico',
    );
    assert.equal(
      tn(3, '{count} sign lit', '{count} signs lit'),
      '3 paneles encendidos',
    );
    assert.equal(
      sourceLabel('MnDOT · Minnesota only'),
      'MnDOT · solo Minnesota',
    );
    assert.equal(translateFeedError('MnDOT HTTP 502'), 'MnDOT: HTTP 502');
  } finally {
    setLocale('en');
  }
});

test('ru: the lit count takes its plural forms', () => {
  setLocale('ru');
  try {
    assert.equal(
      tn(1, '{count} sign lit', '{count} signs lit'),
      '1 табло горит',
    );
    assert.equal(
      tn(3, '{count} sign lit', '{count} signs lit'),
      '3 табло горят',
    );
    assert.equal(
      tn(5, '{count} sign lit', '{count} signs lit'),
      '5 табло горят',
    );
  } finally {
    setLocale('en');
  }
});
