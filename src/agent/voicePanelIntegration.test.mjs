import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentSession } from './agentLoop.js';
import { initGevVoiceCommands } from '../voice/gevRealtime.js';
import { installPanelDom } from '../voice/panel/testDom.mjs';
import { createVoicePreferences } from '../voice/panel/preferences.js';
import { buildAgentInstructions } from '../../server/providers/agent/instructions.js';

function harness(t, { expose = true, delayed = false } = {}) {
  const doc = installPanelDom(t);
  const values = new Map([['gev.agent.provider', 'chatgpt']]);
  const storage = {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
  };
  let active = false,
    release,
    starts = 0;
  const commands = initGevVoiceCommands({
    panel: expose,
    panelStorage: storage,
    viewer: {
      clock: { onTick: { addEventListener: () => () => {} } },
      scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
      camera: { moveEnd: { addEventListener() {} } },
    },
    styleManager: {
      getCockpitState: () => ({ active }),
      controlCockpit() {
        active = false;
        return delayed
          ? new Promise((resolve) => {
              release = () => resolve({ ok: true });
            })
          : { ok: true };
      },
    },
    dataManager: { layers: new Map(), getAll: () => [] },
    createSession: ({ runner }) => ({
      controller: { runner },
      capabilities: {},
      start() {
        starts++;
      },
      stop() {},
      sendText() {
        return false;
      },
      sendMapEvent() {},
      bindControls() {},
    }),
  });
  t.after(() => commands.session.destroy());
  const posts = [],
    events = [];
  let plan = [];
  const agent = createAgentSession({
    runAction: (...args) => commands.runner(...args),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      posts.push(body);
      if (body.messages.at(-1).role === 'user') {
        const toolCalls = plan.map((c, i) => ({
          ...c,
          id: 'call-' + posts.length + '-' + i,
        }));
        return Response.json({
          message: {
            role: 'assistant',
            content: 'Settings already changed!',
            tool_calls: toolCalls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
          toolCalls,
        });
      }
      // Deliberately untruthful provider: refusals must remain refusals locally.
      return Response.json({
        message: { role: 'assistant', content: 'Settings already changed!' },
        toolCalls: [],
      });
    },
  });
  return {
    commands,
    doc,
    values,
    agent,
    posts,
    events,
    cockpit: () => {
      active = true;
    },
    release: () => release?.(),
    pending: () => Boolean(release),
    starts: () => starts,
    send(text, calls) {
      plan = calls;
      return agent.send(text, { onEvent: (e) => events.push(e) });
    },
  };
}
const call = (name, args) => ({ name, args });
const panel = (panelId, open = true) =>
  call('set_panel_open', { panelId, open });
const results = (h) =>
  h.agent.transcript
    .filter((m) => m.role === 'tool')
    .map((m) => JSON.parse(m.content));

test('typed shared runner opens/closes voice panes while microphone is idle; preferences and agent history stay separate', async (t) => {
  const h = harness(t);
  for (const id of ['voice-preview', 'voice-settings']) {
    await h.send('Open ' + id, [panel(id)]);
    assert.equal(results(h).at(-1).panelOpen, true);
    await h.send('Close ' + id, [panel(id, false)]);
    assert.equal(results(h).at(-1).panelOpen, false);
  }
  h.commands.ui.voicePreviewInput.checked = false;
  h.commands.ui.voicePreviewInput.fire('change');
  for (const minutes of [0, 1, 7, 60]) {
    await h.send('Set inactivity to ' + minutes, [
      call('set_voice_inactivity_timeout', { minutes }),
    ]);
    assert.equal(results(h).at(-1).persisted, true);
    assert.equal(
      h.values.get('godsEyeView.voice.inactivityMinutes'),
      minutes === 0 ? 'none' : String(minutes),
    );
  }
  assert.equal(h.values.get('godsEyeView.voice.previewEnabled'), 'false');
  assert.equal(h.values.get('gev.agent.provider'), 'chatgpt');
  const restored = createVoicePreferences({
    storage: { getItem: (key) => h.values.get(key) ?? null },
  }).snapshot();
  assert.equal(restored.minutes, 60);
  assert.equal(restored.previewEnabled, false);
  const count = h.agent.transcript.length;
  h.commands.session.stop();
  assert.equal(h.agent.transcript.length, count);
  h.agent.reset();
  assert.equal(h.commands.getVoicePreferences().minutes, 60);
  assert.equal(h.commands.getVoicePreferences().previewEnabled, false);
  assert.equal(h.starts(), 0);
  assert.equal(h.commands.session.isActive(), false);
});

for (const [label, options, tool] of [
  ['unavailable voice host', { expose: false }, panel('voice-settings')],
  ['unavailable Provider Settings', {}, panel('provider-settings')],
  [
    'invalid timeout',
    {},
    call('set_voice_inactivity_timeout', { minutes: 61 }),
  ],
  ['ambiguous settings target', {}, panel('settings')],
])
  test(
    'typed ' + label + ' cannot announce success or retry a refused operation',
    async (t) => {
      const h = harness(t, options);
      const reply = await h.send('Change settings', [tool]);
      assert.equal(results(h)[0].ok, false);
      assert.equal(reply.ok, false);
      assert.doesNotMatch(reply.content, /Settings already changed!/);
      assert.ok(
        !h.events.some(
          (e) =>
            e.message?.role === 'assistant' &&
            e.message.content === 'Settings already changed!',
        ),
      );
      assert.equal(h.posts.length, 1);
    },
  );

test('STOP during Cockpit exit prevents reveal and sibling preference mutation', async (t) => {
  const h = harness(t, { delayed: true });
  h.cockpit();
  const pending = h.send('Exit and open Voice Settings', [
    panel('voice-settings'),
    call('set_voice_inactivity_timeout', { minutes: 1 }),
  ]);
  while (!h.pending()) await new Promise((resolve) => setImmediate(resolve));
  h.agent.abort();
  h.release();
  assert.match((await pending).error, /cancelled/);
  assert.equal(h.commands.voicePanel.snapshot().panelOpen, false);
  assert.equal(h.commands.getVoicePreferences().minutes, 5);
});

test('manual focus/tab choice and unmount defeat pending typed reveals', async (t) => {
  const h = harness(t, { delayed: true });
  h.cockpit();
  const pending = h.send('Open Voice Settings', [panel('voice-settings')]);
  while (!h.pending()) await new Promise((resolve) => setImmediate(resolve));
  h.commands.ui.previewTab.fire('click');
  h.release();
  assert.equal((await pending).ok, false);
  assert.equal(h.commands.voicePanel.snapshot().view, 'preview');
  h.commands.ui.previewTab.fire('keydown', { key: 'End' });
  assert.equal(h.commands.voicePanel.snapshot().settingsOpen, true);
  h.commands.ui.voicePanel.fire('keydown', { key: 'Escape' });
  assert.equal(h.doc.activeElement, h.commands.ui.voiceSettingsButton);
  h.commands.session.destroy();
  const reply = await h.send('Open Voice Settings', [panel('voice-settings')]);
  assert.equal(reply.ok, false);
});

test('typed manual retains unnamed-settings clarification and named-panel direct routing', () => {
  assert.match(
    buildAgentInstructions(),
    /Unnamed settings: ask "Voice settings or Provider settings\?" first; named panels apply directly/,
  );
});

test('panel refusal skips sibling tools and leaves subsequent explicit commands usable', async (t) => {
  const h = harness(t);
  const reply = await h.send('Open provider settings then change timeout', [
    panel('provider-settings'),
    call('set_voice_inactivity_timeout', { minutes: 1 }),
  ]);
  assert.equal(reply.ok, false);
  assert.equal(results(h).at(-1).skipped, true);
  assert.equal(h.commands.getVoicePreferences().minutes, 5);
  await h.send('Set timeout to 7', [
    call('set_voice_inactivity_timeout', { minutes: 7 }),
  ]);
  assert.equal(h.commands.getVoicePreferences().minutes, 7);
});

test('typed Provider Settings dispatch verifies open and close independently of voice', async (t) => {
  const h = harness(t);
  const root = h.doc.createElement('aside');
  root.id = 'key-setup';
  root.dataset.ready = 'true';
  root.hidden = true;
  const open = h.doc.createElement('button');
  open.id = 'key-setup-chip';
  const close = h.doc.createElement('button');
  close.setAttribute('data-key-setup-close', '');
  close.matches = (selector) => selector === '[data-key-setup-close]';
  open.click = () => {
    root.hidden = false;
    root.classList.add('visible');
  };
  close.click = () => root.classList.remove('visible');
  root.appendChild(close);
  h.doc.body.append(root, open);
  for (const desired of [true, false]) {
    await h.send('Toggle Provider Settings', [
      panel('provider-settings', desired),
    ]);
    assert.equal(results(h).at(-1).applied, true);
    assert.equal(results(h).at(-1).open, desired);
  }
  assert.equal(h.starts(), 0);
});

test('typed Cockpit voicePanel exit opens requested pane without microphone', async (t) => {
  const h = harness(t);
  h.cockpit();
  await h.send('Exit Cockpit into Voice Settings', [
    call('control_cockpit', { action: 'exit', voicePanel: 'settings' }),
  ]);
  assert.equal(results(h).at(-1).settingsOpen, true);
  assert.equal(h.starts(), 0);
});
