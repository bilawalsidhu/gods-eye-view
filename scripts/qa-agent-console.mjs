#!/usr/bin/env node
/**
 * Browser QA for GEV COMMAND, the typed agent console.
 *
 * Drives the real console in the real app and proves the whole path: the chip
 * opens the dialog, the pickers fill from the live endpoints, and one typed
 * command travels through the server relay and the client tool loop to a
 * state change on the globe that this script reads back from the viewer.
 *
 * Needs a dev server and a reachable provider. Defaults to Ollama, which
 * needs no credential:
 *
 *   docker run -d --gpus all -p 11434:11434 \
 *     -e OLLAMA_CONTEXT_LENGTH=32768 --name gev-ollama ollama/ollama
 *   docker exec gev-ollama ollama pull qwen3:4b
 *   npm run dev
 *   node scripts/qa-agent-console.mjs --url http://localhost:4173
 *
 * With `--provider openai` it uses whatever OPENAI_API_KEY the server holds.
 * `--offline` skips the command leg and checks only the chrome and the
 * endpoints, which is the useful mode when no provider is configured.
 *
 * Args: --url <base>, --provider <id>, --model <id>, --command <text>,
 *       --offline.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
  hookRenderErrors,
  readRenderErrors,
  saveFailureArtifacts,
  watchPage,
} from './qa-browserEvidence.mjs';

export const ARTIFACT_DIR = 'qa-artifacts/agent-console';
const VIEWPORT = { width: 1440, height: 900 };

/** A local model can spend minutes on a cold load plus prompt processing. */
const COMMAND_TIMEOUT_MS = 360_000;

/**
 * The default command and the viewer state that proves it ran.
 *
 * Deliberately a visual style rather than a camera flight: the style is a
 * single discrete value the viewer reports exactly, so the assertion cannot
 * pass on a coincidence the way "the camera moved" can.
 */
const DEFAULT_COMMAND = 'switch to night vision';
const EXPECTED_STYLE = 'surveillance';

function parseArgs(argv) {
  const value = (name, fallback = null) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  return {
    url: value('url', 'http://localhost:4173'),
    provider: value('provider', process.env.GEV_AGENT_PROVIDER || 'ollama'),
    model: value('model', process.env.GEV_AGENT_MODEL || ''),
    command: value('command', DEFAULT_COMMAND),
    offline: argv.includes('--offline'),
  };
}

/** Report one check, collecting failures so every check still runs. */
function checker() {
  const failures = [];
  return {
    failures,
    check(label, condition, detail = '') {
      if (!condition) failures.push(label);
      console.log(
        `  [${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`,
      );
    },
  };
}

/**
 * Open the app and clear everything that covers the chip.
 *
 * The loading screen stays in the layout until its fade finishes, and it
 * covers the whole viewport, so a click on the chip lands on the cover
 * instead. Waiting for the fade and then removing both it and the first-run
 * launcher is what makes the chip reachable by a real pointer.
 */
async function boot(page, url) {
  await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__godsEyeView?.viewer, {
    timeout: 90_000,
  });
  await page
    .waitForFunction(
      () =>
        document.getElementById('loading-screen')?.classList.contains('hidden'),
      { timeout: 90_000 },
    )
    .catch(() => {});
  await page.evaluate(() => {
    document.querySelector('.first-run-explore')?.click();
    document.getElementById('loading-screen')?.remove();
    document.getElementById('first-run-launcher')?.remove();
    for (const node of document.querySelectorAll('[class*=first-run]'))
      node.remove();
  });
}

/** The console's own view of itself, read from the live DOM. */
function readConsole(page) {
  return page.evaluate(() => {
    const dialog = document.getElementById('agent-console');
    const options = (id) =>
      [...document.getElementById(id).options].map((option) => option.value);
    return {
      mounted: Boolean(dialog),
      open: dialog?.open === true,
      chipExpanded:
        document.getElementById('agent-console-chip')?.getAttribute('aria-expanded'),
      status: document.getElementById('agent-status')?.textContent ?? '',
      cost: document.getElementById('agent-cost')?.textContent ?? '',
      providers: options('agent-provider'),
      provider: document.getElementById('agent-provider')?.value ?? '',
      models: options('agent-model'),
      model: document.getElementById('agent-model')?.value ?? '',
      inputDisabled: document.getElementById('agent-input')?.disabled !== false,
      entries: [...document.getElementById('agent-transcript').children].map(
        (child) => ({
          kind: child.className.replace('agent-entry agent-entry-', ''),
          text: child.textContent,
          outcome: child.dataset.outcome ?? null,
        }),
      ),
    };
  });
}

/**
 * Wait for the provider listing to arrive and the model listing to settle.
 *
 * The console loads both on first open, and the status line reads READY
 * before the first request resolves, so waiting on the status alone would
 * pass instantly against an empty picker.
 */
async function settlePickers(page) {
  await page
    .waitForFunction(
      () => document.getElementById('agent-provider').options.length > 0,
      { timeout: 60_000 },
    )
    .catch(() => {});
  await page
    .waitForFunction(
      () =>
        !/loading models/.test(
          document.getElementById('agent-status').textContent,
        ),
      { timeout: 60_000 },
    )
    .catch(() => {});
}

async function main() {
  const { default: puppeteer } = await import('puppeteer');
  const options = parseArgs(process.argv.slice(2));
  const { check, failures } = checker();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (await puppeteer.executablePath()),
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const monitors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    const errors = [];
    monitors.push(watchPage(page, { name: 'agent-console', errors }));
    await hookRenderErrors(page);
    const agentCalls = [];
    page.on('response', (response) => {
      const path = response.url().replace(options.url, '');
      if (path.startsWith('/api/agent/'))
        agentCalls.push({ path, status: response.status() });
    });

    console.log(`GEV COMMAND gate against ${options.url}`);
    await boot(page, options.url);

    console.log('chrome');
    const mount = await page.evaluate(() => ({
      handle: Boolean(window.__godsEyeView?.agentConsole),
      chipHidden: document.getElementById('agent-console-chip')?.hidden,
    }));
    check('the application mounted the console', mount.handle);
    check('the chip is revealed once the console mounts', mount.chipHidden === false);
    check(
      'nothing is fetched before the console is opened',
      agentCalls.length === 0,
      agentCalls.map((call) => call.path).join(', '),
    );

    await page.click('#agent-console-chip');
    await page.waitForFunction(
      () => document.getElementById('agent-console')?.open === true,
      { timeout: 10_000 },
    );
    await settlePickers(page);

    let state = await readConsole(page);
    check('the dialog opens from the chip', state.open);
    check('the chip reports its expanded state', state.chipExpanded === 'true');
    check(
      'the provider picker lists every registered provider',
      state.providers.length >= 3,
      state.providers.join(', '),
    );
    check(
      'config and models were both requested',
      agentCalls.some((call) => call.path.startsWith('/api/agent/config')) &&
        agentCalls.some((call) => call.path.startsWith('/api/agent/models')),
      agentCalls.map((call) => `${call.path} ${call.status}`).join(' · '),
    );

    if (state.provider !== options.provider) {
      await page.select('#agent-provider', options.provider);
      await settlePickers(page);
      state = await readConsole(page);
    }
    check(
      `the ${options.provider} provider is selected`,
      state.provider === options.provider,
      state.provider,
    );

    if (options.offline) {
      console.log('offline: skipping the command leg');
    } else {
      check(
        'the provider offers at least one usable model',
        state.models.length > 0,
        state.status,
      );
      if (options.model && state.models.includes(options.model)) {
        await page.select('#agent-model', options.model);
        state = await readConsole(page);
      }
      check('a cost estimate is shown for the selected model', Boolean(state.cost));
      check('input is enabled once a model is selected', !state.inputDisabled);

      if (!state.inputDisabled) {
        console.log(`command: ${options.command}`);
        await page.evaluate(() => {
          window.__godsEyeView.styleManager.setStyle('normal', {
            userInitiated: true,
          });
        });
        await page.type('#agent-input', options.command);
        await page.click('#agent-send');
        await page
          .waitForFunction(
            () =>
              document.getElementById('agent-status').textContent === 'READY' &&
              document.getElementById('agent-transcript').children.length > 1,
            { polling: 500, timeout: COMMAND_TIMEOUT_MS },
          )
          .catch(() => {});
        state = await readConsole(page);
        for (const entry of state.entries) {
          console.log(
            `    ${entry.kind}: ${entry.text}${entry.outcome ? ` [${entry.outcome}]` : ''}`,
          );
        }
        const toolEntries = state.entries.filter((entry) => entry.kind === 'tool');
        check(
          'the typed command issued at least one tool call',
          toolEntries.length > 0,
        );
        check(
          'every tool call the console ran reported success',
          toolEntries.every((entry) => entry.outcome === 'ok'),
          toolEntries.map((entry) => entry.outcome).join(', '),
        );
        check(
          'the agent wrote a confirmation',
          state.entries.some((entry) => entry.kind === 'agent' && entry.text),
        );
        const applied = await page.evaluate(
          () => window.__godsEyeView.styleManager.activeStyle || 'normal',
        );
        check(
          'the globe actually changed state',
          options.command === DEFAULT_COMMAND
            ? applied === EXPECTED_STYLE
            : applied !== 'normal',
          `style is ${applied}`,
        );
        check(
          'the command endpoint answered 200',
          agentCalls
            .filter((call) => call.path.startsWith('/api/agent/command'))
            .every((call) => call.status === 200),
          agentCalls
            .filter((call) => call.path.startsWith('/api/agent/command'))
            .map((call) => call.status)
            .join(', '),
        );
      }
    }

    console.log('window');
    const geometry = () =>
      page.evaluate(() => {
        const rect = document.getElementById('agent-console').getBoundingClientRect();
        return {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      });
    const placed = await geometry();
    const credits = await page.evaluate(() => {
      const node = document.querySelector('.cesium-widget-credits');
      return node ? Math.round(node.getBoundingClientRect().top) : null;
    });
    check(
      'the console opens on the left',
      placed.left + placed.width < VIEWPORT.width / 2,
      `left ${placed.left}, width ${placed.width}`,
    );
    check(
      'the console clears the map attribution',
      credits === null || placed.top + placed.height <= credits,
      `console ends ${placed.top + placed.height}, credits start ${credits}`,
    );

    // Drag by the header, which is the gesture the operator actually makes.
    await page.mouse.move(placed.left + 120, placed.top + 14);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(placed.left + 120 + step * 30, placed.top + 14 + step * 8);
    }
    await page.mouse.up();
    const dragged = await geometry();
    check(
      'the header drags the window',
      dragged.left === placed.left + 240 && dragged.top === placed.top + 64,
      `moved to ${dragged.left},${dragged.top}`,
    );
    check(
      'the window it was left in is remembered',
      await page.evaluate(() =>
        Boolean(localStorage.getItem('godsEyeView.agent.console.box.v1')),
      ),
    );

    // Resize from the corner grip.
    const grip = await page.evaluate(() => {
      const rect = document
        .querySelector('#agent-console .panel-resize-grip')
        .getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    });
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(grip.x + step * 15, grip.y + step * 5);
    }
    await page.mouse.up();
    const resized = await geometry();
    check(
      'the corner grip resizes the window',
      resized.width > dragged.width && resized.left === dragged.left,
      `${dragged.width}px to ${resized.width}px`,
    );

    console.log('teardown');
    await page.keyboard.press('Escape');
    state = await readConsole(page);
    check('Escape closes the dialog', !state.open);
    check('the chip reports its collapsed state', state.chipExpanded === 'false');

    const renderErrors = await readRenderErrors(page);
    check(
      'no console or render errors',
      errors.length === 0 && renderErrors.length === 0,
      [...errors, ...renderErrors].slice(0, 3).join(' | '),
    );

    assert.deepEqual(failures, [], `failed checks: ${failures.join(', ')}`);
    console.log('GEV COMMAND gate PASSED');
  } catch (error) {
    await saveFailureArtifacts({ dir: ARTIFACT_DIR, browser, monitors, error });
    throw error;
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
