/**
 * Local voice row — the panel shell.
 *
 * A thin DOM wrapper over /api/setup/local-voice, in the same shape as the key
 * rows beside it: read status, show what is missing, offer one button. Every
 * word it prints comes from localVoiceSetupCore, so the server and this row can
 * never describe the same install differently.
 */
import {
  localVoiceActionLabel,
  localVoiceProgressLine,
  localVoiceRowLabel,
} from './localVoiceSetupCore.mjs';

/** Matches the mic panel's backend polling; an install is minutes, not seconds. */
const POLL_MS = 2000;

export async function initLocalVoiceRow({
  documentRef = globalThis.document,
  fetchImpl,
  signal,
} = {}) {
  const root = documentRef?.querySelector?.('[data-local-voice]');
  if (!root || root.dataset.initialized === 'true') return null;
  const doFetch = fetchImpl || globalThis.fetch?.bind(globalThis);
  if (!doFetch) return null;
  root.dataset.initialized = 'true';

  const stateLabel = root.querySelector('[data-local-voice-state]');
  const button = root.querySelector('[data-local-voice-install]');
  const command = root.querySelector('[data-local-voice-command]');
  const progress = root.querySelector('[data-local-voice-progress]');
  let timer = null;
  let disposed = false;

  const stopPolling = () => {
    if (timer) globalThis.clearTimeout?.(timer);
    timer = null;
  };

  const paint = (status) => {
    if (disposed) return;
    root.hidden = false;
    root.dataset.state = status.state || 'idle';
    root.dataset.ready = String(Boolean(status.ready));
    if (stateLabel) stateLabel.textContent = localVoiceRowLabel(status);
    const action = localVoiceActionLabel(status);
    // LocalAI itself is a package install, so that step is shown as a command
    // to run rather than a button that drives someone's package manager.
    if (command) {
      command.hidden = status.binary !== false;
      command.textContent = 'brew install localai';
    }
    if (button) {
      button.hidden = !action || status.binary === false;
      button.disabled = status.state === 'running';
      if (action) button.textContent = action;
    }
    if (progress) progress.textContent = localVoiceProgressLine(status);
  };

  const load = async (method = 'GET') => {
    if (disposed) return null;
    try {
      const response = await doFetch('/api/setup/local-voice', {
        method,
        cache: 'no-store',
        signal,
        ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
      });
      if (!response.ok) throw new Error(String(response.status));
      const status = await response.json();
      if (disposed) return null;
      paint(status);
      stopPolling();
      if (status.state === 'running') {
        timer = globalThis.setTimeout?.(() => { void load(); }, POLL_MS);
        // A pending poll must never hold a process open (Node, in tests);
        // setTimeout returns a number in browsers, so this is a no-op there.
        timer?.unref?.();
      }
      return status;
    } catch {
      // Prod build or a refused admission: the surface cannot work, so it goes.
      if (!disposed) root.hidden = true;
      dispose();
      return null;
    }
  };

  const onInstall = () => {
    if (!button || button.disabled) return;
    button.disabled = true;
    void load('POST');
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopPolling();
    button?.removeEventListener?.('click', onInstall);
    signal?.removeEventListener?.('abort', dispose);
  };
  if (signal?.aborted) {
    dispose();
    return null;
  }
  signal?.addEventListener?.('abort', dispose, { once: true });
  button?.addEventListener?.('click', onInstall);

  await load();
  return disposed ? null : { dispose };
}
