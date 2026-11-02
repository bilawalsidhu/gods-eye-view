import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { installVueDom } from '../testSupport/vueDom.mjs';
import { assertSameNode } from '../testSupport/domAssert.mjs';

let uninstall, mountApplicationViews, mountAgentConsole, nextTick, setLocale;
let pinia, useAgentConsoleStore, usePanelChromeStore;
before(async () => {
  uninstall = installVueDom();
  ({ nextTick } = await import('vue'));
  ({ mountApplicationViews } = await import('../ui/views/index.js'));
  ({ mountAgentConsole } = await import('./agentConsole.js'));
  ({ setLocale } = await import('../i18n/index.js'));
  ({ useAgentConsoleStore } = await import('../ui/stores/agentConsole.js'));
  ({ usePanelChromeStore } = await import('../ui/stores/panelChrome.js'));
  pinia = (await import('../ui/vueRuntime.js')).applicationPinia();
});
after(() => uninstall());
const get = (id) => document.getElementById(id);
async function flush() {
  await settle();
  await nextTick();
}
function fixture(t, { command } = {}) {
  document.body.innerHTML =
    '<div class="gev-view" data-gev-view="agent-console"></div>';
  setLocale('en');
  mountApplicationViews();
  const calls = [],
    actions = [];
  let account = 'one';
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url === '/api/agent/config')
      return Response.json({
        providers: [{ id: 'chatgpt', authType: 'oauth', configured: true }],
      });
    if (url === '/api/agent/chatgpt/status')
      return Response.json({
        active: account,
        binding: account,
        configured: true,
        accounts: ['one', 'two'].map((id) => ({
          id,
          label: id,
          signedIn: true,
        })),
      });
    if (url === '/api/agent/chatgpt/select') {
      account = body.account;
      return fetchImpl('/api/agent/chatgpt/status');
    }
    if (url.startsWith('/api/agent/models'))
      return Response.json({
        models: [{ id: 'model', label: 'Test model' }],
        binding: account,
      });
    if (url === '/api/agent/command') {
      if (command) return command(init, body);
      if (body.messages.at(-1).role === 'user')
        return Response.json({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call',
                type: 'function',
                function: {
                  name: 'set_panel_open',
                  arguments: '{"panelId":"Display","open":true}',
                },
              },
            ],
          },
          toolCalls: [
            {
              id: 'call',
              name: 'set_panel_open',
              args: { panelId: 'Display', open: true },
            },
          ],
        });
      return Response.json({
        message: { role: 'assistant', content: 'ABC-123 (-27.367, -55.896)' },
        toolCalls: [],
      });
    }
    throw new Error(url);
  };
  const console_ = mountAgentConsole({
    fetchImpl,
    view: window,
    runAction: async (name, args) => {
      actions.push([name, args]);
      return { ok: true };
    },
  });
  t.after(async () => {
    console_.destroy();
    mountApplicationViews(document, { omit: ['agent-console'] });
    setLocale('en');
    await nextTick();
  });
  return { console_, calls, actions };
}
function submit(text) {
  get('agent-input').value = text;
  get('agent-form').dispatchEvent(new Event('submit', { cancelable: true }));
}

test('the actual registered Vue view renders the controller, tool transcript and account isolation', async (t) => {
  const f = fixture(t);
  f.console_.open();
  await flush();
  assert.equal(get('agent-model').value, 'model');
  assert.equal(get('agent-input').disabled, false);
  submit('open Display');
  await flush();
  assert.deepEqual(f.actions, [
    ['set_panel_open', { panelId: 'Display', open: true }],
  ]);
  assert.equal(get('agent-transcript').children.length, 3);
  assert.equal(get('agent-transcript').children[1].dataset.outcome, 'ok');
  get('agent-chatgpt-account').value = 'two';
  get('agent-chatgpt-account').dispatchEvent(new Event('change'));
  await flush();
  assert.equal(get('agent-transcript').children.length, 0);
  submit('new account');
  await flush();
  assert.equal(
    f.calls.filter((c) => c.url === '/api/agent/command').at(-1).body.binding,
    'two',
  );
});

test('live locale changes preserve nodes, typed input and transcript without owning the panel state', async (t) => {
  const f = fixture(t);
  f.console_.open();
  await flush();
  submit('hello');
  await flush();
  const input = get('agent-input'),
    transcript = get('agent-transcript');
  input.value = 'unsent draft';
  input.focus();
  const panels = usePanelChromeStore(pinia);
  const token = panels.connect({});
  panels.publish(token, 'pp-toggles', { collapsed: true });
  const before = panels.panels;
  setLocale('es');
  await nextTick();
  assert.equal(get('agent-send').textContent, 'ENVIAR');
  setLocale('ar');
  await nextTick();
  assertSameNode(input, get('agent-input'));
  assertSameNode(transcript, get('agent-transcript'));
  assert.equal(input.value, 'unsent draft');
  assert.equal(transcript.children.length, 3);
  assert.equal(get('agent-input').getAttribute('dir'), 'auto');
  assert.equal(panels.panels === before, true);
  panels.detach(token);
});

test('STOP through the Vue button aborts the session and disposal rejects late presentation', async (t) => {
  let aborted = false,
    finish;
  const f = fixture(t, {
    command: (init) =>
      new Promise((resolve, reject) => {
        finish = resolve;
        init.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new DOMException('Stopped', 'AbortError'));
          },
          { once: true },
        );
      }),
  });
  f.console_.open();
  await flush();
  submit('wait');
  await nextTick();
  assert.equal(get('agent-stop').disabled, false);
  get('agent-stop').click();
  await flush();
  assert.equal(aborted, true);
  assert.equal(get('agent-stop').disabled, true);
  assert.equal(get('agent-input').disabled, false);
  f.console_.destroy();
  await nextTick();
  finish?.(
    Response.json({
      message: { role: 'assistant', content: 'late' },
      toolCalls: [],
    }),
  );
  await flush();
  assert.equal(get('agent-console-chip').hidden, true);
  assert.equal(useAgentConsoleStore(pinia).view.entries.length, 0);
});

test('a focused voice pane keeps Escape and Tab while the non-modal console is open', async (t) => {
  const f = fixture(t);
  f.console_.open();
  await flush();
  get('agent-console').getClientRects = () => [{}];
  const pane = document.createElement('section');
  pane.id = 'gev-voice-panel';
  const button = pane.appendChild(document.createElement('button'));
  document.body.append(pane);
  button.focus();
  for (const key of ['Escape', 'Tab']) {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    });
    button.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
    assert.equal(get('agent-console').open, true);
    assertSameNode(document.activeElement, button);
  }
});
