import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import {
  agentConsoleDom,
  fakeStorage,
} from '../testSupport/agentConsoleDom.mjs';
import { mountAgentConsole } from './agentConsole.js';

function setup(t, { signedIn = true, command } = {}) {
  const dom = agentConsoleDom();
  const storage = fakeStorage();
  const calls = [];
  const state = {
    configured: signedIn,
    pending: false,
    active: signedIn ? 'account-1' : null,
    binding: 'binding-1',
    accounts: [
      { id: 'account-1', label: 'one@example.test · account-1', signedIn },
      {
        id: 'account-2',
        label: 'one@example.test · account-2',
        signedIn: true,
      },
    ],
  };
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    if (url === '/api/agent/config')
      return Response.json({
        providers: [
          {
            id: 'chatgpt',
            label: 'ChatGPT plan',
            configured: signedIn,
            authType: 'oauth',
          },
        ],
        defaultProvider: 'chatgpt',
      });
    if (url === '/api/agent/chatgpt/status') return Response.json(state);
    if (url.startsWith('/api/agent/models'))
      return Response.json({
        models: [
          {
            id: 'account-model',
            label: 'Account model',
            costPerCommandUsd: null,
          },
        ],
        binding: state.binding,
      });
    if (url === '/api/agent/chatgpt/select') {
      state.active = body.account;
      state.binding = 'binding-2';
      state.configured = true;
      return Response.json(state);
    }
    if (url === '/api/agent/chatgpt/logout') {
      state.active = null;
      state.configured = false;
      state.binding = 'signed-out';
      return Response.json({ ...state, revoked: false });
    }
    if (url === '/api/agent/chatgpt/login') {
      state.pending = true;
      return Response.json({
        path: '/api/agent/chatgpt/authorize?ticket=mock-ticket',
      });
    }
    if (url === '/api/agent/command')
      return command
        ? command(init)
        : Response.json({
            message: { role: 'assistant', content: 'Done.' },
            toolCalls: [],
          });
    throw new Error(`Unexpected route ${url}`);
  };
  const controller = mountAgentConsole({
    root: dom.document,
    view: dom.view,
    runAction: async () => ({ ok: true }),
    fetchImpl,
    storage,
  });
  t.after(() => controller.destroy());
  const get = (id) => dom.document.getElementById(id);
  controller.open();
  return { dom, get, controller, calls, storage, state };
}

test('ChatGPT uses plan-limit copy and pins the account binding; switching clears conversation', async (t) => {
  const f = setup(t);
  await settle();
  assert.equal(f.get('agent-chatgpt').hidden, false);
  assert.equal(f.dom.cost.textContent, 'ChatGPT plan limits');
  assert.equal(f.dom.input.disabled, false);
  f.dom.input.value = 'first account command';
  f.dom.submit();
  await settle();
  assert.equal(f.calls.find((c) => c.body?.messages).body.binding, 'binding-1');
  assert.ok(f.controller.session.transcript.length > 0);
  f.dom.select(f.get('agent-chatgpt-account'), 'account-2');
  assert.equal(f.dom.input.disabled, true);
  await settle();
  assert.equal(f.controller.session.transcript.length, 0);
  assert.equal(f.dom.transcript.children.length, 0);
  f.dom.input.value = 'second account command';
  f.dom.submit();
  await settle();
  const body = f.calls.filter((c) => c.body?.messages).at(-1).body;
  assert.equal(body.binding, 'binding-2');
  assert.deepEqual(body.messages, [
    { role: 'user', content: 'second account command' },
  ]);
});

test('unsigned accounts expose an explicit login; popup fallback contains only a local link', async (t) => {
  const f = setup(t, { signedIn: false });
  await settle();
  assert.equal(f.dom.input.disabled, true);
  assert.equal(f.get('agent-chatgpt-login').disabled, false);
  f.dom.click(f.get('agent-chatgpt-login'));
  await settle();
  const link = f.get('agent-chatgpt-status').children[0];
  assert.equal(link.href, '/api/agent/chatgpt/authorize?ticket=mock-ticket');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(f.get('agent-chatgpt-logout').disabled, false);
  assert.equal(f.storage.size, 0);
});

test('new account selection prevents sending to the previously active account', async (t) => {
  const f = setup(t);
  await settle();
  f.dom.select(f.get('agent-chatgpt-account'), '');
  await settle();
  assert.equal(f.dom.input.disabled, true);
  assert.equal(f.dom.modelSelect.children.length, 0);
  assert.match(f.dom.status.textContent, /Sign in/);
});

test('STOP aborts active fetch; controls cannot switch account during a command', async (t) => {
  let aborted = false;
  const f = setup(t, {
    command: (init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new DOMException('cancelled', 'AbortError'));
          },
          { once: true },
        );
      }),
  });
  await settle();
  f.dom.input.value = 'wait';
  f.dom.submit();
  await settle();
  assert.equal(f.get('agent-stop').disabled, false);
  assert.equal(f.get('agent-chatgpt-account').disabled, true);
  assert.equal(f.get('agent-chatgpt-logout').disabled, true);
  f.dom.click(f.get('agent-stop'));
  await settle();
  assert.equal(aborted, true);
  assert.equal(f.get('agent-stop').disabled, true);
  assert.equal(f.get('agent-chatgpt-account').disabled, false);
});

test('logout clears history, disables send and explains unconfirmed remote revocation', async (t) => {
  const f = setup(t);
  await settle();
  f.dom.input.value = 'hello';
  f.dom.submit();
  await settle();
  f.dom.click(f.get('agent-chatgpt-logout'));
  await settle();
  assert.equal(f.controller.session.transcript.length, 0);
  assert.equal(f.dom.input.disabled, true);
  assert.ok(
    f.dom
      .entries()
      .some(([, text]) => text.includes('Remote revocation was not confirmed')),
  );
});
