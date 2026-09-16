import {
  readStoredVoiceProvider,
  writeStoredVoiceProvider,
} from './realtimePreferences.js';

const LOCAL_BACKEND_URL = '/api/realtime/local-backend';
const LOCAL_BACKEND_POLL_MS = 2000;
const LOCAL_BACKEND_START_TIMEOUT_MS = 1_800_000;

function waitForPoll(signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, LOCAL_BACKEND_POLL_MS);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Own provider selection, local readiness and setup-surface requests. */
export class RealtimeProvider {
  constructor({
    readUi,
    readStatus,
    readStartEpoch,
    readSessionProvider,
    readOpenProviderSettings,
    operations,
  }) {
    Object.assign(
      this,
      {
        readUi,
        readStatus,
        readStartEpoch,
        readSessionProvider,
        readOpenProviderSettings,
      },
      operations,
    );
    this.voiceProvider = readStoredVoiceProvider();
    this.localBackendState = null;
    this.localBackendPollTimer = null;
    this.statusAbort = null;
    this.disposed = false;
  }
  get ui() {
    return this.readUi();
  }
  get status() {
    return this.readStatus();
  }
  get startEpoch() {
    return this.readStartEpoch();
  }
  get sessionVoiceProvider() {
    return this.readSessionProvider();
  }
  get openProviderSettings() {
    return this.readOpenProviderSettings();
  }
  prepareSession() {
    this.voiceProvider = readStoredVoiceProvider();
    return this.voiceProvider;
  }
  /** Flip between OpenAI Realtime and the self-hosted LocalAI pipeline. */
  toggleVoiceProvider() {
    return this.setVoiceProvider(
      this.voiceProvider === 'local' ? 'openai' : 'local',
    );
  }

  /** Persist the provider used by the next session. */
  setVoiceProvider(provider) {
    this.voiceProvider = writeStoredVoiceProvider(provider);
    this.syncProviderUi();
    if (this.voiceProvider === 'local') void this.ensureLocalBackend();
    else this.stopWatchingLocalBackend();
    if (this.isVoiceSessionSettled()) this.syncCostUi();
    if (this.isActive() && this.ui?.detail) {
      this.setStatus(
        this.status,
        `${this.voiceProvider.toUpperCase()} applies next session`,
      );
    }
    return this.voiceProvider;
  }

  /** Reveal the setup surface without making readiness depend on the UI. */
  requestLocalVoiceSetup() {
    if (this.disposed) return false;
    try {
      return Boolean(this.openProviderSettings?.());
    } catch {
      return false;
    }
  }

  /** Wait for the selected LocalAI pipeline before opening the microphone. */
  async awaitLocalBackendReady(epoch, signal) {
    this.stopWatchingLocalBackend();
    const current = () =>
      !this.disposed && !signal?.aborted && epoch === this.startEpoch;
    const deadline = Date.now() + LOCAL_BACKEND_START_TIMEOUT_MS;
    let method = 'POST';
    while (Date.now() < deadline) {
      if (!current()) return { ok: false, detail: 'superseded' };
      let data;
      try {
        const response = await fetch(LOCAL_BACKEND_URL, {
          method,
          cache: 'no-store',
          signal,
        });
        data = await response.json().catch(() => null);
      } catch (error) {
        if (!current()) return { ok: false, detail: 'superseded' };
        return {
          ok: false,
          detail: `Local backend unreachable: ${error?.message || error}`,
        };
      }
      if (!current()) return { ok: false, detail: 'superseded' };
      method = 'GET';
      const state = data?.state || 'unavailable';
      this.setLocalBackendState(state, data?.detail || '');
      if (state === 'ready') return { ok: true };
      if (state === 'needs-setup') {
        this.requestLocalVoiceSetup();
        return {
          ok: false,
          detail:
            data?.detail ||
            'Local voice needs setup — run npm run voice:local:setup',
        };
      }
      if (state === 'unavailable' || state === 'stopped') {
        return {
          ok: false,
          detail: data?.detail || 'Local backend could not be started',
        };
      }
      this.setStatus('connecting', data?.detail || 'Starting local backend…');
      await waitForPoll(signal);
    }
    return {
      ok: false,
      detail: 'Local backend did not become ready in time',
    };
  }

  /** Start LocalAI after an explicit LOCAL selection and report its progress. */
  async ensureLocalBackend() {
    if (this.disposed) return;
    this.stopWatchingLocalBackend();
    const request = new AbortController();
    this.statusAbort = request;
    this.setLocalBackendState('starting', 'Starting local backend…');
    try {
      const response = await fetch(LOCAL_BACKEND_URL, {
        method: 'POST',
        cache: 'no-store',
        signal: request.signal,
      });
      const data = await response.json().catch(() => null);
      if (request.signal.aborted) return;
      this.setLocalBackendState(
        data?.state || 'unavailable',
        data?.detail || '',
      );
      if (data?.state === 'needs-setup') this.requestLocalVoiceSetup();
      if (data?.state === 'starting')
        this.watchLocalBackend({ openSetup: true });
    } catch (error) {
      if (request.signal.aborted) return;
      this.setLocalBackendState(
        'unavailable',
        error?.message || 'Local backend unreachable',
      );
    }
  }

  /** Read persisted LOCAL status without starting a backend on page load. */
  async refreshLocalBackendStatus() {
    if (this.disposed || this.voiceProvider !== 'local') return;
    this.stopWatchingLocalBackend();
    const request = new AbortController();
    this.statusAbort = request;
    try {
      const response = await fetch(LOCAL_BACKEND_URL, {
        cache: 'no-store',
        signal: request.signal,
      });
      const data = await response.json().catch(() => null);
      if (request.signal.aborted) return;
      this.setLocalBackendState(
        data?.state || 'unavailable',
        data?.detail || '',
      );
      if (data?.state === 'starting') this.watchLocalBackend();
    } catch {
      /* The explicit start path will surface an unavailable backend. */
    }
  }

  /** Poll a warming backend until it reaches a terminal state. */
  watchLocalBackend({ openSetup = false } = {}) {
    this.stopWatchingLocalBackend();
    if (this.disposed || this.voiceProvider !== 'local') return;
    const request = new AbortController();
    this.statusAbort = request;
    const poll = async () => {
      if (request.signal.aborted) return;
      this.localBackendPollTimer = null;
      try {
        const response = await fetch(LOCAL_BACKEND_URL, {
          cache: 'no-store',
          signal: request.signal,
        });
        const data = await response.json().catch(() => null);
        if (request.signal.aborted) return;
        const state = data?.state || 'unavailable';
        this.setLocalBackendState(state, data?.detail || '');
        if (openSetup && state === 'needs-setup') this.requestLocalVoiceSetup();
        if (state !== 'starting') {
          this.stopWatchingLocalBackend();
          return;
        }
      } catch {
        /* A transient failure can settle on the next poll. */
      }
      if (!request.signal.aborted)
        this.localBackendPollTimer = setTimeout(poll, LOCAL_BACKEND_POLL_MS);
    };
    this.localBackendPollTimer = setTimeout(poll, LOCAL_BACKEND_POLL_MS);
  }

  stopWatchingLocalBackend() {
    this.statusAbort?.abort();
    this.statusAbort = null;
    clearTimeout(this.localBackendPollTimer);
    this.localBackendPollTimer = null;
  }

  dispose() {
    this.disposed = true;
    this.stopWatchingLocalBackend();
  }

  setLocalBackendState(state, detail = '') {
    this.localBackendState = { state, detail };
    this.syncProviderUi();
    if (
      !this.isActive() &&
      this.ui?.detail &&
      this.voiceProvider === 'local' &&
      detail
    ) {
      this.ui.detail.textContent = detail.toUpperCase();
    }
  }

  /** Paint provider state and hide OpenAI-only tier and spend controls. */
  syncProviderUi() {
    const isLocal = this.voiceProvider === 'local';
    const liveProvider = this.sessionVoiceProvider || this.voiceProvider;
    const liveIsLocal = liveProvider === 'local';
    if (this.ui?.providerButton) {
      const backend = isLocal ? this.localBackendState?.state || null : null;
      const suffix = {
        starting: '…',
        ready: '',
        stopped: ' !',
        unavailable: ' !',
        'needs-setup': ' ?',
      };
      this.ui.providerButton.textContent = isLocal
        ? `LOCAL${suffix[backend] ?? ''}`
        : 'CLOUD';
      this.ui.providerButton.setAttribute(
        'aria-pressed',
        isLocal ? 'true' : 'false',
      );
      if (backend) this.ui.providerButton.dataset.backend = backend;
      else delete this.ui.providerButton.dataset.backend;
      const pending =
        this.sessionVoiceProvider && liveProvider !== this.voiceProvider
          ? ` Applies next session; this session stays on ${liveProvider.toUpperCase()}.`
          : '';
      this.ui.providerButton.title = isLocal
        ? `Voice backend: LOCAL — ${
            this.localBackendState?.detail || 'self-hosted Realtime endpoint'
          }. Click for OpenAI.${pending}`
        : `Voice backend: CLOUD (OpenAI Realtime) — click for local.${pending}`;
    }
    if (this.ui?.tierButton) this.ui.tierButton.hidden = liveIsLocal;
    if (this.ui?.costValue) this.ui.costValue.hidden = liveIsLocal;
  }
}
