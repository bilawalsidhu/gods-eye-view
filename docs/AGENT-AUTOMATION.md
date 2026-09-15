# Trusted Local Agent Automation

God's Eye View already has a structured browser action runner. The OpenAI Realtime voice agent
uses it for product actions, and `scripts/qa-voice-routing.mjs` calls the same runner from
Puppeteer for deterministic behavior tests:

```js
window.__gevVoiceCommands.runner(actionName, args)
```

This page shows how a **trusted local browser agent** can reuse that existing seam without adding
a network control server. It is intended for local QA, demos, and operator-approved automation.
It is not a versioned HTTP or MCP API.

## Security boundary

- Keep God's Eye View bound to `localhost`. The Vite server brokers spendable provider keys; do
  not expose it to a LAN merely to connect an agent.
- Give the agent an explicit action allowlist. Never accept arbitrary JavaScript or a runner
  expression from a model prompt.
- Treat camera, layer, map-stack, annotation, radio, scene, tracking, and cockpit actions as
  state-changing. Put an operator confirmation gate in front of them.
- The model must not be able to set `confirmed: true` itself. Inject approval from a trusted
  operator UI or workflow state outside model-controlled arguments.
- Serialize calls per page. Concurrent camera or layer operations can supersede one another.
- A thrown exception, timeout, missing runner, page close, or `{ ok: false }` is a failure. Do not
  turn the absence of an exception into a success claim.
- Do not read cookies, local storage, API keys, unrelated browser globals, screenshots, or
  arbitrary DOM content unless a separately reviewed tool requests that exact artifact.
- Keep the project's responsible-use line: public data only, no named-person search or face
  recognition, and no safety-critical or operational decisions from this exploratory display.

## Minimal Puppeteer adapter

Puppeteer is already a development dependency. Start God's Eye View normally on localhost, then
run a separate local script based on this pattern:

```js
import puppeteer from 'puppeteer';

const appUrl = process.env.GEV_URL || 'http://localhost:4173/?welcome=0';
const parsedUrl = new URL(appUrl);
if (!['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname)) {
  throw new Error('Refusing a non-local Gods Eye View target');
}

const allowedActions = new Set([
  'get_current_view_state',
  'fly_to_location',
  'set_layer_visibility',
]);
const confirmationRequired = new Set([
  'fly_to_location',
  'set_layer_visibility',
]);

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(
  () => typeof window.__gevVoiceCommands?.runner === 'function',
  { timeout: 120_000, polling: 250 },
);

let queue = Promise.resolve();
function runGevAction(name, args = {}, { confirmed = false } = {}) {
  if (!allowedActions.has(name)) {
    throw new Error(`Action is not allowlisted: ${name}`);
  }
  if (confirmationRequired.has(name) && !confirmed) {
    throw new Error(`Operator confirmation required: ${name}`);
  }

  const task = queue.then(() => page.evaluate(
    (actionName, actionArgs) => Promise.resolve(
      window.__gevVoiceCommands.runner(actionName, actionArgs),
    ).catch((error) => ({
      ok: false,
      error: String(error?.message || error),
      threw: true,
    })),
    name,
    args,
  ));
  queue = task.catch(() => {});
  return task.then((result) => {
    if (!result || result.ok !== true) {
      throw new Error(`Gods Eye View action failed: ${JSON.stringify(result)}`);
    }
    return result;
  });
}

try {
  const before = await runGevAction('get_current_view_state');
  console.log('Current view:', before);

  await runGevAction(
    'fly_to_location',
    { locationId: 'austin', waitForArrival: true },
    { confirmed: true },
  );
  await runGevAction(
    'set_layer_visibility',
    { layerId: 'earthquakes', enabled: true },
    { confirmed: true },
  );

  const after = await runGevAction('get_current_view_state');
  console.log('Updated view:', after);
} finally {
  await browser.close();
}
```

The example intentionally uses a fixed page expression and a small allowlist. A production agent
adapter should also add per-action timeouts, cancellation, correlation IDs, argument schemas,
audit logging, and secret/large-payload redaction.

The runner is initialized with the app even when no OpenAI voice session is active. The normal
God's Eye View prerequisites still apply, including the required Google Maps key described in the
Quick Start.

## Result contract

Runner actions return structured objects. Most include:

- `ok`: authoritative success/failure;
- `action`: the action that produced the result;
- state-specific fields such as layer lifecycle, camera position, tracking, coverage, or errors.

`set_layer_visibility` is an important example: it waits for the layer lifecycle and can report
cancellation, an upstream failure, or a state that did not settle. Preserve that result instead of
claiming success because a request was sent.

`get_current_view_state` is the safest first integration target. It returns camera, visual style,
context/cockpit state, controls, scene playback, tracked entities, and loaded layer summaries
without changing the view.

## Astron Agent pattern

An Astron integration can use the existing RPA/browser boundary to keep the target page local:

1. Start or attach to the operator's localhost page.
2. Wait for the fixed runner expression.
3. Expose only reviewed action names and JSON schemas as agent tools.
4. Require operator confirmation for state-changing or potentially metered actions.
5. Execute calls sequentially and preserve the runner's result verbatim.
6. Record the action, normalized arguments, duration, result status, origin, and correlation ID.

The corresponding Astron design is tracked in
[iflytek/astron-agent#1659](https://github.com/iflytek/astron-agent/issues/1659).

## Authoritative references

- Action dispatcher: [`src/voice/gevActions.js`](../src/voice/gevActions.js)
- Voice/controller initialization: [`src/voice/gevRealtime.js`](../src/voice/gevRealtime.js)
- Deterministic browser QA: [`scripts/qa-voice-routing.mjs`](../scripts/qa-voice-routing.mjs)
- Network and key threat model: [`SECURITY.md`](../SECURITY.md)
- Runtime behavior: [`docs/CURRENT-STATE.md`](CURRENT-STATE.md)
