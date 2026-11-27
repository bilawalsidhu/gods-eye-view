import test from 'node:test';
import assert from 'node:assert/strict';
import { bindChatAttachments } from './chatAttachments.js';

// The card's Ask icon attaches the picked item to the chat draft; nothing is
// sent until the person writes and sends.
function fakeUi() {
  const handlers = new Map();
  const state = { chat: { attachMenuOpen: false, attachments: [] } };
  const focused = [];
  return {
    state,
    focused,
    on: (name, fn) => (handlers.set(name, fn), () => handlers.delete(name)),
    emit: (name, value) => handlers.get(name)?.(value),
    update: (key, patch) => Object.assign(state[key], patch),
    focus: async (ids) => focused.push(...ids),
    element: () => null,
  };
}

test('chat-item attaches the picked item once, as data, and focuses the input', () => {
  const ui = fakeUi();
  const attachments = bindChatAttachments({
    ui,
    dataManager: null,
    onChange() {},
    setStatus() {},
  });
  ui.emit('chat-item', {
    key: 'flights:a1',
    name: 'UAL649',
    itemKind: 'aircraft',
    layer: 'Live Flights',
    resolveLocation: () => ({ lat: 30.123, lon: -97.7 }),
  });
  ui.emit('chat-item', {
    key: 'flights:a1',
    name: 'UAL649',
    itemKind: 'aircraft',
    layer: 'Live Flights',
    resolveLocation: () => ({ lat: 30.123, lon: -97.7 }),
  });
  assert.deepEqual(ui.state.chat.attachments, [
    { key: 'item:flights:a1', name: 'UAL649' },
  ]);
  assert.deepEqual(attachments.snapshot({ resolveLocations: true }), [
    {
      kind: 'map-item',
      name: 'UAL649',
      itemKind: 'aircraft',
      layer: 'Live Flights',
      lat: 30.123,
      lon: -97.7,
    },
  ]);
  assert.deepEqual(ui.focused, ['chatInput', 'chatInput']);
});

test('an attached item’s text drops bidi and zero-width format characters', () => {
  const ui = fakeUi();
  const attachments = bindChatAttachments({
    ui,
    dataManager: null,
    onChange() {},
    setStatus() {},
  });
  ui.emit('chat-item', {
    key: 'ais:1',
    name: 'EVER\u202e\u200bGIV\u061cEN\u180e\u2066',
    itemKind: 'vessel\u200d',
    layer: 'Live\nVessels',
  });
  const [item] = attachments.snapshot({ resolveLocations: true });
  assert.equal(item.name, 'EVERGIVEN');
  assert.equal(item.itemKind, 'vessel');
  assert.equal(item.layer, 'Live Vessels');
});

test('an item asked about during a reply joins the draft once the reply ends', () => {
  const ui = fakeUi();
  const attachments = bindChatAttachments({
    ui,
    onChange() {},
    setStatus: assert.fail,
  });
  attachments.setLocked(true);
  const item = {
    key: 'flights:a1',
    name: 'UAL649',
    itemKind: 'aircraft',
    layer: 'Live Flights',
  };
  ui.emit('chat-item', item);
  ui.emit('chat-item', item);
  assert.deepEqual(attachments.snapshot({ resolveLocations: true }), []);
  attachments.clear();
  attachments.setLocked(false);
  assert.deepEqual(attachments.snapshot({ resolveLocations: true }), [
    {
      kind: 'map-item',
      name: 'UAL649',
      itemKind: 'aircraft',
      layer: 'Live Flights',
    },
  ]);
  assert.deepEqual(ui.state.chat.attachments, [
    { key: 'item:flights:a1', name: 'UAL649' },
  ]);
  assert.deepEqual(ui.focused, []);
});

test('duplicate unnamed items use draft order without sending private keys', () => {
  const ui = fakeUi();
  const attachments = bindChatAttachments({
    ui,
    onChange() {},
    setStatus: assert.fail,
  });
  for (const key of ['private-a', 'private-b']) {
    ui.emit('chat-item', {
      key,
      name: '',
      itemKind: 'event',
      layer: 'Public events',
    });
  }
  const sent = attachments.snapshot({ resolveLocations: true });
  assert.deepEqual(
    sent.map((item) => item.attachmentNumber),
    [1, 2],
  );
  assert.equal(sent[0].name, sent[1].name);
  assert.doesNotMatch(JSON.stringify(sent), /private-/);
});

test('a same-item public title is sanitized only when sending', () => {
  const ui = fakeUi();
  const attachments = bindChatAttachments({
    ui,
    onChange() {},
    setStatus: assert.fail,
  });
  ui.emit('chat-item', {
    key: 'internal-a',
    name: 'Original event',
    itemKind: 'event',
    layer: 'Earthquakes',
    resolveLocation: () => ({ name: 'Updated\u202eevent', lat: 1, lon: 2 }),
  });
  assert.equal(attachments.snapshot()[0].name, 'Original event');
  assert.equal(
    attachments.snapshot({ resolveLocations: true })[0].name,
    'Updatedevent',
  );
});
