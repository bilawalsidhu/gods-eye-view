import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commands,
  parseFrame,
  parseMessageText,
  decodePcm16,
  createAdpcmDecoder,
  encodeAdpcmForTest,
  defaultModeFor,
  waterfallSpanKhz,
  waterfallCenterKhz,
  frequencyAtFraction,
  fractionOfFrequency,
  formatSmeter,
  fatalReason,
  clampFrequencyKhz,
  axisTicks,
  formatFrequency,
  formatSpan,
  tuneStepKhz,
  snapFrequencyKhz,
  zoomAround,
  panCenterKhz,
} from './protocol.js';

const tagged = (tag, body) => {
  const out = new Uint8Array(4 + body.length);
  out.set(
    [...tag].map((c) => c.charCodeAt(0)),
    0,
  );
  out[3] = 0;
  out.set(body, 4);
  return out;
};

// SND frames have no filler byte after the tag (unlike MSG and W/F).
const sndTagged = (body) => {
  const out = new Uint8Array(3 + body.length);
  out.set(
    [...'SND'].map((c) => c.charCodeAt(0)),
    0,
  );
  out.set(body, 3);
  return out;
};

test('commands are the exact SET frames', () => {
  assert.equal(commands.auth(), 'SET auth t=kiwi p=#');
  assert.equal(commands.auth('pw'), 'SET auth t=kiwi p=pw');
  assert.equal(
    commands.audioRate(12000, 44100),
    'SET AR OK in=12000 out=44100',
  );
  assert.equal(
    commands.tune({ mode: 'usb', freqKhz: 14074 }),
    'SET mod=usb low_cut=300 high_cut=2700 freq=14074.000',
  );
  assert.equal(
    commands.tune({ mode: 'bogus', freqKhz: 810 }),
    'SET mod=am low_cut=-4500 high_cut=4500 freq=810.000',
  );
  assert.equal(
    commands.waterfallView({ zoom: 99, centerKhz: 7100 }),
    'SET zoom=14 cf=7100.000',
  );
  assert.equal(commands.noCompression(), 'SET compression=0');
});

test('parses MSG frames with encoded values', () => {
  const body = new TextEncoder().encode(
    'audio_rate=12000 name=Hello%20World too_busy=4 flag',
  );
  const frame = parseFrame(tagged('MSG', body));
  assert.equal(frame.kind, 'msg');
  assert.equal(frame.fields.audio_rate, '12000');
  assert.equal(frame.fields.name, 'Hello World');
  assert.equal(frame.fields.flag, '');
  assert.deepEqual(parseMessageText('a=%E0%A4%A'), { a: '%E0%A4%A' });
});

test('parses SND frames: flags, smeter, big-endian PCM', () => {
  const pcm = new Uint8Array([0x40, 0x00, 0xc0, 0x00]); // +16384, -16384 BE
  const body = new Uint8Array(7 + pcm.length);
  body[0] = 0; // flags
  body.set([1, 0, 0, 0], 1); // seq
  body[5] = 0x03; // smeter raw 0x03E8 = 1000 -> -27 dBm
  body[6] = 0xe8;
  body.set(pcm, 7);
  const frame = parseFrame(sndTagged(body));
  assert.equal(frame.kind, 'snd');
  assert.equal(frame.compressed, false);
  assert.ok(Math.abs(frame.dbm - -27) < 1e-9);
  const samples = decodePcm16(frame.data, frame.littleEndian);
  assert.deepEqual([...samples], [0.5, -0.5]);
});

test('honours the little-endian flag', () => {
  const body = new Uint8Array(7 + 2);
  body[0] = 0x80;
  body.set([0x00, 0x40], 7); // LE 0x4000
  const frame = parseFrame(sndTagged(body));
  assert.equal(frame.littleEndian, true);
  assert.deepEqual([...decodePcm16(frame.data, true)], [0.5]);
});

test('skips the IQ GPS block on stereo frames', () => {
  const body = new Uint8Array(7 + 10 + 4);
  body[0] = 0x08;
  const frame = parseFrame(sndTagged(body));
  assert.equal(frame.stereo, true);
  assert.equal(frame.data.length, 4);
});

test('parses W/F frames', () => {
  const bins = Uint8Array.from({ length: 1024 }, (_, i) => i & 0xff);
  const body = new Uint8Array(12 + bins.length);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, 5, true);
  dv.setUint32(4, 0, true);
  dv.setUint32(8, 77, true);
  body.set(bins, 12);
  const frame = parseFrame(tagged('W/F', body));
  assert.equal(frame.kind, 'wf');
  assert.equal(frame.seq, 77);
  assert.equal(frame.bins.length, 1024);
});

test('malformed frames never throw', () => {
  assert.equal(parseFrame(new Uint8Array(2)).kind, 'unknown');
  assert.equal(parseFrame(sndTagged(new Uint8Array(3))).kind, 'unknown');
  assert.equal(parseFrame(tagged('W/F', new Uint8Array(3))).kind, 'unknown');
  assert.equal(parseFrame(tagged('XYZ', new Uint8Array(8))).kind, 'unknown');
  assert.equal(parseFrame(null).kind, 'unknown');
});

test('adpcm round trips a tone with small error', () => {
  const tone = Float32Array.from(
    { length: 512 },
    (_, i) => 0.4 * Math.sin(i / 6),
  );
  const decoded = createAdpcmDecoder().decode(encodeAdpcmForTest(tone));
  assert.equal(decoded.length, 512);
  let worst = 0;
  for (let i = 32; i < tone.length; i++)
    worst = Math.max(worst, Math.abs(decoded[i] - tone[i]));
  assert.ok(worst < 0.05, `worst error ${worst}`);
});

test('default modes follow band conventions', () => {
  assert.equal(defaultModeFor(810), 'am');
  assert.equal(defaultModeFor(7200), 'am');
  assert.equal(defaultModeFor(7074), 'lsb');
  assert.equal(defaultModeFor(14074), 'usb');
  assert.equal(defaultModeFor(10000), 'usb');
});

test('waterfall geometry', () => {
  assert.equal(waterfallSpanKhz(0), 30000);
  assert.equal(waterfallSpanKhz(3), 3750);
  assert.equal(waterfallCenterKhz(100, 3), 1875);
  assert.equal(waterfallCenterKhz(29999, 3), 28125);
  const view = { zoom: 2, centerKhz: 7000, fullKhz: 30000 };
  assert.equal(frequencyAtFraction(0.5, view), 7000);
  assert.equal(frequencyAtFraction(0, view), 7000 - 3750);
  assert.equal(fractionOfFrequency(7000, view), 0.5);
  assert.equal(fractionOfFrequency(20000, view), null);
});

test('s-meter text and fatal MSG interpretation', () => {
  assert.equal(formatSmeter(-73), 'S9');
  assert.equal(formatSmeter(-53), 'S9+20');
  assert.equal(formatSmeter(-100), 'S5');
  assert.equal(formatSmeter(NaN), '--');
  assert.match(fatalReason({ too_busy: '4' }), /slots/);
  assert.equal(fatalReason({ too_busy: '0', badp: '0', down: '0' }), null);
  assert.match(fatalReason({ badp: '1' }), /password/);
  assert.match(fatalReason({ badp: '5' }), /one connection/);
  assert.match(fatalReason({ down: '1' }), /maintenance/);
  assert.equal(clampFrequencyKhz(-5), 0);
  assert.equal(clampFrequencyKhz(1e9, 0, 30e6), 30000);
});

test('axis ticks are round and inside the span', () => {
  const ticks = axisTicks({ zoom: 0, centerKhz: 15000, fullKhz: 30000 });
  assert.ok(ticks.length >= 4 && ticks.length <= 8);
  assert.ok(ticks.every((t) => t.fraction >= 0 && t.fraction <= 1));
  assert.deepEqual(ticks[0], { fraction: 0, label: '0k' });
  const zoomed = axisTicks({ zoom: 6, centerKhz: 7100, fullKhz: 30000 });
  assert.ok(
    zoomed.every(
      (t) => parseFloat(t.label) >= 6.8 && parseFloat(t.label) <= 7.4,
    ),
    JSON.stringify(zoomed),
  );
  assert.deepEqual(
    zoomed.map((t) => t.label),
    ['6.9M', '7M', '7.1M', '7.2M', '7.3M'],
  );
});

test('frequency formatting', () => {
  assert.equal(formatFrequency(7074), '7.074 MHz');
  assert.equal(formatFrequency(810), '810.00 kHz');
  assert.equal(formatFrequency(NaN), '--');
});

test('formats the visible span for people', () => {
  assert.equal(formatSpan(30000), '30 MHz');
  assert.equal(formatSpan(1875), '1.88 MHz');
  assert.equal(formatSpan(234.4), '234.4 kHz');
  assert.equal(formatSpan(1.83), '1.83 kHz');
  assert.equal(formatSpan(NaN), '--');
});

test('click and key resolution gets finer as the view zooms in', () => {
  assert.equal(tuneStepKhz(30000), 1);
  assert.equal(tuneStepKhz(1875), 0.1);
  assert.equal(tuneStepKhz(120), 0.01);
  assert.equal(snapFrequencyKhz(7074.37, 30000), 7074);
  assert.equal(snapFrequencyKhz(7074.37, 1000), 7074.4);
  assert.equal(snapFrequencyKhz(7074.3724, 10), 7074.37);
});

test('zooming keeps the frequency under the pointer under the pointer', () => {
  const view = { zoom: 0, centerKhz: 15000, fullKhz: 30000 };
  for (const fraction of [0.1, 0.25, 0.5, 0.8]) {
    const before = frequencyAtFraction(fraction, view);
    const next = zoomAround(view, fraction, 3);
    assert.equal(next.zoom, 3);
    const after = frequencyAtFraction(fraction, { ...view, ...next });
    assert.ok(
      Math.abs(after - before) < 1e-6,
      `fraction ${fraction}: ${before} vs ${after}`,
    );
  }
  // Zooming back out returns to the whole band.
  const zoomed = { ...view, zoom: 4, centerKhz: 7100 };
  assert.deepEqual(zoomAround(zoomed, 0.5, -9), { zoom: 0, centerKhz: 15000 });
  // At the limits nothing changes.
  assert.equal(zoomAround(view, 0.5, -1), null);
  assert.equal(
    zoomAround({ ...view, zoom: 14, centerKhz: 7100 }, 0.5, 1),
    null,
  );
});

test('zooming near a band edge never runs off the band', () => {
  const view = { zoom: 0, centerKhz: 15000, fullKhz: 30000 };
  const next = zoomAround(view, 0, 5);
  const span = waterfallSpanKhz(5, 30000);
  assert.ok(next.centerKhz - span / 2 >= 0);
  const high = zoomAround(view, 1, 5);
  assert.ok(high.centerKhz + span / 2 <= 30000);
});

test('dragging the picture right moves the view left, within the band', () => {
  const view = { zoom: 4, centerKhz: 7100, fullKhz: 30000 };
  const span = waterfallSpanKhz(4, 30000);
  assert.ok(Math.abs(panCenterKhz(view, 0.25) - (7100 - 0.25 * span)) < 1e-9);
  assert.ok(Math.abs(panCenterKhz(view, -0.25) - (7100 + 0.25 * span)) < 1e-9);
  assert.equal(panCenterKhz({ ...view, centerKhz: span / 2 }, 5), span / 2);
});
