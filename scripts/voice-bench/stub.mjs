/**
 * Stub tool results fed back to the model after each call. Pure.
 *
 * core suite: the neutral `{ ok:true }` stub qa-voice-routing has always
 *   used, so continuations behave exactly as in that harness.
 * coverage suite: the same stub, except a call whose arguments violate the
 *   tool schema gets `{ ok:false, error }` — what the app's runner returns
 *   for an unknown layer id — so the model's follow-up words can be judged
 *   for honesty.
 */
import { validateCall } from './grade.mjs';

export const STUB_OK = Object.freeze({ ok: true, note: 'qa-harness stub result' });

export function stubResult(suite, c, tools) {
  if (suite === 'coverage') {
    const errors = validateCall(tools, c);
    if (errors.length) return { ok: false, error: `Invalid arguments: ${errors.join('; ')}` };
  }
  return { ...STUB_OK };
}
