import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  runContractSteps,
  buildDryPlan,
  generateWav,
  generatePng,
  audioContainerOf,
  crc32,
} from './contract-steps.js';
import { jsonResponse, sseResponse } from './test-helpers.mjs';

describe('server/ondemand/contract-steps.js', () => {
  describe('generateWav', () => {
    test('produces a 16 kHz mono 16-bit PCM WAV with a valid RIFF/WAVE header', () => {
      const wav = generateWav();
      assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
      assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
      assert.equal(wav.subarray(12, 16).toString('ascii'), 'fmt ');
      assert.equal(wav.readUInt16LE(20), 1); // audio format: PCM
      assert.equal(wav.readUInt16LE(22), 1); // channels: mono
      assert.equal(wav.readUInt32LE(24), 16000); // sample rate
      assert.equal(wav.readUInt16LE(34), 16); // bits per sample
      assert.equal(wav.subarray(36, 40).toString('ascii'), 'data');
      assert.equal(wav.readUInt32LE(4), 36 + (wav.length - 44));
    });
  });

  describe('generatePng', () => {
    test('produces a valid PNG signature and a 32x32 IHDR chunk', () => {
      const png = generatePng();
      const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      assert.ok(png.subarray(0, 8).equals(sig));
      assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
      assert.equal(png.readUInt32BE(16), 32); // width
      assert.equal(png.readUInt32BE(20), 32); // height
      assert.equal(png[24], 8); // bit depth
      assert.equal(png[25], 2); // color type: RGB
    });

    test('crc32() matches the CRC stored in the IHDR chunk', () => {
      const png = generatePng();
      const typeAndData = png.subarray(12, 12 + 4 + 13);
      const storedCrc = png.readUInt32BE(12 + 4 + 13);
      assert.equal(crc32(typeAndData), storedCrc);
    });
  });

  describe('audioContainerOf', () => {
    test('detects mp3 via a leading ID3 tag', () => {
      const buf = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(9)]);
      assert.equal(audioContainerOf(buf), 'mp3');
    });

    test('detects mp3 via a 0xFFFB frame-sync header', () => {
      const buf = Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(10)]);
      assert.equal(audioContainerOf(buf), 'mp3');
    });

    test('detects wav via RIFF/WAVE (using a real generated WAV)', () => {
      assert.equal(audioContainerOf(generateWav()), 'wav');
    });

    test('detects ogg via a leading OggS tag', () => {
      const buf = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(8)]);
      assert.equal(audioContainerOf(buf), 'ogg');
    });

    test('returns null for bytes with no known audio signature', () => {
      const buf = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      assert.equal(audioContainerOf(buf), null);
    });
  });

  describe('buildDryPlan', () => {
    test('direct mode returns the 10 planned steps, no network', () => {
      const plan = buildDryPlan({ mode: 'direct' });
      assert.equal(plan.length, 10);
      assert.match(plan[0], /^STEP 1\/10/);
    });

    test('proxy mode returns the 10 planned steps, no network', () => {
      const plan = buildDryPlan({
        mode: 'proxy',
        proxyBase: 'https://example.invalid/api/ondemand',
      });
      assert.equal(plan.length, 10);
      assert.match(plan[0], /example\.invalid\/api\/ondemand/);
    });
  });

  describe('runContractSteps', () => {
    /** Builds a fetchImpl stub that answers every upstream call the 10-step
     * flow makes in 'direct' mode, keyed by (method, URL). The sync-query
     * endpoint always echoes back the AMBER code word parsed out of the
     * FIRST sync prompt's body, so both the step 2 (non-empty answer) and
     * step 9 (answer contains the remembered code word) checks pass. */
    function makeHappyFetchStub() {
      let rememberedCodeword = '';
      return async function fetchStub(url, init = {}) {
        const u = String(url);
        const method = init.method || 'GET';

        if (method === 'POST' && /\/chat\/v1\/sessions$/.test(u)) {
          return jsonResponse(201, { data: { id: 'sess1' } });
        }
        if (method === 'GET' && /\/chat\/v1\/sessions\/[^/]+$/.test(u)) {
          return jsonResponse(200, { data: { id: 'sess1' } });
        }
        if (
          method === 'POST' &&
          /\/chat\/v1\/sessions\/[^/]+\/query$/.test(u)
        ) {
          const body = JSON.parse(init.body);
          if (body.responseMode === 'stream') {
            return sseResponse(200, [
              'event:message\ndata:{"eventType":"fulfillment","answer":"A"}\n\nevent:message\ndata:[DONE]\n\n',
            ]);
          }
          const match = /AMBER-[0-9a-f]+/i.exec(body.query || '');
          if (match) rememberedCodeword = match[0];
          return jsonResponse(200, {
            data: {
              answer: `The code word is ${rememberedCodeword}`,
              messageId: 'm',
              status: 'completed',
            },
          });
        }
        if (method === 'GET' && u.includes('/plugin/v1/list')) {
          return jsonResponse(200, { data: { total: 0 } });
        }
        if (method === 'POST' && /\/media\/v1\/public\/file\/raw$/.test(u)) {
          return jsonResponse(200, {
            data: {
              id: 'med1',
              url: 'https://files.example/x.wav',
              actionStatus: 'completed',
              context: 'tiny image',
            },
          });
        }
        if (method === 'POST' && u.endsWith('/execute/speech_to_text')) {
          return jsonResponse(200, { data: { text: '' } });
        }
        if (method === 'POST' && u.endsWith('/execute/text_to_speech')) {
          return jsonResponse(200, {
            data: { audioUrl: 'https://files.example/a.mp3' },
          });
        }
        if (method === 'GET' && u === 'https://files.example/a.mp3') {
          const bytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(9)]);
          return new Response(bytes, {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          });
        }
        throw new Error(`unexpected fetch in test stub: ${method} ${u}`);
      };
    }

    test('direct mode: 8 passed, 0 failed, 2 honest skips (steps 4 and 8), key never leaks', async () => {
      const report = await runContractSteps({
        mode: 'direct',
        apiKey: 'SENTINEL-KEY-123',
        fetchImpl: makeHappyFetchStub(),
        log: () => {},
      });

      assert.equal(report.mode, 'direct');
      assert.equal(report.proxyBase, undefined);
      assert.equal(report.sessionId, 'sess1');
      assert.equal(report.steps.length, 10);
      assert.deepEqual(report.summary, {
        passed: 8,
        failed: 0,
        skipped: 2,
        totalMs: report.summary.totalMs,
        minMs: report.summary.minMs,
        maxMs: report.summary.maxMs,
        meanMs: report.summary.meanMs,
      });

      const byStep = Object.fromEntries(report.steps.map((s) => [s.step, s]));
      assert.equal(byStep[4].skipped, true);
      assert.equal(byStep[8].skipped, true);
      for (const n of [1, 2, 3, 5, 6, 7, 9, 10]) {
        assert.equal(byStep[n].ok, true, `step ${n} expected to PASS`);
      }

      for (const step of report.steps) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(step, 'httpStatus'),
          `step ${step.step} is missing the httpStatus field`,
        );
      }

      assert.ok(
        !JSON.stringify(report).includes('SENTINEL-KEY-123'),
        'the api key must never appear in the report',
      );
    });

    test('direct mode: a failing session-create step skips every dependent step', async () => {
      const fetchStub = async () =>
        new Response('service unavailable', { status: 503 });

      const report = await runContractSteps({
        mode: 'direct',
        apiKey: 'SENTINEL-KEY-123',
        fetchImpl: fetchStub,
        log: () => {},
      });

      assert.equal(report.summary.failed, 1);
      const byStep = Object.fromEntries(report.steps.map((s) => [s.step, s]));
      assert.equal(byStep[1].ok, false);
      assert.equal(byStep[1].skipped, false);
      assert.equal(byStep[1].httpStatus, 503);
      for (const n of [2, 3, 4, 5, 6, 7, 8, 9]) {
        assert.equal(byStep[n].skipped, true, `step ${n} expected SKIP`);
        assert.equal(byStep[n].skipReason, 'dependency: step 1 failed');
      }
      assert.ok(!JSON.stringify(report).includes('SENTINEL-KEY-123'));
    });
  });
});
