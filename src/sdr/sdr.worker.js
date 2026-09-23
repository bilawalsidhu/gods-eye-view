import '@jtarrio/signals/demod/demodulator.js';
import { getDemod, getMode } from '@jtarrio/signals/demod/modes.js';
import {
  AdsbStreamDecoder,
  decodeAdsbMessage,
  pruneAircraftTracks,
  updateAircraftTrack,
} from './adsbDecoder.js';
import { analyzeSpectrum } from './spectrum.js';
import { recordFromDecoderTrack } from '../sources/adsbRecords.js';

let mode = 'fm';
let sampleRate = 2_048_000;
let receiverLocation = null;
let demodulator = null;
let blockCount = 0;
const aircraft = new Map();
const adsbStream = new AdsbStreamDecoder();

function configure(nextMode, nextSampleRate, location) {
  const modeChanged = mode !== (nextMode === 'adsb' ? 'adsb' : 'fm');
  mode = nextMode === 'adsb' ? 'adsb' : 'fm';
  sampleRate =
    Number(nextSampleRate) || (mode === 'adsb' ? 2_000_000 : 2_048_000);
  receiverLocation = location || receiverLocation;
  blockCount = 0;
  demodulator =
    mode === 'fm'
      ? getDemod(sampleRate, 48_000, { ...getMode('WBFM'), stereo: false })
      : null;
  if (modeChanged) {
    adsbStream.reset();
    aircraft.clear();
  }
}

function normalizedIq(buffer) {
  const bytes = new Uint8Array(buffer);
  const length = Math.floor(bytes.length / 2);
  const i = new Float32Array(length);
  const q = new Float32Array(length);
  let power = 0;
  for (let index = 0; index < length; index += 1) {
    i[index] = (bytes[index * 2] - 127.5) / 128;
    q[index] = (bytes[index * 2 + 1] - 127.5) / 128;
    power += i[index] * i[index] + q[index] * q[index];
  }
  return {
    i,
    q,
    iqLevelDbfs: 10 * Math.log10(Math.max(power / Math.max(length, 1), 1e-12)),
  };
}

function sampledIqLevel(buffer) {
  const bytes = new Uint8Array(buffer);
  let power = 0;
  let count = 0;
  for (let index = 0; index + 1 < bytes.length; index += 32) {
    const i = (bytes[index] - 127.5) / 128;
    const q = (bytes[index + 1] - 127.5) / 128;
    power += i * i + q * q;
    count += 1;
  }
  return 10 * Math.log10(Math.max(power / Math.max(count, 1), 1e-12));
}

function audioLevel(samples) {
  let power = 0;
  for (const sample of samples) power += sample * sample;
  return (
    20 *
    Math.log10(Math.max(Math.sqrt(power / Math.max(samples.length, 1)), 1e-12))
  );
}

function publicAircraft() {
  const records = [];
  for (const track of aircraft.values()) {
    const record = recordFromDecoderTrack(track);
    if (record) records.push(record);
  }
  return records;
}

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === 'configure') {
    configure(message.mode, message.sampleRate, message.location);
    return;
  }
  if (message.type === 'location') {
    receiverLocation = message.location || null;
    return;
  }
  if (message.type === 'reset') {
    blockCount = 0;
    adsbStream.reset();
    if (message.clearAircraft) aircraft.clear();
    if (mode === 'fm') configure(mode, sampleRate, receiverLocation);
    return;
  }
  if (message.type !== 'samples' || !(message.buffer instanceof ArrayBuffer))
    return;

  blockCount += 1;
  if (mode === 'fm') {
    const bins = blockCount % 3 === 0 ? analyzeSpectrum(message.buffer) : null;
    const { i, q, iqLevelDbfs } = normalizedIq(message.buffer);
    const decoded = demodulator.demodulate(i, q, 0);
    // The demodulator owns pooled output arrays. Transfer a copy so detaching
    // the message buffer cannot invalidate the pool used by the next block.
    const samples = new Float32Array(decoded.left);
    self.postMessage(
      {
        type: 'fm',
        samples,
        bins,
        snr:
          Number.isFinite(decoded.snr) && decoded.snr > 0
            ? 10 * Math.log10(decoded.snr)
            : null,
        diagnostics:
          blockCount % 15 === 0
            ? {
                workerBlocks: blockCount,
                iqLevelDbfs,
                audioLevelDbfs: audioLevel(samples),
              }
            : null,
      },
      [samples.buffer, ...(bins ? [bins.buffer] : [])],
    );
    return;
  }

  const now = Date.now();
  let decodedCount = 0;
  for (const bytes of adsbStream.extract(message.buffer, sampleRate)) {
    const decoded = decodeAdsbMessage(bytes, { receivedAt: now });
    if (!decoded) continue;
    updateAircraftTrack(aircraft, decoded, receiverLocation);
    decodedCount += 1;
  }
  const removed = pruneAircraftTracks(aircraft, now);
  if (decodedCount || removed || blockCount % 30 === 0) {
    self.postMessage({
      type: 'adsb',
      aircraft: publicAircraft(),
      decodedCount,
      diagnostics:
        blockCount % 30 === 0
          ? {
              workerBlocks: blockCount,
              iqLevelDbfs: sampledIqLevel(message.buffer),
            }
          : null,
    });
  }
};

configure(mode, sampleRate, receiverLocation);
