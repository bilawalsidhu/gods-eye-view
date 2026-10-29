import { readFileSync } from 'node:fs';
import { GevRealtimeController } from '../voice/gevRealtime.js';
import { ShareLinkManager } from '../sharelink.js';
import {
  decodeShareView,
  encodeShareView,
  SHARE_VIEW_ENUMS,
} from '../share/viewCodec.js';
import { validateToolArguments } from '../../server/providers/agent/toolSchema.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentSession } from './agentLoop.js';
import { createGevActionRunner } from '../voice/gevActions.js';
import { StyleManager } from '../ui/applicationShell.js';
import { HUD_LAYOUTS, normalizeHudLayout } from '../hudLayouts.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import { buildAgentInstructions } from '../../server/providers/agent/instructions.js';
import { realtimeDirectives } from '../../server/providers/openai/instructions.js';

function harness({
  normalize = false,
  failVisibility = false,
  throwLayout = false,
} = {}) {
  let layout = 'minimal',
    visible = true,
    posts = 0;
  const owner = {
    hud: {
      getVariant: () => layout,
      get visible() {
        return visible;
      },
      setMode(mode) {
        visible = mode !== 'off';
      },
    },
    _setHudVariant(value) {
      layout = normalize ? 'tactical' : normalizeHudLayout(value);
    },
    _updateHudButtonState() {},
    _syncShareState() {},
    setHudLayout(value) {
      if (throwLayout) throw new Error('unavailable');
      return normalize
        ? (this._setHudVariant(value), { ok: true, layout, visible })
        : StyleManager.prototype.setHudLayout.call(this, value);
    },
    setHudVisible(value) {
      return failVisibility
        ? { ok: false }
        : StyleManager.prototype.setHudVisible.call(this, value);
    },
    getControlState: () => ({ hud: { layout, visible } }),
  };
  const runner = createGevActionRunner({
    viewer: {
      clock: { onTick: { addEventListener: () => () => {} } },
      scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
      camera: { moveEnd: { addEventListener() {} } },
    },
    styleManager: owner,
    dataManager: { layers: new Map(), getAll: () => [] },
  });
  const events = [];
  const agent = createAgentSession({
    runAction: runner,
    fetchImpl: async (_url, init) => {
      posts++;
      if (JSON.parse(init.body).messages.at(-1).role === 'user')
        return Response.json({
          message: {
            role: 'assistant',
            content: 'HUD Operator applied!',
            tool_calls: [
              {
                id: 'hud',
                type: 'function',
                function: {
                  name: 'set_hud',
                  arguments: JSON.stringify(nextArgs),
                },
              },
            ],
          },
          toolCalls: [{ id: 'hud', name: 'set_hud', args: nextArgs }],
        });
      return Response.json({
        message: { role: 'assistant', content: 'HUD Operator applied!' },
        toolCalls: [],
      });
    },
  });
  let nextArgs;
  return {
    runner,
    agent,
    events,
    owner,
    posts: () => posts,
    send(args) {
      nextArgs = args;
      return agent.send('Change HUD', { onEvent: (e) => events.push(e) });
    },
  };
}

test('typed HUD confirmation and voice say use applied state, suppressing invented Operator prose', async () => {
  const h = harness();
  const voice = await h.runner('set_hud', { layout: 'cyber' });
  assert.match(voice.say, /HUD cyber layout/);
  const result = await h.send({ layout: 'minimal', visible: 'off' });
  assert.equal(result.ok, true);
  assert.match(result.content, /HUD minimal layout; hidden/);
  assert.ok(!h.events.some((e) => /Operator/.test(e.message?.content || '')));
});

for (const [label, options, args, expected] of [
  [
    'rejected layout',
    {},
    { layout: 'retired-layout', visible: 'off' },
    /HUD request failed/,
  ],
  [
    'normalized layout',
    { normalize: true },
    { layout: 'minimal' },
    /not applied.*HUD tactical layout/,
  ],
  [
    'partial failure',
    { failVisibility: true },
    { layout: 'cyber', visible: 'off' },
    /failed.*HUD cyber layout/,
  ],
])
  test(`typed and voice HUD ${label} cannot confirm requested success`, async () => {
    const h = harness(options);
    const voice = await h.runner('set_hud', args);
    assert.match(voice.say, expected);
    const result = await h.send(args);
    assert.equal(result.ok, false);
    assert.match(result.content, expected);
    assert.equal(
      h.posts(),
      1,
      'no follow-up inference after a failed or normalized HUD request',
    );
    assert.ok(!h.events.some((e) => /Operator/.test(e.message?.content || '')));
  });

test('HUD schemas share the live policy and both manuals require resulting state', () => {
  assert.deepEqual(
    GEV_REALTIME_TOOLS.find((t) => t.name === 'set_hud').parameters.properties
      .layout.enum,
    [...HUD_LAYOUTS],
  );
  for (const manual of [
    realtimeDirectives().join('\n'),
    buildAgentInstructions(),
  ]) {
    assert.match(manual, /HUD.*returned.*hud\.layout/);
    assert.match(manual, /normalized/);
  }
});

test('retirement integration offers only three layouts and refuses Operator through both runners', async (t) => {
  if (HUD_LAYOUTS.includes('operator'))
    return t.skip('Enable after independently integrating #1467');
  assert.deepEqual([...HUD_LAYOUTS], ['tactical', 'minimal', 'cyber']);
  const h = harness();
  const voice = await h.runner('set_hud', { layout: 'operator' });
  assert.equal(voice.ok, false);
  assert.match(voice.say, /failed/);
  const typed = await h.send({ layout: 'operator' });
  assert.equal(typed.ok, false);
  assert.doesNotMatch(typed.content, /HUD operator layout/i);
  for (const manual of [
    realtimeDirectives().join('\n'),
    buildAgentInstructions(),
  ]) {
    assert.doesNotMatch(manual, /switch to operator|HUD operator layout/);
  }
});

test('retired share links keep their wire meaning and recover Tactical at the HUD boundary', (t) => {
  if (HUD_LAYOUTS.includes('operator'))
    return t.skip('Enable after independently integrating #1467');
  assert.equal(SHARE_VIEW_ENUMS.hudVariant.indexOf('operator'), 1);
  const code = encodeShareView({ lat: 0, lon: 0, hudVariant: 'operator' });
  const compact = decodeShareView(code);
  assert.equal(compact.ok, true);
  assert.equal(compact.state.hudVariant, 'operator');
  const legacy = ShareLinkManager.prototype._parseShareHash.call(
    {},
    'v=2&lat=0&lon=0&hud=operator',
  );
  for (const state of [legacy, compact.state])
    assert.equal(normalizeHudLayout(state.hudVariant), 'tactical');
  for (const locale of ['es', 'ru', 'zh-CN', 'zh-Hant']) {
    const catalog = JSON.parse(
      readFileSync(
        new URL(`../i18n/locales/${locale}.json`, import.meta.url),
        'utf8',
      ),
    );
    assert.ok(!Object.hasOwn(catalog, 'Operator'));
    for (const layout of ['Tactical', 'Minimal', 'Cyber'])
      assert.ok(catalog[layout]);
  }
  const schema = GEV_REALTIME_TOOLS.find(
    (tool) => tool.name === 'set_hud',
  ).parameters;
  assert.equal(
    validateToolArguments(schema, { layout: 'operator' }).valid,
    false,
  );
  for (const layout of HUD_LAYOUTS)
    assert.equal(validateToolArguments(schema, { layout }).valid, true);
});

test('Realtime function-call transport forwards the same HUD state and say line', async () => {
  const h = harness(),
    sent = [];
  const controller = new GevRealtimeController({
    ui: {
      root: {
        dataset: {},
        classList: { remove() {} },
        querySelectorAll: () => [],
      },
      status: {},
      detail: {},
      errorDetail: {},
    },
    runner: h.runner,
  });
  controller.debugLog = () => {};
  controller.status = 'listening';
  controller.dc = {
    readyState: 'open',
    send: (value) => sent.push(JSON.parse(value)),
    close() {},
  };
  await controller.handleRealtimeEvent({
    data: JSON.stringify({
      type: 'response.function_call_arguments.done',
      item_id: 'hud-item',
      call_id: 'hud-call',
      name: 'set_hud',
      arguments: JSON.stringify({ layout: 'minimal' }),
    }),
  });
  const result = sent.find(
    (event) => event.item?.type === 'function_call_output',
  );
  assert.ok(result, 'tool output reaches the Realtime channel');
  assert.match(JSON.parse(result.item.output).say, /HUD minimal layout/);
});

test('thrown HUD action cannot leak a speculative confirmation', async () => {
  const h = harness({ throwLayout: true });
  const result = await h.send({ layout: 'minimal' });
  assert.equal(result.ok, false);
  assert.match(result.content, /HUD request failed/);
  assert.equal(h.posts(), 1);
  assert.ok(!h.events.some((e) => /Operator/.test(e.message?.content || '')));
});

test('Display dropdown offers exactly the same layouts as typed and voice tools', () => {
  const markup = readFileSync(
    new URL('../ui/templates/display-controls.html', import.meta.url),
    'utf8',
  );
  const select = markup.match(
    /<select id="hud-layout-select"[\s\S]*?<\/select>/,
  )?.[0];
  assert.ok(select);
  assert.deepEqual(
    [...select.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]),
    [...HUD_LAYOUTS],
  );
});

test('HUD refusal skips sibling actions, preserves paired history and allows a fresh command', async () => {
  const executed = [];
  let calls = [
    { id: 'bad', name: 'set_hud', args: { layout: 'retired-layout' } },
    { id: 'sibling', name: 'set_hud', args: { layout: 'cyber' } },
  ];
  const session = createAgentSession({
    runAction: async (name, args) => {
      executed.push(args.layout);
      return {
        ok: args.layout !== 'retired-layout',
        hud: { layout: 'minimal', visible: true },
      };
    },
    fetchImpl: async (_url, init) =>
      Response.json(
        JSON.parse(init.body).messages.at(-1).role === 'user'
          ? {
              message: {
                role: 'assistant',
                content: 'HUD Operator applied!',
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.args),
                  },
                })),
              },
              toolCalls: calls,
            }
          : {
              message: { role: 'assistant', content: 'HUD Operator applied!' },
              toolCalls: [],
            },
      ),
  });
  const failed = await session.send('Change HUD');
  assert.equal(failed.ok, false);
  assert.deepEqual(executed, ['retired-layout']);
  const results = session.transcript.filter((m) => m.role === 'tool');
  assert.deepEqual(
    results.map((m) => m.tool_call_id),
    ['bad', 'sibling'],
  );
  assert.equal(JSON.parse(results[1].content).skipped, true);
  calls = [{ id: 'fresh', name: 'set_hud', args: { layout: 'minimal' } }];
  const fresh = await session.send('Use Minimal');
  assert.equal(fresh.ok, true);
  assert.match(fresh.content, /HUD minimal layout/);
});

test('later tool rounds cannot reintroduce a speculative HUD confirmation', async () => {
  const events = [];
  let round = 0;
  const session = createAgentSession({
    runAction: async () => ({
      ok: true,
      hud: { layout: 'minimal', visible: true },
    }),
    fetchImpl: async () => {
      round++;
      const calls =
        round < 3
          ? [
              {
                id: String(round),
                name: round === 1 ? 'set_hud' : 'get_current_view_state',
                args: round === 1 ? { layout: 'minimal' } : {},
              },
            ]
          : [];
      return Response.json({
        message: {
          role: 'assistant',
          content: 'HUD Operator applied!',
          ...(calls.length
            ? {
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.args),
                  },
                })),
              }
            : {}),
        },
        toolCalls: calls,
      });
    },
  });
  const result = await session.send('Change HUD and read state', {
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.ok, true);
  assert.match(result.content, /Last HUD tool result: HUD minimal layout/);
  assert.ok(
    !events.some((event) => /Operator/.test(event.message?.content || '')),
  );
  assert.ok(
    !session.transcript.some(
      (message) =>
        message.role === 'assistant' && /Operator/.test(message.content || ''),
    ),
  );
});
