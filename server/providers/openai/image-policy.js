import fs from 'node:fs';
import path from 'node:path';
import {
  createOpenAiReconstructionProvider,
  CAMERA_RECONSTRUCTION_MODEL,
} from './camera-reconstruction.js';
import { createReconstructionBudget } from './reconstruction-budget.js';

/** Optional owner-approved numeric policy; key presence alone never enables spending. */
export function configuredImageProvider(
  policyPath = process.env.GEV_IMAGE_GENERATION_POLICY,
) {
  if (!policyPath) return createOpenAiReconstructionProvider();
  try {
    if (fs.statSync(policyPath).size > 4096) throw Error('Policy too large');
    const p = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    if (
      p.approved !== true ||
      p.model !== CAMERA_RECONSTRUCTION_MODEL ||
      p.quality !== 'low' ||
      typeof p.ledger !== 'string' ||
      !p.ledger ||
      path.isAbsolute(p.ledger) ||
      p.ledger.includes('..') ||
      /[\\/]/.test(p.ledger) ||
      ![p.limitMicros, p.priorSpendMicros, p.allocationMicros].every(
        Number.isSafeInteger,
      )
    )
      throw Error('Policy invalid');
    return createOpenAiReconstructionProvider({
      approved: true,
      quality: 'low',
      budget: createReconstructionBudget({
        ledgerPath: path.resolve(path.dirname(policyPath), p.ledger),
        limitMicros: p.limitMicros,
        priorSpendMicros: p.priorSpendMicros,
        allocationMicros: p.allocationMicros,
      }),
    });
  } catch {
    return createOpenAiReconstructionProvider({
      priceLabel:
        'Owner policy unavailable or invalid. Paid reconstruction remains disabled.',
    });
  }
}
