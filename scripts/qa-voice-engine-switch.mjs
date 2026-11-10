import { closeBrowser, exitAfterFlush } from './qa/browser.mjs';
import { localPreview, waitForEngine } from './qa-strict-harness.mjs';
// An active voice session survives engine switches. With a fake microphone
// and a fake Realtime transport (no model is reached: /api/openai, /api/realtime
// and api.openai.com are blocked or answered in the page), this gate starts
// voice on Cesium, switches Cesium→Navara→Cesium→Navara and checks that:
//   - the microphone was requested once, one peer connection was made, and
//     neither it nor its data channel closed; no WebSocket opened;
//   - every session object kept its identity and each switch attached once;
//   - a set_layer_visibility call after each switch ran on the engine shown;
//   - a call made during a switch waited and ran on the incoming engine, and
//     one whose wait ran out was refused with ENGINE_SWITCHING;
//   - annotate_map works on both engines and marks survive each switch;
//   - the session heard which engine it drives after each switch.
//
// node scripts/qa-voice-engine-switch.mjs http://127.0.0.1:<port>/
import assert from 'node:assert/strict';
import {
  idDifference,
  launch,
  openSessionPage,
  readSession,
  readVoiceEvidence,
  requestEngine,
  sessionAddress,
  switchEngine,
} from './qa/appSessionHarness.mjs';

const base = localPreview(process.argv[2]);

// Play one server function call on the fake data channel and wait for the
// client's function_call_output.
function callTool(page, name, args, { beforeCall = null } = {}) {
  return page.evaluate(
    async (name, args, beforeCall) => {
      const evidence = window.__qaVoice;
      const callId = `qa-call-${(window.__qaCalls = (window.__qaCalls ?? 0) + 1)}`;
      const responseId = `qa-response-${callId}`;
      const deliver = (event) =>
        evidence.channel.dispatchEvent(
          new MessageEvent('message', { data: JSON.stringify(event) }),
        );
      if (beforeCall === 'switch-navara' || beforeCall === 'switch-cesium') {
        const select = document.querySelector('#globe-engine');
        select.value = beforeCall.slice('switch-'.length);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      deliver({ type: 'response.created', response: { id: responseId } });
      deliver({
        type: 'response.function_call_arguments.done',
        response_id: responseId,
        item_id: `item-${callId}`,
        call_id: callId,
        name,
        arguments: JSON.stringify(args),
      });
      const started = performance.now();
      for (;;) {
        const sent = evidence.sent.find(
          (event) =>
            event?.type === 'conversation.item.create' &&
            event.item?.type === 'function_call_output' &&
            event.item.call_id === callId,
        );
        if (sent) {
          deliver({
            type: 'response.done',
            response: { id: responseId, status: 'completed', output: [] },
          });
          return JSON.parse(sent.item.output);
        }
        if (performance.now() - started > 60_000)
          throw new Error(`No output for ${name}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    name,
    args,
    beforeCall,
  );
}

const engineChanges = (page) =>
  page.evaluate(() =>
    window.__qaVoice.sent
      .filter(
        (event) =>
          event?.type === 'conversation.item.create' &&
          event.item?.role === 'system',
      )
      .map((event) => {
        try {
          return JSON.parse(event.item.content[0].text);
        } catch {
          return null;
        }
      })
      .filter((event) => event?.type === 'engine-changed')
      .map((event) => event.engine),
  );

const ANNOTATION = {
  annotations: [
    {
      type: 'pin',
      latitude: 42.3554,
      longitude: -71.0605,
      label: 'QA voice mark',
    },
  ],
};

const browser = await launch();
const results = [];
try {
  const { page, errors } = await openSessionPage(
    browser,
    sessionAddress(base, { engine: 'cesium' }),
  );
  await waitForEngine(page, 'cesium', { timeout: 90_000 });
  await page.evaluate(async () => {
    const close = document.querySelector('[data-key-setup-close]');
    if (close?.offsetParent) close.click();
    await window.__godsEyeView.voiceCommands.start({ pushToTalk: false });
  });
  await page.waitForFunction(
    () =>
      window.__qaVoice.channel?.readyState === 'open' &&
      window.__godsEyeView.voiceCommands.state === 'listening',
    { timeout: 30_000 },
  );
  const started = await readVoiceEvidence(page);
  const boot = await readSession(page);
  assert.equal(started.getUserMedia, 1, 'voice asks for the microphone once');
  assert.equal(started.peerConnections, 1);

  const annotated = await callTool(page, 'annotate_map', ANNOTATION);
  assert.equal(annotated.ok, true, JSON.stringify(annotated));
  assert.equal(annotated.engine, 'cesium');
  let marks = await page.evaluate(() => window.__gevAnnotations.count());
  assert.ok(marks >= 1, 'the mark is on the board');
  results.push('PASS annotate_map drew a mark on Cesium');

  const sequence = ['navara', 'cesium', 'navara'];
  for (const kind of sequence) {
    await switchEngine(page, kind);
    const layer = await callTool(page, 'set_layer_visibility', {
      layerId: 'earthquakes',
      enabled: kind === 'navara',
    });
    assert.equal(layer.engine, kind, JSON.stringify(layer));
    assert.equal(
      await page.evaluate(() => window.__godsEyeView.engine.kind),
      kind,
    );
    const count = await page.evaluate(() => window.__gevAnnotations.count());
    assert.equal(count, marks, 'the marks survived the switch');
    const annotation = await callTool(page, 'annotate_map', {
      annotations: [
        {
          type: 'pin',
          latitude: 42.3554 + marks * 0.01,
          longitude: -71.0605,
          label: `QA voice mark ${marks}`,
        },
      ],
    });
    assert.equal(annotation.ok, true, JSON.stringify(annotation));
    assert.equal(annotation.engine, kind);
    marks = await page.evaluate(() => window.__gevAnnotations.count());
    assert.equal(marks, count + 1, 'voice added a visible mark on this engine');
    assert.equal(
      await page.evaluate(() => window.__gevAnnotations.attached),
      true,
    );
    results.push(`PASS ${kind}: annotate_map drew a mark`);
    results.push(`PASS ${kind}: set_layer_visibility ran on ${layer.engine}`);
  }

  // A call made during a switch waits for the incoming engine.
  const midSwitch = await callTool(
    page,
    'set_layer_visibility',
    { layerId: 'earthquakes', enabled: true },
    { beforeCall: 'switch-cesium' },
  );
  await waitForEngine(page, 'cesium', { timeout: 90_000 });
  assert.equal(midSwitch.ok, true, JSON.stringify(midSwitch));
  assert.equal(midSwitch.engine, 'cesium', JSON.stringify(midSwitch));
  results.push('PASS a call made during the switch ran on the incoming engine');
  assert.equal(
    await page.evaluate(() => window.__gevAnnotations.count()),
    marks,
    'the mark is still on the board after Cesium→Navara→Cesium→Navara→Cesium',
  );

  // A call whose wait runs out is refused with a clear code.
  await page.evaluate(() => {
    window.__godsEyeView.voiceCommands.runner.switchWaitMs = 1;
  });
  const refused = await callTool(
    page,
    'set_layer_visibility',
    { layerId: 'earthquakes', enabled: false },
    { beforeCall: 'switch-navara' },
  );
  await waitForEngine(page, 'navara', { timeout: 90_000 });
  await page.evaluate(() => {
    window.__godsEyeView.voiceCommands.runner.switchWaitMs = 15_000;
  });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.code, 'ENGINE_SWITCHING', JSON.stringify(refused));
  results.push(
    'PASS a call whose wait ran out was refused with ENGINE_SWITCHING',
  );

  await switchEngine(page, 'cesium');
  const after = await readVoiceEvidence(page);
  const state = await readSession(page);
  const changes = await engineChanges(page);
  const switches = sequence.length + 3;
  const report = {
    started,
    after,
    ids: idDifference(boot.ids, state.ids),
    counters: state.counters,
    changes,
    voiceState: await page.evaluate(
      () => window.__godsEyeView.voiceCommands.state,
    ),
  };
  console.log(JSON.stringify(report, null, 2));
  assert.equal(after.getUserMedia, 1, 'no new microphone request');
  assert.equal(after.peerConnections, 1, 'no new peer connection');
  assert.equal(after.peerConnectionsClosed, 0, 'the connection stayed open');
  assert.equal(after.channelsClosed, 0, 'the data channel stayed open');
  assert.equal(after.channelState, 'open');
  assert.equal(after.webSockets, started.webSockets, 'no new WebSocket');
  assert.equal(after.tokenRequests, 1, 'no new token');
  assert.equal(report.voiceState, 'listening');
  assert.deepEqual(report.ids, {}, 'session objects kept their identity');
  assert.equal(
    state.counters.attachments,
    boot.counters.attachments + switches,
  );
  assert.equal(changes.length, switches, JSON.stringify(changes));
  assert.equal(changes.at(-1), 'cesium');
  assert.deepEqual(errors, []);
  results.push('PASS the voice session kept its microphone and transport');

  await page.evaluate(() => window.__godsEyeView.voiceCommands.stop());
  await page.waitForFunction(
    () => window.__qaVoice.peerConnectionsClosed === 1,
  );
  results.push('PASS stopping voice closes the transport');
  console.log(results.join('\n'));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await closeBrowser(browser);
}
await exitAfterFlush();
