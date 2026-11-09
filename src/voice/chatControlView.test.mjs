// src/voice/chatControlView.test.mjs — the typed chat's owner and its view:
// the reply reveal, Stop, the attach menu's layer choice, the conversation's
// scrolling and what screen readers are told.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindChatControl } from './chatControl.js';
import { CLOUD_VOICE_AUTH_STORAGE_KEY } from './cloudVoiceAuth.js';
import { createTestVoiceUi } from '../testSupport/voiceUi.mjs';
import { mountVoiceView } from '../testSupport/voiceView.mjs';

const $ = (selector) => document.querySelector(selector);
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

// A typed session that connects at once and sends what it is given.
function typedSession({ cancelTurn = false } = {}) {
  const listeners = new Set();
  const session = {
    state: 'idle',
    sent: [],
    stops: 0,
    cancels: 0,
    adapter: {
      getStartOptions: () => ({ textOnly: true }),
      ...(cancelTurn && {
        cancelTurn() {
          session.cancels++;
        },
      }),
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(event) {
      for (const fn of [...listeners]) fn(event);
    },
    setState(state) {
      session.state = state;
      session.emit({ type: 'state', state });
    },
    isActive: () => !['idle', 'error'].includes(session.state),
    start() {
      session.setState('listening');
    },
    stop() {
      session.stops++;
      session.setState('idle');
    },
    sendText(text) {
      session.sent.push(text);
      return true;
    },
  };
  return session;
}

// Animation frames run only when the test steps them.
function manualFrames(t) {
  const original = {
    request: globalThis.requestAnimationFrame,
    cancel: globalThis.cancelAnimationFrame,
  };
  const queue = new Map();
  let next = 0;
  let time = 0;
  globalThis.requestAnimationFrame = (fn) => {
    queue.set(++next, fn);
    return next;
  };
  globalThis.cancelAnimationFrame = (id) => queue.delete(id);
  t.after(() => {
    globalThis.requestAnimationFrame = original.request;
    globalThis.cancelAnimationFrame = original.cancel;
  });
  return {
    get pending() {
      return queue.size;
    },
    step() {
      time += 16;
      const due = [...queue.values()];
      queue.clear();
      for (const fn of due) fn(time);
    },
  };
}

function chat(t, { pinia, session = typedSession(), dataManager } = {}) {
  const ui = createTestVoiceUi({ panel: true, pinia });
  const control = bindChatControl({ ui, session, dataManager });
  t.after(() => control.destroy());
  const send = async (text) => {
    ui.emit('chat-input', text);
    ui.emit('chat-submit');
    await flush();
  };
  const reply = (text, extra = {}) =>
    session.emit({
      type: 'transcript',
      role: 'assistant',
      itemId: 'reply-1',
      text,
      ...extra,
    });
  const texts = () => ui.chatMessages.map((m) => `${m.role}:${m.text}`);
  return { ui, session, control, send, reply, texts };
}

test('a revealed reply writes only the message list each frame', async (t) => {
  const frames = manualFrames(t);
  const { ui, send, reply, texts } = chat(t);
  ui.emit('chat-button');
  await send('Fly to Tokyo');
  assert.equal(ui.state.chat.miniReply, 'Thinking…');
  const text = 'Flying to Tokyo now. '.repeat(8).trim();
  reply(text, { final: true });
  assert.equal(ui.state.chat.revealing, true);
  const control = ui.state;
  const seen = new Set();
  for (let guard = 0; frames.pending; guard++) {
    if (guard > 200) assert.fail('the reveal did not finish');
    frames.step();
    if (!frames.pending) break;
    seen.add(texts().at(-1));
    // Mid-reveal the control itself is not republished.
    assert.equal(ui.state, control);
  }
  assert.ok(seen.size > 1, 'the reply revealed over several frames');
  assert.equal(texts().at(-1), `assistant:${text}`);
  // The minimized bar's reply and the log's busy state change once, at the end.
  assert.equal(ui.state.chat.revealing, false);
  assert.equal(ui.state.chat.miniReply, text);
});

test('Stop cancels only the reply in flight and keeps the conversation', async (t) => {
  manualFrames(t);
  const session = typedSession({ cancelTurn: true });
  const { ui, send, reply, texts } = chat(t, { session });
  ui.emit('chat-button');
  await send('Fly to Tokyo');
  reply('Flying');
  assert.equal(ui.state.chat.busy, true);
  ui.emit('chat-stop');
  assert.equal(session.cancels, 1);
  assert.equal(session.stops, 0);
  assert.equal(session.isActive(), true);
  assert.equal(ui.state.chat.busy, false);
  assert.equal(ui.state.chat.status, 'Reply stopped.');
  assert.equal(ui.state.chat.miniReply, 'Reply stopped.');
  assert.deepEqual(texts(), ['user:Fly to Tokyo', 'assistant:Flying']);
  // The cancelled turn's own end and late text keep the stop as it was.
  reply(' to Tokyo.');
  session.emit({ type: 'completion', status: 'cancelled' });
  assert.equal(ui.state.chat.status, 'Reply stopped.');
  assert.deepEqual(texts(), ['user:Fly to Tokyo', 'assistant:Flying']);
  // The same session takes the next message.
  await send('Show live flights');
  assert.equal(session.sent.length, 2);
  assert.equal(ui.state.chat.busy, true);
});

test('Stop ends the session when its adapter cannot cancel a turn', async (t) => {
  manualFrames(t);
  const { ui, session, send } = chat(t);
  ui.emit('chat-button');
  await send('Fly to Tokyo');
  ui.emit('chat-stop');
  assert.equal(session.stops, 1);
  assert.equal(ui.state.chat.busy, false);
  assert.equal(ui.state.chat.status, 'Reply stopped.');
});

test('with ChatGPT sign-in chosen for OpenAI voice, chat says it uses the API key', (t) => {
  t.after(() => localStorage.removeItem(CLOUD_VOICE_AUTH_STORAGE_KEY));
  const { ui } = chat(t);
  const note =
    'Typed chat uses your OpenAI API key. ChatGPT sign-in covers voice only.';
  ui.update('root', { provider: 'openai' });
  ui.emit('chat-button');
  assert.equal(ui.state.chat.authNote, '');
  ui.emit('chat-close');
  localStorage.setItem(CLOUD_VOICE_AUTH_STORAGE_KEY, 'oauth');
  ui.emit('chat-button');
  assert.equal(ui.state.chat.authNote, note);
  ui.emit('chat-close');
  ui.update('root', { provider: 'gemini' });
  ui.emit('chat-button');
  assert.equal(ui.state.chat.authNote, '');
});

test('the conversation is busy for screen readers while a reply types out', async (t) => {
  const frames = manualFrames(t);
  const { pinia, settle } = mountVoiceView(t);
  const { ui, session, send, reply } = chat(t, { pinia });
  ui.emit('chat-button');
  await settle();
  const log = $('#gev-chat-messages');
  const phase = $('#gev-assistant-phase');
  assert.equal(log.getAttribute('aria-busy'), null);
  // In chat, the chat's own status line is the one status region.
  assert.equal(phase.getAttribute('aria-hidden'), 'true');
  assert.equal(phase.getAttribute('aria-live'), 'off');
  await send('Fly to Tokyo');
  await settle();
  assert.equal(log.getAttribute('aria-busy'), 'true');
  reply('Flying to Tokyo now.', { final: true });
  session.emit({ type: 'completion', status: 'completed' });
  frames.step();
  await settle();
  // Done thinking, still typing out.
  assert.equal(ui.state.chat.busy, false);
  assert.equal(log.getAttribute('aria-busy'), 'true');
  while (frames.pending) frames.step();
  await settle();
  assert.equal(log.getAttribute('aria-busy'), null);
  ui.emit('chat-close');
  await settle();
  assert.equal(phase.getAttribute('aria-hidden'), null);
  assert.equal(phase.getAttribute('aria-live'), 'polite');
});

test('a layer attaches with the Attach button or Enter, not as the choice moves', async (t) => {
  const { pinia, settle } = mountVoiceView(t);
  const dataManager = {
    layers: new Map([
      ['flights', { module: { name: 'Live flights' } }],
      ['quakes', { module: { name: 'Earthquakes' } }],
    ]),
    isEnabled: () => true,
  };
  const { ui } = chat(t, { pinia, dataManager });
  ui.emit('chat-button');
  await settle();
  $('#gev-chat-attach').click();
  await settle();
  const select = $('#gev-chat-layer');
  const attach = $('#gev-chat-layer-attach');
  assert.equal(attach.disabled, true);
  // Arrow keys on a closed select change it once per press.
  for (const value of ['flights', 'quakes']) {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
  }
  assert.deepEqual(ui.state.chat.attachments, []);
  assert.equal(attach.disabled, false);
  attach.click();
  await settle();
  assert.deepEqual(
    ui.state.chat.attachments.map((item) => item.name),
    ['Earthquakes'],
  );
  $('#gev-chat-attach').click();
  await settle();
  select.value = 'flights';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  const enter = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  });
  select.dispatchEvent(enter);
  await settle();
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(
    ui.state.chat.attachments.map((item) => item.name),
    ['Earthquakes', 'Live flights'],
  );
});

test('the conversation follows new messages only while read at the bottom', async (t) => {
  const { pinia, settle } = mountVoiceView(t);
  const { ui } = chat(t, { pinia });
  ui.emit('chat-button');
  await settle();
  const list = $('#gev-chat-messages');
  let top = 0;
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 200 },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value) => {
        top = Math.min(value, 800);
      },
    },
  });
  const show = async (...messages) => {
    ui.setChatMessages(
      messages.map(([role, text], index) => ({ id: index + 1, role, text })),
    );
    await settle();
  };
  await show(['user', 'Fly to Tokyo'], ['assistant', 'Fly']);
  assert.equal(top, 800);
  // The reader scrolls up; the reply keeps typing out below them.
  top = 300;
  list.dispatchEvent(new Event('scroll'));
  await show(['user', 'Fly to Tokyo'], ['assistant', 'Flying to Tokyo.']);
  assert.equal(top, 300);
  // Sending brings them back to the newest message.
  await show(
    ['user', 'Fly to Tokyo'],
    ['assistant', 'Flying to Tokyo.'],
    ['user', 'Show live flights'],
  );
  assert.equal(top, 800);
  list.dispatchEvent(new Event('scroll'));
  await show(
    ['user', 'Fly to Tokyo'],
    ['assistant', 'Flying to Tokyo.'],
    ['user', 'Show live flights'],
    ['assistant', 'Showing'],
  );
  assert.equal(top, 800);
});

test('a message sent from higher up a full, capped log is still followed', async (t) => {
  manualFrames(t);
  const { pinia, settle } = mountVoiceView(t);
  const { ui, session, send, reply } = chat(t, { pinia });
  ui.emit('chat-button');
  for (let turn = 1; turn <= 30; turn++) {
    await send(`Request ${turn}`);
    reply(`Answer ${turn}`, { itemId: `reply-${turn}`, final: true });
    session.emit({ type: 'completion', status: 'completed' });
  }
  await settle();
  // The log keeps its newest 60 messages, so sending no longer lengthens it.
  assert.equal(ui.chatMessages.length, 60);
  const list = $('#gev-chat-messages');
  let top = 800;
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 200 },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value) => {
        top = Math.min(value, 800);
      },
    },
  });
  top = 300;
  list.dispatchEvent(new Event('scroll'));
  await send('Show live flights');
  await settle();
  assert.equal(ui.chatMessages.length, 60);
  assert.equal(ui.chatMessages.at(-1).text, 'Show live flights');
  assert.equal(top, 800, 'the new request is brought into view');
});

test('the chat gear is named for the settings it opens', async (t) => {
  const { pinia, settle } = mountVoiceView(t);
  const { ui } = chat(t, { pinia });
  ui.emit('chat-button');
  await settle();
  assert.equal(
    $('#gev-voice-settings-button').getAttribute('aria-label'),
    'Settings',
  );
});

test('a provider switch carries chat Settings to the next mount', async (t) => {
  const mount = () => {
    const ui = createTestVoiceUi({ panel: true });
    const chat = bindChatControl({ ui, session: typedSession() });
    t.after(() => chat.destroy());
    return { ui, chat };
  };
  // Chat's Settings: the next mount shows Settings in chat's frame again.
  const before = mount();
  before.ui.emit('chat-button');
  before.ui.update('voicePanel', { hidden: false });
  before.ui.emit('settings-button');
  before.ui.update('voicePanel', { frameWidth: 320, frameHeight: 480 });
  const settings = before.chat.presentation();
  assert.deepEqual(settings, {
    view: 'settings',
    frame: { width: 320, height: 480 },
  });
  const after = mount();
  after.chat.restorePresentation(settings);
  assert.equal(after.ui.state.voicePanel.context, 'chat');
  assert.equal(after.ui.state.voicePanel.frameWidth, 320);
  assert.equal(after.ui.state.voicePanel.frameHeight, 480);
  assert.equal(after.ui.state.chat.backVisible, true);
  assert.equal(after.ui.state.root.assistantMode, 'chat');
  // Chat itself, or no chat at all, carries nothing.
  const open = mount();
  open.ui.emit('chat-button');
  assert.equal(open.chat.presentation(), null);
  assert.equal(mount().chat.presentation(), null);
});
