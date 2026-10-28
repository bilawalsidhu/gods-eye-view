import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { PanelChrome } from '../ui/panelChrome.js';
import { createGevActionRunner } from '../voice/gevActions.js';
import { createAgentSession } from './agentLoop.js';

const integrated = existsSync(
  new URL('../ui/rightRailTabs.js', import.meta.url),
);
const names = ['Display', 'CCTV', 'Street Level', 'Context'];
const ids = [
  'pp-toggles',
  'cctv-panel',
  'street-level-panel',
  'global-context-panel',
];
async function harness(t, { mobile = false } = {}) {
  const { makeDocument } = await import('../testSupport/fakeDom.mjs');
  const doc = makeDocument();
  const prior = globalThis.document;
  globalThis.document = doc;
  t.after(() => {
    globalThis.document = prior;
  });
  doc.documentElement = { dataset: { uiTheme: 'tactical' } };
  if (mobile) doc.body.classList.add('mobile-shell');
  const rail = doc.createElement('aside');
  rail.id = 'right-context-rail';
  rail.setAttribute('data-rail-tabs', 'vertical');
  doc.body.append(rail);
  for (const id of ids) {
    const p = doc.createElement('section');
    p.id = id;
    p.dataset.panelId = id;
    p.setAttribute('data-panel-id', id);
    p.classList.add('collapsed');
    rail.append(p);
  }
  const input = doc.createElement('input');
  doc.body.append(input);
  input.focus();
  const saved = new Map(),
    claimed = [];
  const owner = {
    _rightPanelStack: rail,
    _panelLayout: {},
    _lifetime: { frame() {} },
    _syncPanelCollapseButton() {},
    _scheduleRightPanelLayout() {},
    _scheduleLeftPanelLayout() {},
    _layoutRightPanels() {},
    _syncCctvPanelViewport() {},
    _savePanelCollapsedState: (id, value) => saved.set(id, value),
    shareLinkManager: {
      claimRestoreLane: (...a) => claimed.push(a),
      onPanelStateChange() {},
    },
  };
  owner.setPanelCollapsed = PanelChrome.prototype.setPanelCollapsed.bind(owner);
  const runner = createGevActionRunner({
    viewer: {
      camera: { moveEnd: { addEventListener() {} } },
      scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
      clock: { onTick: { addEventListener: () => () => {} } },
    },
    styleManager: owner,
    dataManager: { layers: new Map() },
  });
  let plan = [],
    count = 0;
  const posts = [],
    events = [];
  const agent = createAgentSession({
    runAction: runner,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      posts.push(body);
      if (body.messages.at(-1).role === 'user') {
        const toolCalls = plan.map((args) => ({
          name: 'set_panel_open',
          args,
          id: `c${++count}`,
        }));
        return Response.json({
          message: {
            role: 'assistant',
            content: 'All requested panels are open!',
            tool_calls: toolCalls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
          toolCalls,
        });
      }
      return Response.json({
        message: {
          role: 'assistant',
          content: 'All requested panels are open!',
        },
        toolCalls: [],
      });
    },
  });
  return {
    doc,
    rail,
    input,
    owner,
    saved,
    claimed,
    agent,
    posts,
    events,
    open: () =>
      ids.filter(
        (id) => !doc.getElementById(id).classList.contains('collapsed'),
      ),
    send: (args) => {
      plan = args;
      return agent.send('Open the requested panels', {
        onEvent: (e) => events.push(e),
      });
    },
  };
}

test(
  'typed rail batch reports final Context ownership instead of four successful openings',
  { skip: !integrated },
  async (t) => {
    const h = await harness(t);
    const reply = await h.send(ids.map((panelId) => ({ panelId, open: true })));
    assert.deepEqual(h.open(), [ids[3]]);
    assert.equal(reply.ok, true);
    assert.match(reply.content, /Context.*open/);
    assert.doesNotMatch(reply.content, /All requested panels are open/);
    assert.equal(h.doc.activeElement, h.input);
    assert.equal(
      h.events.some(
        (e) => e.message?.content === 'All requested panels are open!',
      ),
      false,
    );
    const last = h.posts
      .at(-1)
      .messages.filter((m) => m.role === 'tool')
      .at(-1);
    assert.deepEqual(JSON.parse(last.content).rightRailState.openPanelIds, [
      ids[3],
    ]);
  },
);

test(
  'successive typed opens, explicit close, persistence and restore lanes preserve exclusive owner',
  { skip: !integrated },
  async (t) => {
    const h = await harness(t);
    for (let i = 0; i < ids.length; i++) {
      const reply = await h.send([{ panelId: ids[i], open: true }]);
      assert.deepEqual(h.open(), [ids[i]]);
      assert.match(reply.content, new RegExp(names[i] + '.*open'));
      assert.equal(h.doc.activeElement, h.input);
    }
    assert.deepEqual(
      ids.map((id) => h.saved.get(id)),
      [true, true, true, false],
    );
    assert.ok(
      ids.every((id) => h.claimed.some(([, claimed]) => claimed === id)),
    );
    await h.send([{ panelId: ids[3], open: false }]);
    assert.deepEqual(h.open(), []);
    const before = [...h.saved];
    for (const [id, collapsed] of before)
      h.owner.setPanelCollapsed(id, collapsed, {
        restore: true,
        persist: false,
        syncShare: false,
      });
    assert.deepEqual([...h.saved], before);
    assert.deepEqual(h.open(), []);
  },
);

test(
  'phone panel opens remain independent and receive no desktop-only correction',
  { skip: !integrated },
  async (t) => {
    const h = await harness(t, { mobile: true });
    await h.send(ids.map((panelId) => ({ panelId, open: true })));
    assert.deepEqual(h.open(), ids);
    await h.send([{ panelId: ids[1], open: false }]);
    assert.deepEqual(h.open(), [ids[0], ids[2], ids[3]]);
    assert.equal(h.doc.activeElement, h.input);
  },
);
