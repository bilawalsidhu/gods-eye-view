/**
 * The run a host opened, and what it is compared with (GEN-299).
 *
 * `openRun` points panel rows at a run, but a run's mission effects have no
 * row (nothing to draw on the globe), and a published receipt names things a
 * row does not hold: the exact revision, whether the head has moved past it,
 * and the other case of the same pair. The run player reads them here.
 *
 * One focus at a time; opening another run replaces it. Plain data plus the
 * source to read the run from, so the player can show a run that put no row
 * on screen.
 */
let focus = null;

/**
 * @param {{head: string, revisionId?: string|null, headAdvanced?: boolean, source: object,
 *   compare?: {head: string, revisionId?: string|null, label?: string}|null, label?: string}} run
 */
export function focusRun(run) {
  focus = Object.freeze({
    head: run.head,
    revisionId: run.revisionId ?? null,
    headAdvanced: !!run.headAdvanced,
    label: run.label ?? 'contested',
    source: run.source,
    compare: run.compare
      ? Object.freeze({
          head: run.compare.head,
          revisionId: run.compare.revisionId ?? null,
          label: run.compare.label ?? 'nominal',
        })
      : null,
  });
  return focus;
}

/** The focused run, or null. */
export function runFocus() {
  return focus;
}

export function clearRunFocus() {
  focus = null;
}
