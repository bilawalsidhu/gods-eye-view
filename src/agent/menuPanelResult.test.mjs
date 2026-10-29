import test from 'node:test';
import assert from 'node:assert/strict';
import { menuPanelOutcome } from './menuPanelResult.js';
import { createAgentSession } from './agentLoop.js';
import { GEV_ACTION_SCHEMAS } from '../voice/actionSchemas.js';
import { buildAgentInstructions } from '../../server/providers/agent/instructions.js';
import {
  prepareToolCall,
  indexToolsByName,
} from '../../server/providers/agent/toolSchema.js';

function fixture(id = 'utilities-panel') {
  const classes = new Set();
  const parent = { hidden: false, style: {}, parentElement: null };
  const panel = {
    id,
    parentElement: parent,
    hidden: false,
    style: {},
    classList: { contains: (c) => classes.has(c) },
  };
  const doc = {
    getElementById: (key) => (key === id ? panel : null),
    defaultView: { getComputedStyle: (node) => node.style },
  };
  const result = { ok: true, panelId: id, focusedLayer: { id: 'directions' } };
  return { panel, parent, classes, doc, result };
}
const args = { layerId: 'directions' };

test('Utilities uses the existing Directions reveal without enlarging the voice schema', () => {
  const index = indexToolsByName(GEV_ACTION_SCHEMAS);
  assert.equal(
    prepareToolCall({ name: 'show_data_layers_menu', arguments: args }, index)
      .ok,
    true,
  );
  assert.equal(
    prepareToolCall(
      {
        name: 'set_panel_open',
        arguments: { panelId: 'utilities-panel', open: true },
      },
      index,
    ).ok,
    false,
  );
  assert.match(
    buildAgentInstructions(),
    /open Utilities.*drawing\/import tools.*show_data_layers_menu/,
  );
});

test('readback names the actual panel on both old and integrated shells', () => {
  for (const [id, label] of [
    ['utilities-panel', 'Utilities'],
    ['data-panel', 'Data Layers'],
  ]) {
    const f = fixture(id);
    const outcome = menuPanelOutcome(f.result, args, f.doc);
    assert.equal(outcome.ok, true);
    assert.match(outcome.content, new RegExp('^' + label + ' is open'));
  }
});

for (const kind of [
  'rejected',
  'cancelled',
  'not applied',
  'collapsed',
  'missing',
  'hidden parent',
  'CSS hidden',
  'wrong row',
]) {
  test(`readback refuses ${kind}`, () => {
    const f = fixture();
    if (kind === 'rejected') f.result.ok = false;
    if (kind === 'cancelled') f.result.cancelled = true;
    if (kind === 'not applied') f.result.applied = false;
    if (kind === 'collapsed') f.classes.add('collapsed');
    if (kind === 'missing') f.doc.getElementById = () => null;
    if (kind === 'hidden parent') f.parent.hidden = true;
    if (kind === 'CSS hidden') f.parent.style.display = 'none';
    if (kind === 'wrong row') f.result.focusedLayer = null;
    assert.equal(menuPanelOutcome(f.result, args, f.doc).ok, false);
  });
}

for (const refuse of [false, true]) {
  test(`typed loop ${refuse ? 'blocks no-op and siblings' : 'rechecks final state'} despite false provider claims`, async (t) => {
    const f = fixture();
    const prior = globalThis.document;
    globalThis.document = f.doc;
    t.after(() => {
      globalThis.document = prior;
    });
    let posts = 0,
      runs = 0;
    const events = [];
    const calls = [
      { id: 'menu', name: 'show_data_layers_menu', args },
      ...(refuse
        ? [
            {
              id: 'next',
              name: 'set_panel_open',
              args: { panelId: 'data-panel' },
            },
          ]
        : []),
    ];
    const agent = createAgentSession({
      runAction: async () => {
        runs++;
        if (refuse) f.classes.add('collapsed');
        return f.result;
      },
      fetchImpl: async () => {
        posts++;
        if (posts === 2) f.classes.add('collapsed'); // later manual choice
        return Response.json({
          message: {
            role: 'assistant',
            content: 'Utilities is open!',
            ...(posts === 1
              ? {
                  tool_calls: calls.map((c) => ({
                    id: c.id,
                    type: 'function',
                    function: {
                      name: c.name,
                      arguments: JSON.stringify(c.args),
                    },
                  })),
                }
              : {}),
          },
          toolCalls: posts === 1 ? calls : [],
        });
      },
    });
    const reply = await agent.send('abrí Utilidades', {
      onEvent: (e) => events.push(e),
    });
    assert.equal(reply.ok, false);
    assert.equal(runs, 1);
    assert.equal(posts, refuse ? 1 : 2);
    assert.doesNotMatch(reply.content, /Utilities is open/);
    assert.ok(
      events
        .filter((e) => e.type === 'message' && e.message.role === 'assistant')
        .every((e) => !e.message.content.includes('Utilities is open')),
    );
    if (refuse)
      assert.equal(
        JSON.parse(
          agent.transcript.find((m) => m.tool_call_id === 'next').content,
        ).skipped,
        true,
      );
  });
}
