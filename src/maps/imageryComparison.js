/** Basemap that before/after imagery comparisons are read against. */
export const IMAGERY_COMPARISON_STACK_ID = 'esri-imagery';

const SWITCH_POLICIES = new Set(['preserve', 'esri', 'esri-if-photoreal']);
const leases = new WeakMap();

function comparisonTargetId(activeId, switchPolicy) {
  if (!SWITCH_POLICIES.has(switchPolicy))
    throw new Error(
      `Unknown imagery comparison switch policy: ${switchPolicy}`,
    );
  if (switchPolicy === 'esri' && activeId !== IMAGERY_COMPARISON_STACK_ID)
    return IMAGERY_COMPARISON_STACK_ID;
  if (switchPolicy === 'esri-if-photoreal' && activeId === 'photoreal')
    return IMAGERY_COMPARISON_STACK_ID;
  return null;
}

/**
 * Lease the map for an imagery comparison.
 *
 * Works on any controller exposing getActiveId(), getSwitchGeneration() and
 * setStack(id); MapSourceController#acquireImageryComparison delegates here.
 * One lease per controller: acquiring while another owner holds it throws
 * synchronously. The previous stack id and the switch generation are recorded
 * the moment the switch is issued (not after awaiting it), so release() can
 * tell its own switch from a later operator choice. `ready` resolves to
 * `{ status: 'ready' | 'superseded' | 'failed', activeId }`; a resolved
 * setStack() does not mean success because the controller falls back
 * internally. release() is idempotent and restores the previous stack only
 * while the lease's own generation still owns the active stack; releasing
 * during acquisition re-issues the previous stack so the late activation
 * cannot survive. The lease stays owned until that restoration settles (a
 * rival acquiring meanwhile still throws), so nobody can read the comparison
 * stack as their own while it is on its way out; a release with nothing to
 * restore frees the lease synchronously.
 */
export function acquireImageryComparison(
  controller,
  { owner = 'imagery-comparison', switchPolicy = 'preserve' } = {},
) {
  if (!controller)
    throw new Error('Imagery comparison needs a map stack controller');
  const held = leases.get(controller);
  if (held)
    throw new Error(
      held.releasing
        ? `Imagery comparison is still held by ${held.owner} until its release settles`
        : `Imagery comparison is already held by ${held.owner}`,
    );
  const previousId = controller.getActiveId?.() ?? null;
  const targetId = comparisonTargetId(previousId, switchPolicy);
  const lease = {
    owner,
    generation: null,
    acquiring: false,
    releasing: null,
  };
  leases.set(controller, lease);
  const activeId = () => controller.getActiveId?.() ?? null;
  const generation = () => controller.getSwitchGeneration?.() ?? null;

  let ready;
  if (targetId) {
    lease.acquiring = true;
    let switching;
    try {
      switching = Promise.resolve(controller.setStack(targetId));
    } catch (error) {
      switching = Promise.reject(error);
    }
    lease.generation = generation();
    const settle = () => {
      lease.acquiring = false;
    };
    ready = switching.then(
      () => {
        settle();
        const active = activeId();
        const status =
          generation() !== lease.generation
            ? 'superseded'
            : active === targetId
              ? 'ready'
              : 'failed';
        return { status, activeId: active };
      },
      (error) => {
        settle();
        throw error;
      },
    );
  } else {
    ready = Promise.resolve({ status: 'ready', activeId: previousId });
  }

  const disown = () => {
    if (leases.get(controller) === lease) leases.delete(controller);
  };
  const release = () => {
    if (lease.releasing) return lease.releasing;
    const restore =
      Boolean(targetId) &&
      previousId != null &&
      previousId !== targetId &&
      generation() === lease.generation &&
      (lease.acquiring || activeId() === targetId);
    if (!restore) {
      disown();
      lease.releasing = Promise.resolve();
      return lease.releasing;
    }
    lease.releasing = (async () => {
      try {
        await controller.setStack(previousId);
      } finally {
        disown();
      }
    })();
    return lease.releasing;
  };

  return { ready, release };
}
