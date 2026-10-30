import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedResultJson } from './conversation.js';

for (const state of ['nominal', 'partial', 'degraded', 'stale']) {
  test(`large view result retains canonical ${state} evidence`, () => {
    const result = JSON.parse(
      boundedResultJson({
        ok: true,
        summary: 'Everything is fully available',
        layers: Array.from({ length: 100 }, (_, i) => ({
          id: `layer-${i}`,
          name: 'x'.repeat(300),
          feedState: state,
        })),
        feedProvenance: {
          overall: state,
          layers: Array.from({ length: 100 }, (_, i) => ({
            id: `layer-${i}`,
            name: 'x'.repeat(300),
            feedState: state,
          })),
          note: 'x'.repeat(3000),
        },
      }),
    );
    assert.equal(result.feedProvenance.overall, state);
  });
  test(`large catalog result retains nested ${state} evidence`, () => {
    const result = JSON.parse(
      boundedResultJson({
        ok: true,
        tool: 'get_hud_caption',
        summary: 'Everything is fully available',
        data: { feedState: state, caption: 'x'.repeat(10000) },
      }),
    );
    assert.equal(result.data.feedState, state);
  });
}

import * as Cesium from 'cesium';
import { createAgentSession } from './agentLoop.js';
import { createGevActionRunner } from '../voice/gevActions.js';
import { withToolCatalog } from '../voice/gevRealtime.js';
import { hudSummaryLayerContext } from '../hudSummaryResponse.js';
import { LAYER_FEED_STATES } from '../data/layerSnapshot.js';
import { getHudCaption } from '../tools/queries/brief.js';
import { composeCatalog, defineTool } from '../tools/catalog.js';
import { getLocale, setLocale, t } from '../i18n/index.js';
import { buildAgentInstructions } from '../../server/providers/agent/instructions.js';
import { realtimeDirectives } from '../../server/providers/openai/instructions.js';

function viewRunner(state) {
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.26, 500);
  const rows = [
    {
      id: 'flights',
      name: 'Live Flights',
      enabled: true,
      stats: {
        count: 4,
        source: 'fixture',
        ...(state === 'nominal' ? {} : { [state]: true }),
      },
    },
    { id: 'traffic', name: 'Traffic', enabled: true, stats: { count: 1 } },
  ];
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      globe: { getHeight: () => 0 },
    },
    camera: {
      positionWC: position,
      positionCartographic: Cesium.Cartographic.fromCartesian(position),
      heading: 0,
      pitch: -1,
      moveEnd: { addEventListener() {} },
    },
  };
  return {
    rows,
    runner: createGevActionRunner({
      viewer,
      dataManager: { getAll: () => rows, layers: new Map() },
      styleManager: { activeStyle: 'normal' },
    }),
  };
}

async function typedRoundTrip(runner, name, args, text, check) {
  const requests = [];
  const session = createAgentSession({
    runAction: runner,
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      if (request.messages.at(-1).role === 'user') {
        const call = { id: 'query', name, args };
        return Response.json({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: call.id,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          toolCalls: [call],
        });
      }
      const result = JSON.parse(request.messages.at(-1).content);
      check(result);
      // Scripted provider: tests the transport and evidence, not live inference.
      return Response.json({
        message: {
          role: 'assistant',
          content:
            result.data?.caption || `${text}: ${result.feedProvenance.overall}`,
        },
        toolCalls: [],
      });
    },
  });
  const events = [];
  const result = await session.send(text, {
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 2);
  assert.ok(events.some((e) => e.type === 'tool-result'));
  return result.content;
}

for (const locale of ['en', 'es'])
  for (const state of ['nominal', 'partial', 'degraded', 'stale']) {
    test(`${locale} typed view and voice/HUD evidence agree for ${state}`, async (tcase) => {
      if (!LAYER_FEED_STATES.includes('partial'))
        return tcase.skip('Enable after independently integrating #1488');
      setLocale(locale);
      tcase.after(() => setLocale('en'));
      const { runner, rows } = viewRunner(state);
      const voice = await runner('get_current_view_state', {});
      assert.equal(voice.feedProvenance.overall, state);
      assert.equal(hudSummaryLayerContext(rows).feedProvenance.overall, state);
      await typedRoundTrip(
        runner,
        'get_current_view_state',
        {},
        locale === 'es'
          ? '¿Cuál es el estado actual de las capas?'
          : 'What is the current layer status?',
        (result) => assert.deepEqual(result, voice),
      );
      runner.dispose();
    });
    test(`${locale} typed caption preserves ${state} despite conflicting prose`, async (tcase) => {
      if (!LAYER_FEED_STATES.includes('partial'))
        return tcase.skip('Enable after independently integrating #1488');
      setLocale(locale);
      tcase.after(() => setLocale('en'));
      const weather = defineTool({
        name: 'get_weather',
        title: 'Fixture weather',
        description: 'A deterministic weather fixture',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
        run: async () => ({
          summary: 'Everything is fully available',
          data: state === 'nominal' ? {} : { [state]: true },
        }),
      });
      const contexts = [];
      const catalog = composeCatalog({
        tools: [weather, getHudCaption],
        services: {
          weather: {},
          summary: {
            getLocale,
            localizeLabel: t,
            summarize: async (context) => {
              contexts.push(context);
              return {
                ok: true,
                data: {
                  summary:
                    locale === 'es'
                      ? 'Todo disponible'
                      : 'Everything available',
                  feedState: 'nominal',
                },
              };
            },
          },
        },
      });
      const runner = withToolCatalog(
        async () => {
          throw Error('unexpected action');
        },
        async () => catalog,
      );
      const args = { area: { lat: 30.26, lon: -97.74, radius_km: 10 } };
      const voice = await runner('get_hud_caption', args);
      assert.equal(contexts[0].locale, locale);
      assert.equal(contexts[0].feedProvenance.overall, state);
      assert.equal(voice.data.feedState, state);
      if (state !== 'nominal') {
        assert.ok(
          voice.data.caption.startsWith(`${t(state.toUpperCase())} | `),
        );
        assert.doesNotMatch(
          voice.summary,
          /Everything available|Todo disponible/,
        );
      }
      const content = await typedRoundTrip(
        runner,
        'get_hud_caption',
        args,
        locale === 'es' ? 'Dame el resumen del HUD' : 'Give me the HUD summary',
        (result) => assert.deepEqual(result, voice),
      );
      assert.equal(content, voice.summary);
    });
  }

test('voice and COMMAND manuals prioritize structured feed evidence over prose', () => {
  for (const manual of [
    buildAgentInstructions(),
    realtimeDirectives().join('\n'),
  ]) {
    assert.match(manual, /partial means incomplete coverage/);
  }
  assert.match(realtimeDirectives().join('\n'), /Feed states override prose/);
  assert.match(buildAgentInstructions(), /data\.feedState as canonical/);
  assert.match(buildAgentInstructions(), /unknown, not nominal/);
});

import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'mgrs'
      ? { url: 'gev-provenance:mgrs', shortCircuit: true }
      : next(specifier, context);
  },
  load(url, context, next) {
    return url === 'gev-provenance:mgrs'
      ? {
          format: 'module',
          shortCircuit: true,
          source: 'export function forward(){return "10SEG55776339";}',
        }
      : next(url, context);
  },
});
for (const locale of ['en', 'es'])
  for (const state of ['nominal', 'partial', 'degraded', 'stale']) {
    test(`${locale} actual HUD accepts matching ${state} and rejects a mismatched warning state`, async (tcase) => {
      if (!LAYER_FEED_STATES.includes('partial'))
        return tcase.skip('Enable after independently integrating #1488');
      const { IntelHUD } = await import('../hud.js');
      const previous = {
        document: globalThis.document,
        window: globalThis.window,
      };
      const element = { textContent: '' };
      globalThis.document = {
        hidden: false,
        visibilityState: 'visible',
        getElementById: (id) => (id === 'hud-summary' ? element : null),
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {},
      };
      globalThis.window ??= {
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
      };
      tcase.mock.timers.enable({ apis: ['setInterval'] });
      setLocale(locale);
      let modelState = state;
      const words =
        locale === 'es'
          ? 'Vista del área seleccionada'
          : 'Selected area overview';
      const viewer = {
        scene: {
          canvas: { width: 0, height: 0 },
          pickPositionSupported: false,
        },
        camera: {
          pitch: -Math.PI / 2,
          heading: 0,
          positionCartographic: {
            latitude: 0.53,
            longitude: -1.7,
            height: 600,
          },
          computeViewRectangle: () => undefined,
          moveStart: { addEventListener() {}, removeEventListener() {} },
          moveEnd: { addEventListener() {}, removeEventListener() {} },
        },
      };
      const hud = new IntelHUD(viewer, {
        summaryService: {
          configured: async () => true,
          summarize: async (context) => {
            assert.equal(context.locale, locale);
            assert.equal(context.feedProvenance.overall, state);
            return {
              ok: true,
              status: 200,
              data: { summary: words, feedState: modelState },
            };
          },
        },
      });
      tcase.after(() => {
        hud.destroy();
        setLocale('en');
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete globalThis[key];
          else globalThis[key] = value;
        }
      });
      const fixture = viewRunner(state);
      hud._dataManager = { getAll: () => fixture.rows };
      tcase.after(() => fixture.runner.dispose());
      hud._latestMetrics = { altM: 600 };
      await hud._updateSummary(false, true);
      assert.ok(element.textContent.includes(words), element.textContent);
      if (state !== 'nominal') {
        assert.ok(
          element.textContent.startsWith(`${t(state.toUpperCase())} | `),
        );
        modelState = 'nominal';
        await hud._updateSummary(false, true);
        assert.ok(!element.textContent.includes(words), element.textContent);
        assert.ok(
          element.textContent.startsWith(`${t(state.toUpperCase())} | `),
        );
      }
    });
  }

test('bounded evidence keeps null unknown, byte-exact IDs and explicit omissions', () => {
  const id = 'référence  两  🛰️';
  const result = JSON.parse(
    boundedResultJson({
      ok: true,
      data: { feedState: null, unused: undefined, caption: 'x'.repeat(12000) },
      feedProvenance: {
        overall: 'partial',
        layers: Array.from({ length: 9 }, () => ({
          id,
          feedState: 'partial',
          name: 'x'.repeat(4000),
        })),
      },
    }),
  );
  assert.equal(result.data.feedState, null);
  assert.equal(result.feedProvenance.layers[0].id, id);
  assert.equal(result.feedProvenance.layersOmitted, 4);
  assert.equal(result.feedProvenance.overall, 'partial');
});

test('caption context reads the current UI language and partial section on every call without #1488', async (tcase) => {
  tcase.after(() => setLocale('en'));
  const contexts = [];
  const context = {
    services: {
      summary: {
        getLocale,
        localizeLabel: t,
        summarize: async (value) => {
          contexts.push(value);
          return {
            ok: true,
            data: { summary: 'Fixture caption', feedState: 'partial' },
          };
        },
      },
    },
    tools: {
      has: (name) => name === 'get_weather',
      call: async () => ({
        summary: 'Healthy sounding prose',
        data: { partial: true },
      }),
    },
  };
  for (const locale of ['en', 'es']) {
    setLocale(locale);
    await getHudCaption.run(
      { area: { lat: 30.26, lon: -97.74, radius_km: 10 } },
      context,
    );
    assert.equal(contexts.at(-1).locale, locale);
    assert.equal(contexts.at(-1).enabledLayers[0].feedState, 'partial');
    assert.equal(contexts.at(-1).enabledLayers[0].name, t('Weather'));
  }
});

test('even an enormous essential say line cannot erase canonical aggregate evidence', () => {
  const result = JSON.parse(
    boundedResultJson({
      ok: true,
      say: 'x'.repeat(20000),
      feedProvenance: { overall: 'partial', layers: [] },
      data: { feedState: 'partial' },
    }),
  );
  assert.equal(result.feedProvenance.overall, 'partial');
  assert.equal(result.data.feedState, 'partial');
  assert.match(result.error, /too large/);
});

test('the actual standalone catalog can execute a typed caption with the UI locale', async (tcase) => {
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  globalThis.document = { baseURI: 'http://localhost:4173/' };
  setLocale('es');
  tcase.after(() => {
    setLocale('en');
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  let sent;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('/api/openai/hud-summary')) {
      sent = JSON.parse(init.body);
      return Response.json({
        summary: 'Vista del área seleccionada',
        feedState: sent.feedProvenance.overall,
      });
    }
    return Response.json({});
  };
  const { loadToolCatalog } = await import('../standalone/toolCatalog.js');
  const catalog = await loadToolCatalog();
  assert.ok(catalog.get('get_hud_caption'));
  const result = await catalog.call('get_hud_caption', {
    area: { lat: 30.26, lon: -97.74, radius_km: 10 },
  });
  assert.equal(sent.locale, 'es');
  assert.match(result.summary, /Vista del área seleccionada/);
});
