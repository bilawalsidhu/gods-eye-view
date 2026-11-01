import { t } from '../../i18n/index.js';
import { createManualVoicePanel } from './manualPanel.js';
import {
  createVoicePreferences,
  bindPreferenceControls,
} from './preferences.js';
import { createPanelActionObserver } from './actionObserver.js';
import { observeNativeActivity } from './nativeActivity.js';
import { createVoiceInactivity } from './inactivity.js';

/** One UI/preference owner across provider mounts; no semantic voice routes. */
export function createVoicePanelHost({
  storage,
  clock = {},
  readCockpitState = () => ({
    active:
      globalThis.document?.body?.classList?.contains('cockpit-mode') === true,
  }),
} = {}) {
  const preferences = createVoicePreferences({ storage });
  let current = null;
  let disposed = false;
  let saved = { view: 'preview', panelOpen: false, automatic: true };
  function observeActions(hooks) {
    const observer = createPanelActionObserver({
      runAction: hooks.runAction,
      signal: hooks.signal,
      onObservation: () => {
        if (current?.observer === observer) current.workChanged();
      },
    });
    return observer;
  }
  function mount({ ui, card, session, observer, nativeProvider }) {
    if (disposed || !ui.voicePanel || !card?.setEnabled || !card?.setPresented)
      return null;
    current?.destroy();
    let dead = false;
    let revision = 0;
    let operationEpoch = 0;
    let operationWrite = false;
    let panel;
    let idle;
    let refreshQueued = false;
    let automatic = saved.automatic;
    let inputBusy = false;
    let finalTranscript = null;
    const presentationLifetime = new AbortController();
    const rearm = () => {
      if (!owns() || !session.isActive()) return;
      automatic = true;
      saved.automatic = true;
      card.rearm?.();
      // Unknown IDs cannot distinguish a fresh identical answer after input.
      if (!finalTranscript?.id) finalTranscript = null;
    };
    const owns = () =>
      !dead && !disposed && current === binding && !session.disposed;
    const remember = ({ automatic: auto = false } = {}) => {
      if (!auto) {
        revision++;
        automatic = false;
      }
      if (panel) {
        const value = panel.snapshot();
        saved = { view: value.view, panelOpen: value.panelOpen, automatic };
      }
    };
    const renderActivity = () => {
      if (ui.voiceTimeoutStatus)
        ui.voiceTimeoutStatus.textContent =
          nativeProvider === 'openai' || nativeProvider === 'gemini'
            ? ''
            : t('Automatic stop is unavailable for this voice connection.');
    };
    const changed = () => {
      if (!owns()) return;
      const busy = activity.snapshot().inputBusy;
      if (busy && !inputBusy) rearm();
      inputBusy = busy;
      idle?.update({ activity: true });
      renderActivity();
    };
    const activity = observeNativeActivity({
      adapter: session.adapter,
      nativeProvider,
      signal: session.signal,
      onChange: changed,
      onInput: rearm,
    });
    const closeAfterStop = (ticket) => {
      if (owns() && ticket === revision && !session.isActive()) panel.close();
    };
    const binding = {
      observer,
      get panel() {
        return panel;
      },
      stopTicket: () => revision,
      closeAfterStop,
      workChanged: changed,
      captureOperation() {
        const stamp = revision;
        const epoch = operationEpoch;
        const isCurrent = () =>
          owns() && stamp === revision && epoch === operationEpoch;
        const cancelled = () => ({
          ok: false,
          applied: false,
          cancelled: true,
        });
        return {
          isCurrent,
          setMinutes(value) {
            if (!isCurrent()) return cancelled();
            if (typeof value !== 'number' || !Number.isInteger(value))
              return {
                ok: false,
                applied: false,
                changed: false,
                persisted: null,
                reason: 'invalid-value',
                minutes: preferences.snapshot().minutes,
              };
            let result;
            operationWrite = true;
            try {
              result = preferences.setMinutes(value);
            } finally {
              operationWrite = false;
            }
            return {
              ok: result.ok,
              applied: result.applied,
              changed: result.changed,
              persisted: result.persisted,
              minutes: result.minutes,
              ...(result.reason ? { reason: result.reason } : {}),
            };
          },
          show(view, open = true) {
            if (!isCurrent()) return cancelled();
            const result = open ? panel.select(view) : panel.close(view);
            return { ...result, applied: result.ok };
          },
        };
      },
      handle(event) {
        if (!owns()) return;
        if (event.type !== 'state' && !session.isActive()) return;
        if (
          event.type === 'state' &&
          ['connecting', 'idle', 'error'].includes(event.state)
        ) {
          finalTranscript = null;
          if (event.state !== 'connecting') saved.automatic = automatic = false;
        }
        if (
          event.type === 'interruption' &&
          !event.preserveAdvisoryCaption &&
          ['user-speech', 'user-text', 'push-to-talk'].includes(event.reason)
        )
          rearm();
        if (
          event.type === 'transcript' &&
          event.role === 'assistant' &&
          event.text
        ) {
          const id = event.responseId || event.itemId || null;
          if (
            finalTranscript &&
            (id ? id === finalTranscript.id : !finalTranscript.id) &&
            ((!event.final && id) ||
              (event.final && event.text === finalTranscript.text))
          )
            return;
          if (event.final) finalTranscript = { id, text: event.text };
          if (
            automatic &&
            preferences.snapshot().previewEnabled &&
            !readCockpitState()?.active
          )
            panel.select('preview', { automatic: true });
        }
        // A retired native boundary is not fresh input and must not revive
        // dismissal or erase the advisory caption it explicitly preserves.
        if (!(event.type === 'interruption' && event.preserveAdvisoryCaption))
          card.handle(event);
        if (
          event.type === 'interruption' ||
          (event.type === 'state' &&
            ['connecting', 'idle', 'error'].includes(event.state))
        ) {
          operationEpoch++;
          observer.retire('session-boundary');
        }
        activity.handle(event);
        idle?.update();
        // Native controllers finish processing after forwarding some events.
        // One guarded microtask refresh reads the final current local state.
        if (!refreshQueued) {
          refreshQueued = true;
          queueMicrotask(() => {
            refreshQueued = false;
            if (!owns()) return;
            activity.handle({ type: 'refresh' });
            idle?.update();
          });
        }
      },
      snapshot: () => ({
        ...panel.snapshot(),
        preferences: preferences.snapshot(),
        activity: activity.snapshot(),
        inactivity: idle.snapshot(),
      }),
      destroy() {
        if (dead) return;
        dead = true;
        presentationLifetime.abort();
        idle?.destroy();
        activity.destroy();
        fields.dispose();
        observer.dispose();
        panel.destroy();
        session.signal.removeEventListener('abort', binding.destroy);
        if (current === binding) current = null;
      },
    };
    current = binding;
    panel = createManualVoicePanel({
      ui,
      card,
      getPreviewEnabled: () => preferences.snapshot().previewEnabled,
      getCockpitActive: () => readCockpitState()?.active === true,
      copy: {
        previewEmpty: t('Voice replies appear here.'),
        previewDisabled: t('Preview is off.'),
      },
      onPresentationIntent: remember,
    });
    const fields = bindPreferenceControls({
      ui,
      preferences,
      copy: {
        previewNote: '',
        timeoutNote: t('These preferences stay in this browser.'),
        notSaved: t('Your choice applies now, but could not be saved.'),
      },
      onChange: (state) => {
        if (!owns()) return;
        if (!operationWrite) revision++;
        card.setEnabled(state.previewEnabled);
        panel.sync();
        idle?.setMinutes(state.minutes);
      },
    });
    globalThis.window?.addEventListener(
      'gev:cockpit-mode-changed',
      () => {
        if (owns()) panel.sync();
      },
      { signal: presentationLifetime.signal },
    );
    ui.root?.querySelector('#gev-voice-card-dismiss')?.addEventListener(
      'click',
      () => {
        remember();
        if (panel.snapshot().panelOpen) ui.previewTab?.focus();
      },
      { signal: presentationLifetime.signal },
    );
    card.setEnabled(preferences.snapshot().previewEnabled);
    panel.sync();
    idle = createVoiceInactivity({
      readActivity: activity.snapshot,
      readPending: () => observer.pendingCount,
      minutes: preferences.snapshot().minutes,
      signal: session.signal,
      ...clock,
      onExpire: () => {
        if (!owns()) return;
        const ticket = revision;
        session.stop();
        closeAfterStop(ticket);
      },
    });
    if (saved.panelOpen) panel.select(saved.view, { automatic: true });
    renderActivity();
    session.signal.addEventListener('abort', binding.destroy, { once: true });
    if (session.signal.aborted) binding.destroy();
    return binding;
  }
  return {
    observeActions,
    mount,
    snapshot: () => preferences.snapshot(),
    destroy() {
      if (disposed) return;
      current?.destroy();
      disposed = true;
    },
  };
}
