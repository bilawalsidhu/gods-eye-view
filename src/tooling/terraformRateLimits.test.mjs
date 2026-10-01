import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// T4 (breaker MAJOR on T3): the deployed app needs the HUD summary on its own
// per-IP bucket so the voice token keeps its 3/min. Pin the Terraform wiring.

const read = (name) =>
  readFileSync(new URL(`../../infra/terraform/${name}`, import.meta.url), 'utf8');

const variableDefault = (source, name) => {
  const block = source.match(
    new RegExp(`variable "${name}" \\{([\\s\\S]*?)\\n\\}`),
  );
  assert.ok(block, `variable ${name} is declared`);
  return Number(block[1].match(/default\s*=\s*(\d+)/)?.[1]);
};

test('T4: Terraform gives the HUD summary its own rate limit (default 6)', () => {
  const variables = read('variables.tf');
  assert.equal(variableDefault(variables, 'ratelimit_openai_per_min'), 3);
  assert.equal(variableDefault(variables, 'ratelimit_hud_per_min'), 6);
  const main = read('main.tf');
  assert.match(
    main,
    /GEV_RATELIMIT_HUD_PER_MIN\s*=\s*tostring\(var\.ratelimit_hud_per_min\)/,
  );
  assert.match(
    main,
    /GEV_RATELIMIT_OPENAI_PER_MIN\s*=\s*tostring\(var\.ratelimit_openai_per_min\)/,
  );
});
