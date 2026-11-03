// The «{publisher} / OPEN» line is drawn on a canvas, so CSS cannot wrap it:
// a long translation shrinks to fit the portrait card, action word whole.
// English is drawn at full size.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { setLocale } from '../i18n/index.js';
import { evidenceCardLayout, updateEvidenceFrame } from './bhoteKoshiEvent.js';

const eventUrl = new URL(
  '../../public/events/bhote-koshi-2026/event.json',
  import.meta.url,
);

// JetBrains Mono advances every glyph by 0.6 em.
const fontPx = (font) => Number(/(\d+(?:\.\d+)?)px/.exec(font)[1]);
const measure = (text, font) => text.length * 0.6 * fontPx(font);

function drawSourceLine(observation, publisher) {
  const layout = evidenceCardLayout(observation);
  const drawn = [];
  const context = {
    font: '',
    beginPath() {},
    clearRect() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fillRect() {},
    drawImage() {},
    measureText(text) {
      return { width: measure(String(text), this.font) };
    },
    fillText(value, x) {
      drawn.push({ text: String(value), font: this.font, x });
    },
  };
  const canvas = {
    width: layout.canvasWidth,
    height: layout.canvasHeight,
    _bhoteEvidenceLayout: layout,
    getContext: () => context,
  };
  const subject = publisher
    ? { ...observation, media: { ...observation.media, publisher } }
    : observation;
  assert.equal(updateEvidenceFrame(canvas, subject), true);
  const line = drawn.find((entry) => entry.text.includes(' / '));
  assert.ok(line, 'source line drawn');
  return { ...line, maxWidth: layout.canvasWidth - 32 };
}

async function portraitObservations() {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const portrait = event.evidenceSpine.filter(
    (o) => evidenceCardLayout(o).kind === 'portrait',
  );
  const youtube = portrait.find((o) => o.media?.publisher === 'YouTube source');
  const facebook = portrait.find(
    (o) => o.media?.publisher === 'Facebook source',
  );
  assert.ok(youtube, 'a portrait YouTube card exists');
  return [youtube, facebook].filter(Boolean);
}

test('English source lines draw unchanged on every card', async () => {
  setLocale('en');
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  for (const observation of event.evidenceSpine) {
    const line = drawSourceLine(observation);
    assert.equal(fontPx(line.font), 21, `${observation.id}: font kept`);
    assert.match(
      line.text,
      /^(YOUTUBE|FACEBOOK) SOURCE \/ OPEN$|^SOURCE LINK \/ OPEN$/,
    );
  }
});

test('ru/es source lines fit the portrait card with the action word whole', async () => {
  const observations = await portraitObservations();
  try {
    for (const [locale, action] of [
      ['ru', '/ ОТКРЫТЬ'],
      ['es', '/ ABRIR'],
    ]) {
      setLocale(locale);
      for (const observation of observations) {
        const line = drawSourceLine(observation);
        assert.ok(line.text.endsWith(action), `${locale}: ${line.text}`);
        assert.ok(
          measure(line.text, line.font) <= line.maxWidth,
          `${locale}: «${line.text}» at ${line.font} overflows`,
        );
        assert.ok(fontPx(line.font) >= 21 * 0.8, 'font stays readable');
      }
    }
    setLocale('ru');
    const ru = drawSourceLine(observations[0]);
    assert.equal(ru.text, 'ИСТОЧНИК YOUTUBE / ОТКРЫТЬ', 'publisher kept whole');
  } finally {
    setLocale('en');
  }
});

test('a publisher too long even at the smallest font is shortened, not the action', async () => {
  const [observation] = await portraitObservations();
  try {
    setLocale('ru');
    const line = drawSourceLine(
      observation,
      'A very long regional broadcaster',
    );
    assert.ok(line.text.endsWith('... / ОТКРЫТЬ'), line.text);
    assert.ok(measure(line.text, line.font) <= line.maxWidth, line.text);
    assert.equal(fontPx(line.font), 21 * 0.8);
  } finally {
    setLocale('en');
  }
});
