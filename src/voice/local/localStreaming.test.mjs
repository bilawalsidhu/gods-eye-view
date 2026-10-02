import test from 'node:test';
import assert from 'node:assert/strict';

import { createMarkupFilter } from './gemmaToolCalls.js';
import { createSentenceSplitter } from './speechText.js';

function speak(chunks) {
  const filter = createMarkupFilter();
  const splitter = createSentenceSplitter({ minChars: 4 });
  const spoken = [];
  for (const chunk of chunks) spoken.push(...splitter.push(filter.push(chunk)));
  spoken.push(...splitter.push(filter.flush()), ...splitter.flush());
  return spoken;
}

test('streamed answers keep the spaces between chunks', () => {
  assert.deepEqual(speak(['There', ' are', ' twelve', ' aircraft', '.']), [
    'There are twelve aircraft.',
  ]);
});

test('markup split across chunks never reaches speech', () => {
  assert.deepEqual(
    speak([
      'Twelve',
      ' found. <|tool_',
      'call>call:x{a:<|"|>b<|"|>}<tool_',
      'call|> Done',
      '<tu',
      'rn|>',
    ]),
    ['Twelve found.', 'Done'],
  );
});

test('an unclosed region is dropped and stray angle brackets survive', () => {
  const filter = createMarkupFilter();
  assert.equal(filter.push('Hi <|channel>thinking'), 'Hi ');
  assert.equal(filter.flush(), '');
  const text = createMarkupFilter();
  assert.equal(text.push('a < b and c <'), 'a < b and c ');
  assert.equal(text.flush(), '<');
});
