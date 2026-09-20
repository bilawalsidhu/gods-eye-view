#!/usr/bin/env node
// End-to-end check for the local voice server (AI_PROVIDER=ollama) without a
// browser or microphone: connect to the WebSocket, send a spoken WAV fixture,
// and expect transcript -> tool_call -> text -> audio_end. Exits 0 on success.
//
//   node scripts/qa-local-voice.mjs [--url ws://localhost:4173/api/voice/ws]
//        [--fixture scripts/fixtures/voice/local-fly-to-paris.wav]
//        [--expect-tool fly_to_location[,alt]] [--expect-text paris] [--timeout 90000]
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const url = args.get('url') || 'ws://localhost:4173/api/voice/ws';
const fixture =
  args.get('fixture') || 'scripts/fixtures/voice/local-fly-to-paris.wav';
const expectTools = (args.get('expect-tool') || 'fly_to_location').split(',');
const expectText = new RegExp(args.get('expect-text') || 'paris', 'i');
const timeoutMs = Number(args.get('timeout')) || 90_000;

const wav = readFileSync(fixture);
const t0 = Date.now();
const elapsed = () => Date.now() - t0;
const steps = {
  ready: null,
  transcriptMs: null,
  transcript: null,
  toolCallMs: null,
  toolCall: null,
  textMs: null,
  text: null,
  firstAudioMs: null,
  audioChunks: 0,
  audioEndMs: null,
  errors: [],
};

const ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';
const finish = (ok, reason) => {
  const health = steps.ready
    ? {
        device: steps.ready.device,
        whisperModel: steps.ready.whisperModel,
        tts: steps.ready.tts,
        model: steps.ready.model,
      }
    : null;
  console.log(
    JSON.stringify(
      { ok, reason, elapsedMs: elapsed(), health, ...steps, ready: undefined },
      null,
      2,
    ),
  );
  try {
    ws.close();
  } catch {
    /* no-op */
  }
  process.exit(ok ? 0 : 1);
};
const timer = setTimeout(() => finish(false, `timeout after ${timeoutMs} ms`), timeoutMs);
timer.unref?.();

ws.on('error', (error) => finish(false, `socket error: ${error.message}`));
ws.on('close', (code) => {
  if (!steps.audioEndMs) finish(false, `socket closed (${code}) before audio_end`);
});
ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  let frame;
  try {
    frame = JSON.parse(data.toString());
  } catch {
    return;
  }
  switch (frame.type) {
    case 'ready':
      steps.ready = frame;
      if (!frame.whisper) return finish(false, `worker has no speech recognition: ${frame.whisperReason}`);
      ws.send(wav);
      ws.send(JSON.stringify({ type: 'audio_end', format: 'wav' }));
      break;
    case 'transcript':
      steps.transcriptMs = elapsed();
      steps.transcript = frame.text;
      if (!expectText.test(frame.text || ''))
        return finish(false, `transcript did not match ${expectText}: "${frame.text}"`);
      break;
    case 'tool_call':
      if (!steps.toolCall) {
        steps.toolCallMs = elapsed();
        steps.toolCall = { name: frame.name, arguments: frame.arguments };
      }
      ws.send(
        JSON.stringify({
          type: 'tool_result',
          callId: frame.callId,
          result: { ok: true, action: frame.name, ...frame.arguments },
        }),
      );
      break;
    case 'audio_chunk':
      if (steps.firstAudioMs == null) steps.firstAudioMs = elapsed();
      steps.audioChunks++;
      break;
    case 'text':
      steps.textMs = elapsed();
      steps.text = frame.text;
      break;
    case 'audio_end': {
      steps.audioEndMs = elapsed();
      const problems = [];
      if (!steps.transcript) problems.push('no transcript');
      if (!expectTools.includes(steps.toolCall?.name))
        problems.push(`expected tool ${expectTools.join('|')}, got ${steps.toolCall?.name || 'none'}`);
      if (!steps.text) problems.push('no text reply');
      if (steps.ready?.tts === 'piper' && steps.audioChunks === 0)
        problems.push('piper active but no audio chunks');
      finish(problems.length === 0, problems.join('; ') || 'complete turn');
      break;
    }
    case 'error':
      steps.errors.push(frame.error);
      if (frame.terminal !== false) finish(false, `server error: ${frame.error}`);
      break;
    default:
      break;
  }
});
