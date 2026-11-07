import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The publisher on the evidence frame ("YouTube source") is pack text shown
// in the UI language; English stays "YOUTUBE SOURCE / OPEN".
import { setLocale } from '../i18n/index.js';
import { createEvidenceFrame } from './bhoteKoshiEvent.js';

const eventUrl = new URL(
  '../../public/events/bhote-koshi-2026/event.json',
  import.meta.url,
);

function captureFrameText(observation) {
  const originalDocument = globalThis.document;
  const text = [];
  globalThis.document = {
    createElement() {
      const context = {
        beginPath() {},
        clearRect() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
        fillRect() {},
        fillText(value) {
          text.push(String(value));
        },
        drawImage() {},
      };
      return { width: 0, height: 0, getContext: () => context };
    },
  };
  try {
    assert.ok(createEvidenceFrame(observation));
  } finally {
    globalThis.document = originalDocument;
  }
  return text;
}

test('evidence card source line is fully in the UI language (es, ru)', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const youtube = event.evidenceSpine.find(
    (o) => o.media?.publisher === 'YouTube source',
  );
  const facebook = event.evidenceSpine.find(
    (o) => o.media?.publisher === 'Facebook source',
  );
  assert.ok(youtube && facebook);
  try {
    for (const locale of ['es', 'ru']) {
      setLocale(locale);
      for (const observation of [youtube, facebook]) {
        const lines = captureFrameText(observation);
        const sourceLine = lines.find((line) => line.includes(' / '));
        assert.ok(sourceLine, 'source line drawn');
        assert.doesNotMatch(
          sourceLine,
          /SOURCE/,
          `${locale}: English "SOURCE" left in "${sourceLine}"`,
        );
      }
    }
  } finally {
    setLocale('en');
  }
});

test('evidence card source line keeps its English wording', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const youtube = event.evidenceSpine.find(
    (o) => o.media?.publisher === 'YouTube source',
  );
  setLocale('en');
  const sourceLine = captureFrameText(youtube).find((line) =>
    line.includes(' / '),
  );
  assert.equal(sourceLine, 'YOUTUBE SOURCE / OPEN');
});
