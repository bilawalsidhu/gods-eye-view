import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCAL_TOOL_SCHEMAS, LOCAL_TOOL_TIMEOUTS } from './localToolSchemas.js';

test('every long-running tool timeout names a real local tool', () => {
  const names = new Set(LOCAL_TOOL_SCHEMAS.map((s) => s.name));
  for (const [name, ms] of Object.entries(LOCAL_TOOL_TIMEOUTS)) {
    assert.ok(names.has(name), `${name} is not a local tool`);
    assert.ok(Number.isFinite(ms) && ms >= 10_000 && ms <= 300_000, name);
  }
  assert.ok(LOCAL_TOOL_TIMEOUTS.camera_sweep >= 120_000);
});
