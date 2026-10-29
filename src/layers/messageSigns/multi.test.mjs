import test from 'node:test';
import assert from 'node:assert/strict';
import { cardLines, parseMultiText, spokenText } from './multi.js';

const labels = {
  pageLabel: (n, total) => `Page ${n} of ${total}`,
  graphicOnly: 'Graphic only',
};

test('a travel-time message keeps its rows and columns', () => {
  const parsed = parseMultiText(
    'FREEWAY TIME TO[nl][jl2]I-394       7 MI [jl4]10 MIN',
  );
  assert.deepEqual(parsed.pages, [['FREEWAY TIME TO', 'I-394  7 MI  10 MIN']]);
  assert.equal(parsed.hasGraphic, false);
  assert.equal(parsed.visibleChars, 'FREEWAYTIMETOI-3947MI10MIN'.length);
});

test('plain lines join with commas when spoken', () => {
  const parsed = parseMultiText('RAMP CONGESTED[nl]AT 25TH AVE[nl]USE CAUTION');
  assert.deepEqual(parsed.pages, [
    ['RAMP CONGESTED', 'AT 25TH AVE', 'USE CAUTION'],
  ]);
  assert.equal(
    spokenText(parsed, labels),
    'RAMP CONGESTED, AT 25TH AVE, USE CAUTION',
  );
});

test('an express-lane message drops every tag and records its graphic', () => {
  const parsed = parseMultiText(
    '[cr1,1,240,24,1,23,9][cf250,250,250][fo16][tr1,5,240,18][jl3]EXPRESS LANE' +
      '[g11,1,41][cr1,75,240,2,255,255,255][tr80,31,155,40][jl2]I-694[jl4]$1.25' +
      '[nl6][jl2]CTY J[jl4]$1.75[tr1,79,240,17][jl3]HOV 2+ FREE',
  );
  assert.deepEqual(parsed.pages, [
    ['EXPRESS LANE', 'I-694  $1.25', 'CTY J  $1.75', 'HOV 2+ FREE'],
  ]);
  assert.equal(parsed.hasGraphic, true);
});

test('pages split on np and are numbered on the card', () => {
  const parsed = parseMultiText('[pt30o0]SLOW TRAFFIC AHEAD[np]USE CAUTION');
  assert.deepEqual(parsed.pages, [['SLOW TRAFFIC AHEAD'], ['USE CAUTION']]);
  assert.deepEqual(cardLines(parsed, labels), [
    'Page 1 of 2',
    'SLOW TRAFFIC AHEAD',
    'Page 2 of 2',
    'USE CAUTION',
  ]);
  assert.equal(
    spokenText(parsed, labels),
    'Page 1 of 2: SLOW TRAFFIC AHEAD. Page 2 of 2: USE CAUTION',
  );
});

test('a page that repeats the previous one is read once', () => {
  // Flashing messages repeat their text on each page; only graphics move.
  const parsed = parseMultiText(
    '[pt10o]STOPPED TRAFFIC AHEAD[g9,45,3][np]STOPPED TRAFFIC AHEAD[g25,369,3]',
  );
  assert.deepEqual(parsed.pages, [['STOPPED TRAFFIC AHEAD']]);
  assert.deepEqual(cardLines(parsed, labels), ['STOPPED TRAFFIC AHEAD']);
});

test('a tags-only message is blank and a graphic-only one is not', () => {
  const blank = parseMultiText('[jl3][nl][pt10o]');
  assert.equal(blank.visibleChars, 0);
  assert.equal(blank.hasGraphic, false);
  assert.deepEqual(blank.pages, []);
  assert.deepEqual(cardLines(blank, labels), []);
  assert.equal(spokenText(blank, labels), '');

  const graphic = parseMultiText('[g1,8,1]');
  assert.equal(graphic.visibleChars, 0);
  assert.equal(graphic.hasGraphic, true);
  assert.deepEqual(cardLines(graphic, labels), ['Graphic only']);
  assert.equal(spokenText(graphic, labels), 'Graphic only');
});

test('empty, null and non-string input give no pages', () => {
  for (const input of ['', null, undefined, 42, {}]) {
    const parsed = parseMultiText(input);
    assert.deepEqual(parsed.pages, []);
    assert.equal(parsed.visibleChars, 0);
  }
});

test('unknown, spacing and malformed tags never throw', () => {
  assert.deepEqual(parseMultiText('A[xyz]B[nl6]C').pages, [['AB', 'C']]);
  assert.deepEqual(parseMultiText('LEFT[nl').pages, [['LEFT']]);
  assert.deepEqual(parseMultiText('A]B').pages, [['A]B']]);
  assert.deepEqual(parseMultiText('[[ESC]]').pages, [['[ESC]']]);
});

test('control and bidi characters are stripped', () => {
  const parsed = parseMultiText('EXIT\u202e 12\u0007[nl]\u2066OPEN\u2069');
  assert.deepEqual(parsed.pages, [['EXIT 12', 'OPEN']]);
});

test('pages, lines and line length are capped', () => {
  const many = Array.from({ length: 12 }, (_, i) => `P${i}`).join('[np]');
  assert.equal(parseMultiText(many).pages.length, 8);
  const tall = Array.from({ length: 12 }, (_, i) => `L${i}`).join('[nl]');
  assert.equal(parseMultiText(tall).pages[0].length, 8);
  const wide = parseMultiText('X'.repeat(200));
  assert.equal(wide.pages[0][0].length, 64);
});

test('a very long message stays inside the card bounds', () => {
  const words = Array.from({ length: 20 }, (_, i) => `WORD${i}`).join(' ');
  const parsed = parseMultiText(
    Array.from({ length: 8 }, () => words).join('[nl]'),
  );
  const lines = cardLines(parsed, labels);
  assert.equal(lines.length, 12);
  assert.ok(lines.every((line) => line.length <= 44));
  assert.ok(lines.at(-1).endsWith('…'));
});

test('a word longer than the card is split at the card width', () => {
  assert.deepEqual(cardLines(parseMultiText('X'.repeat(64)), labels), [
    'X'.repeat(44),
    'X'.repeat(20),
  ]);
  const lines = cardLines(parseMultiText(`AB ${'Y'.repeat(60)}`), labels);
  assert.deepEqual(lines, ['AB', 'Y'.repeat(44), 'Y'.repeat(16)]);
  assert.ok(lines.every((line) => line.length <= 44));
});

test('raw input past the cap is read only up to the cap', () => {
  const parsed = parseMultiText(`${'A'.repeat(5000)}[np]TAIL`);
  assert.equal(parsed.pages.length, 1);
});
