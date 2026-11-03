import { HUD_LAYOUTS } from '../hudLayoutPolicy.js';
import { msg, t } from '../i18n/index.js';

const CAPTION_STATES = {
  loading: msg('LOADING'),
  degraded: msg('DEGRADED'),
  stale: msg('STALE'),
  partial: msg('PARTIAL'),
  fallback: msg('FALLBACK'),
  unavailable: msg('UNAVAILABLE'),
};

// #1488's catalog caption has a canonical English tag. Translate only that
// exact prefix at the shared voice/COMMAND boundary, never model prose.
export function localizeHudCaption(result) {
  const state = result?.data?.feedState;
  const caption = result?.data?.caption;
  if (!CAPTION_STATES[state] || typeof caption !== 'string') return result;
  const prefix = `${state.toUpperCase()} | `;
  if (!caption.startsWith(prefix)) return result;
  const localized = `${t(CAPTION_STATES[state])} | ${caption.slice(prefix.length)}`;
  return {
    ...result,
    summary: localized,
    data: { ...result.data, caption: localized },
  };
}

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
