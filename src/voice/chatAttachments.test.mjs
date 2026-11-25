// src/voice/chatAttachments.test.mjs — the chat's draft attachments: what
// they accept and refuse, and how their menu closes.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindChatAttachments } from './chatAttachments.js';
import { createTestVoiceUi } from '../testSupport/voiceUi.mjs';
import { mountVoiceView } from '../testSupport/voiceView.mjs';

const $ = (selector) => document.querySelector(selector);

function layers(count) {
  return new Map(
    Array.from({ length: count }, (_, index) => [
      `layer-${index + 1}`,
      { module: { name: `Layer ${index + 1}` } },
    ]),
  );
}

function attachments(t, { ui = createTestVoiceUi({ panel: true }) } = {}) {
  const statuses = [];
  const bound = bindChatAttachments({
    ui,
    dataManager: { layers: layers(6), isEnabled: () => true },
    onChange() {},
    setStatus: (text) => statuses.push(text),
  });
  t.after(() => bound.destroy());
  const names = () => ui.state.chat.attachments.map((item) => item.name);
  // The file input as the view hands it over; the reading is asynchronous.
  const choose = async (...files) => {
    const input = { files, value: 'C:\\fakepath\\file' };
    ui.emit('chat-files', input);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    return input;
  };
  return { ui, bound, statuses, names, choose };
}

const file = (name, content) => new File([content], name);

test('a fifth attachment is refused: the limit is four', (t) => {
  const { ui, statuses, names } = attachments(t);
  for (let i = 1; i <= 4; i++) ui.emit('chat-layer', `layer-${i}`);
  assert.deepEqual(names(), ['Layer 1', 'Layer 2', 'Layer 3', 'Layer 4']);
  assert.deepEqual(statuses, []);
  ui.emit('chat-layer', 'layer-5');
  assert.equal(names().length, 4);
  assert.deepEqual(statuses, ['You can attach up to four items.']);
  // Choosing an attached layer again replaces it and is not a fifth.
  ui.emit('chat-layer', 'layer-2');
  assert.equal(names().length, 4);
  assert.equal(statuses.length, 1);
});

test('a 10,001-byte file is refused: each file may be up to 10 KB', async (t) => {
  const { statuses, names, choose } = attachments(t);
  const input = await choose(file('big.txt', 'a'.repeat(10001)));
  assert.deepEqual(names(), []);
  assert.deepEqual(statuses, ['Each file must be 10 KB or smaller.']);
  // The input clears so the same file can be chosen again.
  assert.equal(input.value, '');
  await choose(file('notes.txt', 'a'.repeat(9000)));
  assert.deepEqual(names(), ['notes.txt']);
  assert.equal(statuses.length, 1);
});

test('only text file types are accepted', async (t) => {
  const { statuses, names, choose } = attachments(t);
  await choose(file('setup.exe', 'MZ'));
  assert.deepEqual(names(), []);
  assert.deepEqual(statuses, [
    'Choose a TXT, Markdown, CSV, JSON or GeoJSON file.',
  ]);
  await choose(file('places.GeoJSON', '{"type":"FeatureCollection"}'));
  assert.deepEqual(names(), ['places.GeoJSON']);
});

test('a file that is not UTF-8 is refused in the person’s words', async (t) => {
  const { statuses, names, choose } = attachments(t);
  await choose(file('latin1.csv', new Uint8Array([0x63, 0x61, 0x66, 0xe9])));
  assert.deepEqual(names(), []);
  assert.deepEqual(statuses, ['Choose a non-empty UTF-8 text file.']);
});

test('control characters and empty files are refused; tabs and line breaks are text', async (t) => {
  const { statuses, names, choose } = attachments(t);
  await choose(file('binary.txt', 'name\u0001value'));
  await choose(file('blank.md', ' \n\t '));
  assert.deepEqual(names(), []);
  assert.deepEqual(statuses, [
    'Choose a non-empty UTF-8 text file.',
    'Choose a non-empty UTF-8 text file.',
  ]);
  await choose(file('table.csv', 'a\tb\r\nc\td\n'));
  assert.deepEqual(names(), ['table.csv']);
  assert.equal(statuses.length, 2);
});

test('attachments over 10 KB together are refused', async (t) => {
  const { statuses, names, choose } = attachments(t);
  await choose(file('one.txt', 'a'.repeat(6000)));
  await choose(file('two.txt', 'b'.repeat(6000)));
  assert.deepEqual(names(), ['one.txt']);
  assert.deepEqual(statuses, [
    'Attachments are too large together. Use smaller files.',
  ]);
});

test('the attach menu states the 10 KB limit for all attachments together', async (t) => {
  const { pinia, settle } = mountVoiceView(t);
  const ui = createTestVoiceUi({ panel: true, pinia });
  attachments(t, { ui });
  ui.update('chat', { open: true });
  await settle();
  const hint = $('#gev-chat-attach-menu > p').textContent;
  assert.match(hint, /up to 10 KB in total\./);
  assert.doesNotMatch(hint, /each/);
});

test('Escape closes the attach menu and returns to the Attach button', async (t) => {
  const { pinia, settle } = mountVoiceView(t);
  const ui = createTestVoiceUi({ panel: true, pinia });
  attachments(t, { ui });
  ui.update('chat', { open: true });
  await settle();
  $('#gev-chat-attach').click();
  await settle();
  assert.equal($('#gev-chat-attach-menu').hidden, false);
  assert.equal(document.activeElement?.id, 'gev-chat-layer');
  const escape = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  $('#gev-chat-layer').dispatchEvent(escape);
  await settle();
  assert.equal(escape.defaultPrevented, true);
  assert.equal($('#gev-chat-attach-menu').hidden, true);
  assert.equal(document.activeElement?.id, 'gev-chat-attach');
  // With the menu closed, Escape is left to whatever else handles it.
  const again = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  $('#gev-chat-attach').dispatchEvent(again);
  assert.equal(again.defaultPrevented, false);
});
