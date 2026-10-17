import assert from 'node:assert/strict';
import test from 'node:test';
import { coreTools, toFunctionOutput, toFunctionTools } from './index.js';

test('catalog tools become independent function records', () => {
  const records = toFunctionTools(coreTools, {
    exclude: ['show_in_gods_eye_view'],
  });
  assert.equal(records.length, coreTools.length - 1);
  assert.ok(!records.some((tool) => tool.name === 'show_in_gods_eye_view'));
  const weather = records.find((tool) => tool.name === 'get_weather');
  const source = coreTools.find((tool) => tool.name === 'get_weather');
  assert.deepEqual(Object.keys(weather), [
    'type',
    'name',
    'description',
    'parameters',
  ]);
  assert.equal(weather.type, 'function');
  assert.equal(weather.description, source.description);
  assert.deepEqual(weather.parameters, source.inputSchema);
  assert.notEqual(weather.parameters, source.inputSchema);
  weather.parameters.properties.location.description = 'changed';
  assert.notEqual(
    source.inputSchema.properties.location.description,
    'changed',
  );
  assert.ok(records.every((tool) => tool.parameters.type === 'object'));
});

test('results become function outputs without image data', () => {
  assert.deepEqual(
    toFunctionOutput('get_wind', { summary: 'Calm.', data: { calm: true } }),
    { ok: true, tool: 'get_wind', summary: 'Calm.', data: { calm: true } },
  );
  assert.deepEqual(
    toFunctionOutput('get_weather_map', {
      summary: 'Radar.',
      data: {},
      images: [{ mimeType: 'image/png', data: 'AAAA' }],
    }),
    {
      ok: true,
      tool: 'get_weather_map',
      summary: 'Radar.',
      data: {},
      images_omitted: 1,
    },
  );
});
