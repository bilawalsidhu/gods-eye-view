import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../testSupport/geminiNativeHarness.mjs';

const caption = (socket, text) =>
  socket.message({ serverContent: { inputTranscription: { text } } });
const userEvents = (events) =>
  events.filter(
    (event) => event.type === 'transcript' && event.role === 'user',
  );

test('native caption events preserve received advisory segments without granting tool authority', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    const start = h.events.length;
    for (const text of ['little. ', 'Zoom in a ']) caption(ws, text);
    const received = userEvents(h.events.slice(start));
    assert.deepEqual(
      received.map((event) => event.text),
      ['little. ', 'Zoom in a '],
    );
    assert.equal(
      received.every(
        (event) =>
          event.delta === true &&
          event.final === false &&
          event.attribution === 'unverified' &&
          event.responseId === null,
      ),
      true,
    );
    assert.equal(h.c.currentTypedInput(), null);
    ws.message({
      toolCall: {
        functionCalls: [
          {
            id: 'ordinary-native',
            name: 'get_current_view_state',
            args: {},
          },
        ],
      },
    });
    await h.c.toolQueue;
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].options.userTurn, undefined);
    assert.equal(h.calls[0].options.isCurrent(), true);
    ws.message({ serverContent: { turnComplete: true } });
    assert.equal(
      userEvents(h.events.slice(start)).some((event) => event.final),
      false,
    );
  } finally {
    h.c.stop();
  }
  assert.equal(h.timers.size, 0);
});

test('native old socket captions cannot enter a restarted controller event stream', async () => {
  const h = harness();
  try {
    await h.c.start();
    const old = h.sockets[0];
    caption(old, 'old partial');
    h.c.stop();
    await h.c.start();
    const start = h.events.length;
    const current = h.sockets[1];
    caption(current, 'Zoom ');
    caption(old, 'stale old socket');
    caption(current, 'in a little.');
    current.message({ serverContent: { turnComplete: true } });
    assert.deepEqual(
      userEvents(h.events.slice(start)).map((event) => event.text),
      ['Zoom ', 'in a little.'],
    );
    assert.equal(h.tracks[0].readyState, 'ended');
    assert.equal(h.captures[0].closed, true);
  } finally {
    h.c.stop();
  }
  assert.equal(h.timers.size, 0);
});
