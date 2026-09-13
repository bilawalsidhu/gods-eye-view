export { shouldHideCollapsedRightPanels } from './ui/panelRailGeometry.js';

const GLOBAL_CONTEXT_EXPLICIT_ACTIONS = new Set([
  'contacts',
  'space-missions',
  'cockpit',
]);

/**
 * Decide whether a completed action should reveal the Global Context panel.
 * Expansion belongs only to an explicit, successful owner action. Restoring a
 * session or replaying saved state must preserve the saved collapsed state,
 * and a failed transition must leave the prior panel state untouched.
 *
 * Whether an aircraft is already selected is deliberately irrelevant: an
 * explicit Cockpit action still reveals the context that supports that track.
 *
 * @param {object} input Action outcome and coordination state.
 * @param {'contacts'|'space-missions'|'cockpit'|string} input.action Completed action.
 * @param {boolean} input.explicitUserAction Whether the user directly requested it.
 * @param {boolean} input.succeeded Whether the requested transition completed.
 * @param {boolean} [input.restoring=false] Whether saved/session state is being restored.
 * @returns {boolean} Whether Global Context should be expanded.
 */
export function shouldExpandGlobalContextPanel({
  action,
  explicitUserAction,
  succeeded,
  restoring = false,
}) {
  return Boolean(
    GLOBAL_CONTEXT_EXPLICIT_ACTIONS.has(action)
    && explicitUserAction
    && succeeded
    && !restoring
  );
}
