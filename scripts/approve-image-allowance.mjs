import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReconstructionBudget } from '../server/providers/openai/reconstruction-budget.js';
import { CAMERA_RECONSTRUCTION_MODEL } from '../server/providers/openai/camera-reconstruction.js';
const args = process.argv.slice(2),
  value = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
if (!args.includes('--approve-cost') || !args.includes('--limit-usd'))
  throw Error(
    'Explicit --approve-cost and --limit-usd are required. This is an app-side allocation estimate, not a provider invoice cap.',
  );
const micros = (text) => {
  if (!/^\d+(?:\.\d{1,6})?$/.test(text || ''))
    throw Error(
      'Use a nonnegative dollar value with up to six decimal places.',
    );
  return Math.round(Number(text) * 1e6);
};
const root = fileURLToPath(new URL('../', import.meta.url)),
  policyPath = path.resolve(
    value('--policy') ||
      path.join(root, '.gev-private', 'image-generation-policy.json'),
  );
const p = {
  approved: true,
  model: CAMERA_RECONSTRUCTION_MODEL,
  quality: 'low',
  limitMicros: micros(value('--limit-usd')),
  priorSpendMicros: micros(
    args.includes('--prior-spend-usd') ? value('--prior-spend-usd') : '0',
  ),
  allocationMicros: 100000,
  ledger: 'image-allowance.json',
};
if (fs.existsSync(policyPath))
  throw Error(
    'Existing policy preserved. Do not overwrite or reset an allowance; inspect/reconcile it first.',
  );
const budget = createReconstructionBudget({
  ledgerPath: path.join(path.dirname(policyPath), p.ledger),
  limitMicros: p.limitMicros,
  priorSpendMicros: p.priorSpendMicros,
  allocationMicros: p.allocationMicros,
  initialize: true,
});
fs.writeFileSync(policyPath, JSON.stringify(p, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(budget.status(), null, 2));
console.log(
  'Set GEV_IMAGE_GENERATION_POLICY to this policy file, then restart. Existing server OpenAI key is required; no key is created. Unknown charges block further sends.',
);
