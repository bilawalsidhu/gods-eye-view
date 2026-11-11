#!/usr/bin/env node
/**
 * Live Realtime auth acceptance with a prerecorded Chromium microphone.
 * Run against the local dev server after configuring the selected credential:
 * node scripts/qa-voice-auth.mjs http://127.0.0.1:4189 oauth microphone.wav
 * Use a short spoken reply request with three seconds of leading silence.
 * Saves only usage, transport metadata, and screenshots; never credentials.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = fileURLToPath(new URL('../', import.meta.url));
const url = new URL(process.argv[2] || 'http://127.0.0.1:4189');
const auth = process.argv[3] || 'oauth';
assert.ok(['oauth', 'api-key'].includes(auth), 'Choose oauth or api-key');
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
  'Use a local server',
);
assert.ok(process.argv[4], 'Provide a prerecorded microphone WAV');
const wav = path.resolve(process.argv[4]);
assert.ok(fs.existsSync(wav), 'Microphone WAV must exist');
url.searchParams.set('welcome', '0');
url.searchParams.set('setup', '1');
const output = path.join(root, '.gev-logs', 'voice-auth');
fs.mkdirSync(output, { recursive: true });
const executablePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : puppeteer.executablePath());
const browser = await puppeteer.launch({
  headless: true,
  executablePath,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}%noloop`,
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--window-size=1440,900',
  ],
});
const result = {
  ok: false,
  auth,
  input: 'prerecorded microphone',
  mints: [],
  negotiations: [],
};
let page;
const readSession = () =>
  page.evaluate(async () => {
    const voice = window.__godsEyeView.voiceCommands;
    const stats = voice.pc ? [...(await voice.pc.getStats()).values()] : [];
    const input = stats.find(
      (entry) => entry.type === 'outbound-rtp' && entry.kind === 'audio',
    );
    const source = stats.find(
      (entry) => entry.type === 'media-source' && entry.kind === 'audio',
    );
    const audio = stats.find(
      (entry) => entry.type === 'inbound-rtp' && entry.kind === 'audio',
    );
    const meter = document.getElementById('gev-voice-cost-value');
    return {
      ...window.__voiceAuthEvidence,
      connection: voice.pc?.connectionState,
      microphoneEnabled: voice.stream
        ?.getAudioTracks()
        .every((track) => track.enabled),
      inputBytes: input?.bytesSent || 0,
      inputAudioEnergy: source?.totalAudioEnergy ?? null,
      outputBytes: audio?.bytesReceived || 0,
      outputAudioEnergy: audio?.totalAudioEnergy || 0,
      playbackTime: voice.audioEl?.currentTime || 0,
      meter: {
        text: meter?.textContent,
        usage: meter?.title,
        visible: Boolean(meter?.getClientRects().length),
      },
    };
  });
try {
  await browser
    .defaultBrowserContext()
    .overridePermissions(url.origin, ['microphone']);
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('response', (response) => {
    const route = new URL(response.url()).pathname;
    if (route === '/api/realtime/token')
      result.mints.push({
        status: response.status(),
        auth: response.headers()['x-gev-voice-auth'],
        model: response.headers()['x-gev-voice-model'],
      });
    if (
      route === '/v1/realtime/calls' &&
      response.request().method() === 'POST'
    )
      result.negotiations.push({ status: response.status() });
  });
  // Observe the application's real transport. Do not replace fetch or replies.
  await page.evaluateOnNewDocument(() => {
    window.__voiceAuthEvidence = {
      speechStopped: 0,
      transcripts: [],
      replies: [],
      responses: [],
      errors: [],
      eventCounts: {},
    };
    const create = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      const channel = create.apply(this, args);
      channel.addEventListener('message', ({ data }) => {
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        const evidence = window.__voiceAuthEvidence;
        evidence.eventCounts[event.type] =
          (evidence.eventCounts[event.type] || 0) + 1;
        if (event.type === 'input_audio_buffer.speech_stopped')
          evidence.speechStopped += 1;
        if (
          event.type === 'conversation.item.input_audio_transcription.completed'
        )
          evidence.transcripts.push(event.transcript);
        if (event.type === 'response.output_audio_transcript.done')
          evidence.replies.push(event.transcript);
        if (event.type === 'response.done')
          evidence.responses.push({
            status: event.response?.status,
            inputTokens: event.response?.usage?.input_tokens,
            outputTokens: event.response?.usage?.output_tokens,
          });
        if (event.type === 'error')
          evidence.errors.push({ code: event.error?.code });
      });
      return channel;
    };
  });
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.voiceCommands &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 45_000 },
  );
  await page.waitForSelector('[data-cloud-voice-auth-toggle]', {
    visible: true,
  });
  await page.waitForFunction(
    () =>
      getComputedStyle(document.getElementById('key-setup')).opacity === '1',
  );
  const selected = await page.evaluate(
    () => localStorage.getItem('godsEyeView.voice.cloudAuth') || 'api-key',
  );
  if (selected !== auth) {
    await page.click('[data-cloud-voice-auth-toggle]');
    await page.waitForFunction(
      (mode) => localStorage.getItem('godsEyeView.voice.cloudAuth') === mode,
      { timeout: 125_000 },
      auth,
    );
  }
  await page.click('[data-key-setup-close]');
  await page.click('#gev-voice-button');
  await page.waitForFunction(
    () =>
      window.__godsEyeView.voiceCommands.dc?.readyState === 'open' ||
      window.__godsEyeView.voiceCommands.status === 'error',
    { timeout: 35_000 },
  );
  assert.equal(
    await page.evaluate(
      () => window.__godsEyeView.voiceCommands.dc?.readyState,
    ),
    'open',
    'Realtime channel must open',
  );
  await page.waitForFunction(
    () =>
      window.__voiceAuthEvidence.speechStopped > 0 &&
      window.__voiceAuthEvidence.responses.some(
        (response) =>
          response.status === 'completed' && response.outputTokens > 0,
      ),
    { timeout: 45_000 },
  );
  await page.waitForFunction(
    () =>
      window.__voiceAuthEvidence.eventCounts['output_audio_buffer.stopped'] > 0,
    { timeout: 30_000 },
  );
  result.session = await readSession();
  assert.ok(
    result.session.inputBytes > 0 && result.session.outputBytes > 0,
    'Audio must flow in both directions',
  );
  assert.ok(
    result.session.outputAudioEnergy > 0 && result.session.playbackTime > 0,
    'Reply audio must play',
  );
  assert.equal(
    result.session.meter.text === 'COST UNKNOWN',
    auth === 'oauth',
    'Use the correct accounting display',
  );
  await page.screenshot({ path: path.join(output, `${auth}-usage.png`) });
  await page.click('#key-setup-chip');
  await page.waitForSelector('[data-cloud-voice-auth-toggle]', {
    visible: true,
  });
  await page.waitForFunction(
    () =>
      getComputedStyle(document.getElementById('key-setup')).opacity === '1',
  );
  await page.screenshot({ path: path.join(output, `${auth}-settings.png`) });
  await page.click('[data-key-setup-close]');
  result.stopped = await page.evaluate(() => {
    const voice = window.__godsEyeView.voiceCommands;
    const pc = voice.pc;
    const tracks = voice.stream?.getTracks() || [];
    voice.session.stop();
    return (
      pc.connectionState === 'closed' &&
      tracks.every((track) => track.readyState === 'ended')
    );
  });
  assert.ok(result.stopped, 'Stop must close the peer and microphone tracks');
  await page.click('#gev-voice-button');
  await page.waitForFunction(
    () =>
      window.__godsEyeView.voiceCommands.dc?.readyState === 'open' ||
      window.__godsEyeView.voiceCommands.status === 'error',
    { timeout: 35_000 },
  );
  assert.equal(
    await page.evaluate(
      () => window.__godsEyeView.voiceCommands.dc?.readyState,
    ),
    'open',
    'Reconnect must work',
  );
  assert.equal(
    result.mints.length,
    2,
    'Reconnect must request a fresh client secret',
  );
  assert.ok(
    result.mints.every(
      (mint) =>
        mint.status === 200 &&
        mint.auth === (auth === 'oauth' ? 'codex-oauth' : 'env'),
    ),
  );
  assert.ok(result.negotiations.every((entry) => entry.status === 201));
  result.ok = true;
} catch (error) {
  result.error = error.message;
  if (page) {
    result.session = await readSession().catch(() => null);
    result.detail = await page
      .$eval('#gev-voice-detail', (element) => element.textContent)
      .catch(() => null);
    await page
      .screenshot({ path: path.join(output, `${auth}-failure.png`) })
      .catch(() => {});
  }
} finally {
  await page
    ?.evaluate(() => window.__godsEyeView?.voiceCommands?.session?.stop())
    .catch(() => {});
  await browser.close();
  fs.writeFileSync(
    path.join(output, `${auth}-result.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
}
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
