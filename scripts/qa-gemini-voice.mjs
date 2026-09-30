#!/usr/bin/env node
/** Real Gemini acceptance: feed a WAV through Chromium's microphone and await spoken output.
 * Example: node scripts/qa-gemini-voice.mjs --wav path/to/question.wav --expect-response 'four|4'
 * Requires a configured Gemini key in the running app; never reads the permanent key.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const appUrl = new URL(option('--url', 'http://127.0.0.1:43981/'));
appUrl.searchParams.set('welcome', '0');
const wav = option('--wav');
if (!wav)
  throw new Error(
    'Pass --wav with a PCM WAV containing the spoken test request.',
  );
const wavPath = path.resolve(wav);
const fixture = await fs.readFile(wavPath);
if (
  fixture.toString('ascii', 0, 4) !== 'RIFF' ||
  fixture.toString('ascii', 8, 12) !== 'WAVE'
)
  throw new Error('The microphone fixture must be a WAV file.');
const expectedResponse = option('--expect-response', 'four|4');
const expectedInput = option('--expect-input', 'two plus two|2 plus 2|2 \\+ 2');
const requiredAction = option('--expect-action', '');
const minimumHeight = Number(option('--min-height', '0'));
const outDir = path.resolve(option('--out', 'qa-shots/gemini-voice'));
await fs.mkdir(outDir, { recursive: true });
const browser = await puppeteer.launch({
  headless: !args.includes('--headed'),
  args: [
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wavPath}%noloop`,
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--window-size=1440,900',
  ],
});
let result;
try {
  const context = browser.defaultBrowserContext();
  await context.overridePermissions(appUrl.origin, ['microphone']);
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  // Only the test input device is substituted. GEV still captures this browser
  // MediaStream through its real AudioWorklet and calls the real Gemini API.
  if (args.includes('--virtual-mic')) {
    await page.evaluateOnNewDocument((base64) => {
      const original = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (!constraints.audio || constraints.video)
          return original(constraints);
        const context = new AudioContext();
        await context.resume();
        const bytes = Uint8Array.from(atob(base64), (char) =>
          char.charCodeAt(0),
        );
        const buffer = await context.decodeAudioData(bytes.buffer);
        const source = context.createBufferSource();
        source.buffer = buffer;
        const destination = context.createMediaStreamDestination();
        source.connect(destination);
        const stream = destination.stream;
        const track = stream.getAudioTracks()[0];
        const stop = track.stop.bind(track);
        track.stop = () => {
          try {
            source.stop();
          } catch {
            /* Already ended. */
          }
          source.disconnect();
          destination.disconnect();
          void context.close().catch(() => {});
          stop();
        };
        source.start(context.currentTime + 0.25);
        return stream;
      };
    }, fixture.toString('base64'));
  }
  const tokenStatuses = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/gemini/token')
      tokenStatuses.push(response.status());
  });
  await page.goto(appUrl.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => {
      const loading = document.getElementById('loading-screen');
      return (
        window.__godsEyeView?.voiceCommands &&
        document.getElementById('gev-voice-provider') &&
        (!loading ||
          getComputedStyle(loading).display === 'none' ||
          Number(getComputedStyle(loading).opacity) === 0)
      );
    },
    { timeout: 90000 },
  );
  await page.select('#gev-voice-provider', 'gemini');
  await page.evaluate(() => {
    window.__geminiAcceptance = { transcripts: [], actions: [] };
    window.__godsEyeView.voiceCommands.session.subscribe((event) => {
      if (event.type === 'transcript' && event.final)
        window.__geminiAcceptance.transcripts.push({
          role: event.role,
          text: event.text,
        });
      if (event.type === 'action-result')
        window.__geminiAcceptance.actions.push({
          name: event.name,
          ok: event.result?.ok === true,
        });
    });
  });
  const began = Date.now();
  await page.click('#gev-voice-button');
  let timedOut = false;
  try {
    await page.waitForFunction(
      () => {
        const voice = window.__godsEyeView.voiceCommands;
        const d = voice.getDiagnostics();
        return (
          d.status === 'error' ||
          (d.completedTurns > 0 &&
            d.audio?.outputSamples > 0 &&
            (d.audio.discardedOutputSamples > 0 ||
              (d.audio.completedOutputSamples === d.audio.outputSamples &&
                d.audio.queuedSeconds < 0.05)))
        );
      },
      { timeout: 75000 },
    );
  } catch {
    timedOut = true;
  }
  const proof = await page.evaluate(() => ({
    ...window.__geminiAcceptance,
    diagnostics: window.__godsEyeView.voiceCommands.getDiagnostics(),
    provider: document.querySelector('#gev-voice-provider').value,
    detail: document.querySelector('#gev-voice-detail').textContent,
    cameraHeightM:
      window.__godsEyeView.viewer.camera.positionCartographic.height,
  }));
  const userText = proof.transcripts
    .filter((item) => item.role === 'user')
    .map((item) => item.text)
    .join(' ');
  const assistantText = proof.transcripts
    .filter((item) => item.role === 'assistant')
    .map((item) => item.text)
    .join(' ');
  // A completed Radio handoff releases Gemini's speaker and microphone.
  // Closed audio is valid only when the successful handoff is already idle.
  const completedRadioHandoff =
    proof.actions.some(
      (action) => action.name === 'control_radio' && action.ok,
    ) &&
    proof.diagnostics.status === 'idle' &&
    !proof.diagnostics.connected &&
    !proof.diagnostics.microphoneActive &&
    proof.diagnostics.audio?.resourcesReleased === true;
  const checks = {
    geminiSelected: proof.provider === 'gemini',
    tokenGranted: tokenStatuses.includes(200),
    heardInput: new RegExp(expectedInput, 'i').test(userText),
    expectedReply: new RegExp(expectedResponse, 'i').test(assistantText),
    realMicrophoneFrames:
      proof.diagnostics.audio?.inputChunks > 0 &&
      proof.diagnostics.audio?.nonSilentInputChunks > 0,
    playedReply:
      proof.diagnostics.audio?.outputSamples > 0 &&
      proof.diagnostics.audio.completedOutputSamples ===
        proof.diagnostics.audio.outputSamples &&
      proof.diagnostics.audio.discardedOutputSamples === 0 &&
      proof.diagnostics.audio.queuedSeconds < 0.05 &&
      (proof.diagnostics.audio.contextState === 'running' ||
        (completedRadioHandoff &&
          proof.diagnostics.audio.contextState === 'closed')),
    completed:
      !timedOut &&
      proof.diagnostics.completedTurns > 0 &&
      proof.diagnostics.status !== 'error',
    action:
      !requiredAction ||
      proof.actions.some(
        (action) => action.name === requiredAction && action.ok,
      ),
    camera: !minimumHeight || proof.cameraHeightM >= minimumHeight,
  };
  await page.screenshot({ path: path.join(outDir, 'response.png') });
  // Stop is idempotent; toggling the button could restart an idle session
  // after Radio has taken the speaker between proof collection and cleanup.
  await page.evaluate(() => window.__godsEyeView.voiceCommands.stop());
  const stopped = await page.evaluate(() =>
    window.__godsEyeView.voiceCommands.getDiagnostics(),
  );
  checks.stopped =
    stopped.status === 'idle' &&
    !stopped.connected &&
    !stopped.microphoneActive;
  result = {
    ok: Object.values(checks).every(Boolean),
    microphoneSource: args.includes('--virtual-mic')
      ? 'Web Audio virtual microphone from macOS WAV'
      : 'Chromium WAV capture device',
    checks,
    elapsedMs: Date.now() - began,
    fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
    tokenStatuses,
    ...proof,
    stopped,
  };
  await fs.writeFile(
    path.join(outDir, 'result.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result, null, 2));
  console.log(`VERDICT: ${result.ok ? 'PASS' : 'FAIL'}`);
  process.exitCode = result.ok ? 0 : 1;
} finally {
  await browser.close();
}
