import { HUD_LAYOUTS } from '../hudLayoutPolicy.js';

// Only observed control state may become a confirmation. Never echo a request
// or tool-supplied prose, especially when an old layout was normalized.
export function hudOutcome(result, args = {}) {
  const state = result?.hud || result;
  const known =
    HUD_LAYOUTS.includes(state?.layout) && typeof state?.visible === 'boolean';
  const observed = known
    ? `HUD ${state.layout} layout; ${state.visible ? 'visible' : 'hidden'}.`
    : 'HUD state could not be confirmed.';
  if (result?.ok !== true || result.cancelled)
    return { ok: false, content: `HUD request failed. ${observed}` };
  if (!known) return { ok: false, content: observed };
  const layoutChanged =
    args.layout != null && String(args.layout).toLowerCase() !== state.layout;
  const visibilityChanged =
    (args.visible === 'on' && !state.visible) ||
    (args.visible === 'off' && state.visible);
  if (layoutChanged || visibilityChanged)
    return {
      ok: false,
      content: `Requested HUD ${layoutChanged ? 'layout' : 'visibility'} was not applied. ${observed}`,
    };
  return { ok: true, content: observed };
}
