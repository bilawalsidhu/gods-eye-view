/**
 * src/voice/ondemand/ui.js — the compact "OD VOICE" control: a push-to-talk
 * button, a status chip (IDLE / LISTENING / TRANSCRIBING / THINKING /
 * SPEAKING / ERROR reason), a route toggle (AUTO → WF → CHAT) and two
 * single-line readouts (transcript, answer) plus a workflow telemetry line.
 *
 * Lives in #command-dock right beside the existing GEV MIC control
 * (#gev-voice-control, which stays untouched). The markup is shipped in
 * src/ui/templates/command-dock.html so a headless driver can find it before
 * the app boots; this module fills it (or creates it when a host page lacks
 * the template) and mirrors pipeline events into it.
 *
 * Selectors (stable, for headless driving):
 *   #od-voice-control[data-state][data-route]   root
 *   #od-voice-button                            press-to-talk (aria-pressed while busy)
 *   #od-voice-status                            status chip text (uppercase state)
 *   #od-voice-detail                            state detail / error reason
 *   #od-voice-route                             route toggle (AUTO|WF|CHAT)
 *   #od-voice-transcript                        last transcript
 *   #od-voice-answer                            streamed / final answer
 *   #od-voice-workflow                          workflow telemetry (execution id, status, first log)
 *
 * The optional per-browser API key never reaches this module.
 */

const ROUTE_LABELS = Object.freeze({
  auto: 'AUTO',
  workflow: 'WF',
  chat: 'CHAT',
});
const ROUTE_ORDER = ['auto', 'workflow', 'chat'];

export const OD_VOICE_MARKUP = `
      <div class="od-voice-heading">
        <span class="od-voice-kicker">OD VOICE</span>
        <button id="od-voice-route" class="od-voice-route" type="button" aria-label="Thinking route: automatic" title="Thinking route — AUTO picks the workflow for spatial tasks, chat otherwise">AUTO</button>
      </div>
      <div class="od-voice-row">
        <button id="od-voice-button" class="od-voice-btn" type="button" aria-pressed="false" aria-label="OnDemand voice — press to talk, press again to send, press while speaking to interrupt" title="OnDemand voice (turn-based: STT → chat/workflow → TTS)">
          <span class="od-voice-mic" aria-hidden="true"></span>
          <span class="od-voice-btn-label">TALK</span>
        </button>
        <div class="od-voice-meta">
          <span id="od-voice-status" class="od-voice-chip" role="status" aria-live="polite">IDLE</span>
          <span id="od-voice-detail" class="od-voice-detail">Turn-based · OnDemand STT → chat/workflow → TTS</span>
        </div>
      </div>
      <div id="od-voice-transcript" class="od-voice-line od-voice-transcript" aria-live="polite"></div>
      <div id="od-voice-answer" class="od-voice-line od-voice-answer" aria-live="polite"></div>
      <div id="od-voice-workflow" class="od-voice-line od-voice-workflow" aria-live="off"></div>
`;

/** Mount (or adopt) the control and return its element handles. */
export function createOdVoiceUi({ doc = globalThis.document } = {}) {
  if (!doc) throw new TypeError('createOdVoiceUi needs a document');
  let root = doc.getElementById('od-voice-control');
  if (!root) {
    root = doc.createElement('div');
    root.id = 'od-voice-control';
  }
  root.classList.add('od-voice');
  if (!root.dataset.state) root.dataset.state = 'idle';
  if (!root.dataset.route) root.dataset.route = 'auto';
  root.setAttribute('aria-label', 'OnDemand voice');
  if (!root.querySelector('#od-voice-button')) root.innerHTML = OD_VOICE_MARKUP;
  placeBesideGevMic(root, doc);
  const q = (selector) => root.querySelector(selector);
  return {
    root,
    button: q('#od-voice-button'),
    buttonLabel: q('.od-voice-btn-label'),
    status: q('#od-voice-status'),
    detail: q('#od-voice-detail'),
    route: q('#od-voice-route'),
    transcript: q('#od-voice-transcript'),
    answer: q('#od-voice-answer'),
    workflow: q('#od-voice-workflow'),
  };
}

/** Sit immediately after the existing GEV MIC control when it exists. */
export function placeBesideGevMic(root, doc = globalThis.document) {
  const dock = doc.getElementById('command-dock');
  const gevMic = doc.getElementById('gev-voice-control');
  if (gevMic?.parentElement && gevMic.nextSibling !== root) {
    gevMic.parentElement.insertBefore(root, gevMic.nextSibling);
    return 'beside-gev-mic';
  }
  if (gevMic?.parentElement) return 'beside-gev-mic';
  if (dock) {
    if (root.parentElement !== dock) dock.appendChild(root);
    return 'dock';
  }
  if (!root.parentElement) (doc.body || doc.documentElement).appendChild(root);
  return 'body';
}

function truncate(text, max = 160) {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function ms(value) {
  return Number.isFinite(value) ? `${Math.round(value)} ms` : '—';
}

/**
 * Wire a pipeline to the control. Returns an unbind function.
 * @param {ReturnType<typeof createOdVoiceUi>} ui
 * @param {ReturnType<import('./pipeline.js').createVoicePipeline>} pipeline
 * @param {{ doc?: Document, onRelocate?: () => void }} [options]
 */
export function bindOdVoiceUi(
  ui,
  pipeline,
  { doc = globalThis.document } = {},
) {
  const {
    root,
    button,
    buttonLabel,
    status,
    detail,
    route,
    transcript,
    answer,
    workflow,
  } = ui;
  const busyStates = new Set([
    'listening',
    'transcribing',
    'thinking',
    'speaking',
  ]);
  const labels = {
    idle: 'TALK',
    error: 'RETRY',
    listening: 'SEND',
    transcribing: 'WAIT',
    thinking: 'STOP',
    speaking: 'CUT IN',
  };

  const setRoute = (mode) => {
    root.dataset.route = mode;
    if (route) {
      route.textContent = ROUTE_LABELS[mode] || 'AUTO';
      route.setAttribute(
        'aria-label',
        `Thinking route: ${mode === 'auto' ? 'automatic' : mode === 'workflow' ? 'OnDemand workflow + chat' : 'OnDemand chat only'}`,
      );
    }
  };
  setRoute(pipeline.getMode());

  const render = (state, text) => {
    root.dataset.state = state;
    if (status) status.textContent = state.toUpperCase();
    if (detail) {
      detail.textContent = truncate(
        text || (state === 'idle' ? 'Ready' : ''),
        140,
      );
      detail.title = String(text || '');
    }
    if (button) {
      button.setAttribute('aria-pressed', String(busyStates.has(state)));
      button.dataset.state = state;
    }
    if (buttonLabel) buttonLabel.textContent = labels[state] || 'TALK';
    if (state === 'listening') {
      if (transcript) transcript.textContent = '';
      if (answer) answer.textContent = '';
      if (workflow) workflow.textContent = '';
    }
  };
  render(pipeline.getState(), pipeline.getDetail());

  const unsubscribe = pipeline.subscribe((event) => {
    switch (event.type) {
      case 'state':
        render(event.state, event.detail);
        break;
      case 'mode':
        setRoute(event.mode);
        break;
      case 'transcript':
        if (transcript) transcript.textContent = `› ${truncate(event.text)}`;
        break;
      case 'answer':
        if (answer) {
          answer.textContent = event.text
            ? `‹ ${truncate(event.text, 220)}`
            : '';
          answer.dataset.partial = String(Boolean(event.partial));
          answer.dataset.source = event.source || 'chat';
        }
        break;
      case 'intents':
        if (workflow && event.results?.length) {
          workflow.textContent = `local: ${event.results
            .map(
              (r) =>
                `${r.layerId} ${r.enabled ? 'on' : 'off'}${r.ok ? '' : ' ✗'}`,
            )
            .join(', ')}`;
        }
        break;
      case 'workflow':
        if (!workflow) break;
        if (event.phase === 'executing')
          workflow.textContent = 'workflow: executing…';
        else if (event.phase === 'status')
          workflow.textContent = `workflow ${event.executionId || ''}: ${event.status || 'pending'} · poll ${event.polls} · ${ms(event.elapsedMs)}`;
        else if (event.phase === 'log')
          workflow.textContent = `workflow log: ${truncate(`${event.log?.nodeKey || ''} ${event.log?.message || ''}`, 120)}`;
        else if (event.phase === 'done')
          workflow.textContent = `workflow ${event.executionId || ''}: ${event.status} · first log ${ms(event.timeToFirstLogMs)} · total ${ms(event.totalMs)} · ${event.actionCount || 0} action(s)`;
        else if (event.phase === 'abandoned')
          workflow.textContent = 'workflow: abandoned (barge-in)';
        else if (event.phase === 'failed')
          workflow.textContent = `workflow: failed — ${truncate(event.error || '', 100)}`;
        workflow.dataset.phase = event.phase;
        break;
      case 'actions':
        if (workflow && event.results?.length) {
          const okCount = event.results.filter((r) => r.ok).length;
          workflow.textContent = `${event.source} actions: ${okCount}/${event.results.length} ok — ${event.results
            .map((r) => r.name)
            .join(', ')}`;
        }
        break;
      case 'tts-unavailable':
        if (detail)
          detail.textContent = truncate(
            `Answer shown as text — TTS: ${event.message}`,
            140,
          );
        break;
      default:
        break;
    }
  });

  const onPress = () => {
    void pipeline.press();
  };
  const onRoute = () => {
    const current = pipeline.getMode();
    const next =
      ROUTE_ORDER[(ROUTE_ORDER.indexOf(current) + 1) % ROUTE_ORDER.length];
    pipeline.setMode(next);
  };
  button?.addEventListener('click', onPress);
  route?.addEventListener('click', onRoute);

  // The GEV MIC control is injected at runtime after this control may have
  // been created from the template; keep our slot right beside it.
  let observer = null;
  const dock = doc?.getElementById?.('command-dock');
  if (dock && typeof MutationObserver === 'function') {
    observer = new MutationObserver(() => placeBesideGevMic(root, doc));
    observer.observe(dock, { childList: true });
  }

  return () => {
    unsubscribe();
    button?.removeEventListener('click', onPress);
    route?.removeEventListener('click', onRoute);
    observer?.disconnect();
  };
}
