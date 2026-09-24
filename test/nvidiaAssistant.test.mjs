import test from 'node:test';
import assert from 'node:assert/strict';
import {
  searchDuckDuckGo,
  fetchWikipediaSummary,
  fetchOpenMeteoWeather,
  handleNvidiaResearch,
  handleNvidiaAssistant,
} from '../server/providers/nvidia-assistant.js';

test('searchDuckDuckGo handles empty and missing results gracefully', async () => {
  const res = await searchDuckDuckGo('___unlikely_query_xyz_12345___');
  assert.ok(res !== undefined);
});

test('fetchWikipediaSummary handles unknown query without crashing', async () => {
  const res = await fetchWikipediaSummary('__non_existent_wiki_topic_123456__');
  assert.ok(res === null || typeof res === 'object');
});

test('fetchOpenMeteoWeather returns weather or null for coordinates', async () => {
  const res = await fetchOpenMeteoWeather(37.7749, -122.4194);
  assert.ok(res === null || typeof res.temperature === 'number');
});

test('handleNvidiaResearch rejects GET requests with 405', async () => {
  let statusCode = 0;
  let responseData = '';
  const req = { method: 'GET' };
  const res = {
    setHeader: () => {},
    get statusCode() {
      return statusCode;
    },
    set statusCode(code) {
      statusCode = code;
    },
    end: (data) => {
      responseData = data;
    },
  };

  await handleNvidiaResearch(req, res);
  assert.equal(statusCode, 405);
  assert.ok(responseData.includes('Method not allowed'));
});

test('handleNvidiaAssistant rejects GET requests with 405', async () => {
  let statusCode = 0;
  let responseData = '';
  const req = { method: 'GET' };
  const res = {
    setHeader: () => {},
    get statusCode() {
      return statusCode;
    },
    set statusCode(code) {
      statusCode = code;
    },
    end: (data) => {
      responseData = data;
    },
  };

  await handleNvidiaAssistant(req, res);
  assert.equal(statusCode, 405);
  assert.ok(responseData.includes('Method not allowed'));
});

test('routeModelForPrompt accurately routes tasks to specialized models', async () => {
  const { routeModelForPrompt } =
    await import('../server/providers/nvidia-assistant.js');

  // Code domain -> GPT-OSS 20B
  const codeTask = routeModelForPrompt({
    prompt:
      'Write a Python function to compute Fibonacci sequence with unit tests',
  });
  assert.equal(codeTask.model, 'openai/gpt-oss-20b');
  assert.equal(codeTask.category, 'code');

  const debugTask = routeModelForPrompt({
    prompt: 'Fix this syntax error traceback in javascript async function',
  });
  assert.equal(debugTask.model, 'openai/gpt-oss-20b');

  // Deep Reasoning & Logic -> GPT-OSS 20B
  const logicTask = routeModelForPrompt({
    prompt:
      'Prove by induction that the sum of first n odd numbers is n squared',
  });
  assert.equal(logicTask.model, 'openai/gpt-oss-20b');
  assert.equal(logicTask.category, 'reasoning');

  const puzzleTask = routeModelForPrompt({
    prompt:
      'Solve the riddle step by step with first principles chain of thought',
  });
  assert.equal(puzzleTask.model, 'openai/gpt-oss-20b');

  // Multilingual -> Mistral-Nemotron
  const hindiTask = routeModelForPrompt({
    prompt: 'नमस्ते, मुझे एक पत्र लिखना है',
  });
  assert.equal(hindiTask.model, 'mistralai/mistral-nemotron');
  assert.equal(hindiTask.category, 'multilingual');

  const translationTask = routeModelForPrompt({
    prompt: 'Translate this paragraph into French, Spanish, and Japanese',
  });
  assert.equal(translationTask.model, 'mistralai/mistral-nemotron');

  // Globe / Geospatial -> Nemotron 3.5
  const globeTask = routeModelForPrompt({
    prompt:
      'Track military flights near London and pan to coordinates 51.5074, -0.1278',
  });
  assert.equal(globeTask.model, 'nvidia/nemotron-3.5-lightning-30b-a3b');
  assert.equal(globeTask.category, 'tactical');

  // Image Gen -> SD3 GenAI
  const imageGenTask = routeModelForPrompt({
    prompt: 'Generate an image of a futuristic orbital surveillance outpost',
  });
  assert.equal(imageGenTask.model, 'stabilityai/stable-diffusion-3-medium');
  assert.equal(imageGenTask.category, 'genai');

  // Ultra Reasoning -> Nemotron 550B
  const ultraTask = routeModelForPrompt({
    prompt: 'Use nemotron 550b deep reasoning to evaluate Fermi paradox',
  });
  assert.equal(ultraTask.model, 'nvidia/nemotron-3-ultra-550b-a55b');
  assert.equal(ultraTask.category, 'reasoning');

  // General massive knowledge -> Nemotron 3.5
  const generalTask = routeModelForPrompt({
    prompt: 'Tell me about the history and philosophy of the Enlightenment era',
  });
  assert.equal(generalTask.model, 'nvidia/nemotron-3.5-lightning-30b-a3b');
  assert.equal(generalTask.category, 'general');
});
