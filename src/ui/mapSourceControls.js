import { mapStackChipModels } from '../mapStackChips.js';
import { onLocaleChange, t } from '../i18n/index.js';

/**
 * Own Map Source presentation and selection without constructing map providers.
 * The supplied controller remains authoritative for availability and active state.
 * The chip row and the status badge are presented as a plain view and handed to
 * `publish`; Core's dock renders them and calls `select()` for a chip.
 */
export function createMapSourceControls({
  controller,
  subscribe,
  publish = () => {},
  claimSelection = () => {},
  onStateChanged = () => {},
  onError = () => {},
}) {
  let destroyed = false;
  let generation = 0;
  // Availability tracks the ion token, so the stacks are read on refresh only.
  let stacks = [];
  function present(state) {
    const stack = state.activeStack;
    return {
      chips: mapStackChipModels(stacks, state.activeId).map((model) => ({
        ...model,
        ariaLabel: model.available
          ? null
          : t('{label} unavailable: {hint}', {
              label: model.label,
              hint: model.unavailableHint,
            }),
      })),
      status: {
        text:
          state.status === 'switching'
            ? '...'
            : stack?.shortLabel || stack?.label || t('MAP'),
        warn: !!state.lastError,
      },
    };
  }
  function render(state) {
    if (destroyed || !state) return;
    publish(present(state));
  }
  async function select(stackId, { syncShare = true } = {}) {
    if (destroyed) return null;
    const current = ++generation;
    if (syncShare) claimSelection();
    const before = controller.getActiveId();
    render(controller.getState('switching'));
    let state;
    try {
      state = await controller.setStack(stackId);
    } catch (error) {
      if (!destroyed && current === generation) {
        render(controller.getState());
        onError(error?.message || String(error));
      }
      throw error;
    }
    if (destroyed || current !== generation) return state;
    render(controller.getState());
    if (state?.activeId === before && stackId !== before && state?.lastError)
      onError(state.lastError);
    if (syncShare) onStateChanged();
    return state;
  }
  function refresh() {
    if (destroyed) return;
    stacks = controller.getStacks();
    render(controller.getState());
  }
  const unsubscribe = subscribe(() => {
    if (destroyed) return;
    render(controller.getState());
    onStateChanged();
  });
  // The chips' names and hints are translated; read them again in a new
  // locale.
  const offLocale = onLocaleChange(refresh);
  refresh();
  return {
    render,
    select,
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      unsubscribe?.();
      offLocale();
    },
  };
}
