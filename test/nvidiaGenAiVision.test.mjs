import test from 'node:test';
import assert from 'node:assert/strict';
import { handleNvidiaGenAiImage } from '../server/providers/nvidia-genai.js';
import { handleNvidiaVisionAnalyze } from '../server/providers/nvidia-vision.js';
import { handleNvidiaModels } from '../server/providers/nvidia.js';

test('handleNvidiaGenAiImage rejects GET requests with 405', async () => {
  let statusCode = 0;
  let responseData = '';
  const req = { method: 'GET' };
  const res = {
    setHeader: () => {},
    set statusCode(code) {
      statusCode = code;
    },
    end: (data) => {
      responseData = data;
    },
  };

  await handleNvidiaGenAiImage(req, res);
  assert.equal(statusCode, 405);
  assert.ok(responseData.includes('Method not allowed'));
});

test('handleNvidiaVisionAnalyze rejects GET requests with 405', async () => {
  let statusCode = 0;
  let responseData = '';
  const req = { method: 'GET' };
  const res = {
    setHeader: () => {},
    set statusCode(code) {
      statusCode = code;
    },
    end: (data) => {
      responseData = data;
    },
  };

  await handleNvidiaVisionAnalyze(req, res);
  assert.equal(statusCode, 405);
  assert.ok(responseData.includes('Method not allowed'));
});

test('handleNvidiaModels returns list of models and categories', () => {
  let statusCode = 0;
  let responseData = '';
  const req = { method: 'GET' };
  const res = {
    setHeader: () => {},
    set statusCode(code) {
      statusCode = code;
    },
    end: (data) => {
      responseData = data;
    },
  };

  handleNvidiaModels(req, res);
  assert.equal(statusCode, 200);
  const parsed = JSON.parse(responseData);
  assert.equal(parsed.ok, true);
  assert.ok(Array.isArray(parsed.models));
  assert.ok(parsed.models.some((m) => m.id === 'auto'));
  assert.ok(parsed.models.some((m) => m.id === 'ensemble'));
});
