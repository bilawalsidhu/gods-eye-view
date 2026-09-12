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

export async function initLocalVoiceRow({ documentRef = globalThis.document, fetchImpl } = {}) {
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

  const stopPolling = () => {
    if (timer) globalThis.clearTimeout?.(timer);
    timer = null;
  };

  const paint = (status) => {
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
    try {
      const response = await doFetch('/api/setup/local-voice', {
        method,
        cache: 'no-store',
        ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
      });
      if (!response.ok) throw new Error(String(response.status));
      const status = await response.json();
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
      stopPolling();
      root.hidden = true;
      return null;
    }
  };

  button?.addEventListener?.('click', () => {
    if (button.disabled) return;
    button.disabled = true;
    void load('POST');
  });

  return { status: await load(), refresh: () => load(), dispose: stopPolling };
}
