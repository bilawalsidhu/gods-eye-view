/**
 * Local voice setup — the pure core.
 *
 * The dev server's /api/setup/local-voice endpoints and the in-app row are thin
 * shells over this module, the same way keySetupCore backs the key panel: the
 * step order, what each step is called, and how progress reads all live here.
 *
 * Nothing below touches the filesystem, the network, or a process — the plan is
 * derived from a profile the caller already read, which is what makes every
 * behavior here unit-testable.
 */

/** Bytes-to-text for a download in flight. Whole megabytes read fine at a glance. */
function megabytes(bytes) {
  return `${Math.round(Number(bytes || 0) / 1e6)} MB`;
}

/**
 * The ordered install plan for a profile.
 *
 * Cached weights stay in the list rather than disappearing: a user re-running
 * the install should see that the 1.3 GB download is already done, not wonder
 * where it went.
 */
export function localVoiceInstallPlan(profile, { cachedRepos = [] } = {}) {
  const steps = [];
  for (const backend of profile?.backends || []) {
    steps.push({ id: `backend:${backend}`, kind: 'backend', arg: backend, label: `Install ${backend} backend` });
  }
  for (const model of profile?.gallery || []) {
    steps.push({ id: `model:${model}`, kind: 'model', arg: model, label: `Install ${model}` });
  }
  steps.push({ id: 'configs', kind: 'configs', label: 'Copy pipeline configs' });
  for (const { name, repoId } of profile?.weights || []) {
    const cached = cachedRepos.includes(repoId);
    steps.push({
      id: `weights:${name}`,
      kind: 'weights',
      arg: repoId,
      cached,
      label: cached ? `${repoId} already downloaded` : `Download ${repoId}`,
    });
  }
  if ((profile?.backends || []).includes('mlx')) {
    steps.push({ id: 'compat', kind: 'compat', label: 'Apply MLX compatibility patches' });
  }
  return steps;
}

/**
 * One line for the panel. A download reports megabytes because that is the only
 * number that moves during the long step; everything else reports position.
 */
export function localVoiceProgressLine({ state = 'idle', steps = [], bytes = 0, error = '' } = {}) {
  if (state === 'failed') return `Install failed — ${error || 'see the dev server log'}`;
  if (state === 'done') return 'Local voice is installed';
  if (state !== 'running') return '';
  const done = steps.filter((step) => step.state === 'done').length;
  const current = steps.find((step) => step.state === 'running');
  if (!current) return `Installing… (${done}/${steps.length})`;
  const suffix = current.kind === 'weights' && bytes > 0 ? ` — ${megabytes(bytes)}` : '';
  return `${current.label}${suffix} (${done + 1}/${steps.length})`;
}

/** The row's headline, in the panel's voice. */
export function localVoiceRowLabel({ supported = true, ready = false, state = 'idle' } = {}) {
  if (!supported) return 'NOT SUPPORTED ON THIS MACHINE';
  if (state === 'running') return 'INSTALLING';
  if (ready) return 'READY';
  if (state === 'failed') return 'INSTALL FAILED';
  return 'NOT INSTALLED';
}

/**
 * Whether the install button should be offered. An unsupported machine and a
 * running install both have nothing to click, and a ready install is offered
 * again only as a repair.
 */
export function localVoiceActionLabel({ supported = true, ready = false, state = 'idle' } = {}) {
  if (!supported || state === 'running') return null;
  if (ready) return 'REINSTALL';
  if (state === 'failed') return 'RETRY INSTALL';
  return 'INSTALL';
}
