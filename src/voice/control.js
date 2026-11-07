import { nextTick } from 'vue';
import { onLocaleChange, t } from '../i18n/index.js';
import { useVoiceStore } from '../ui/stores/voice.js';
import { applicationPinia } from '../ui/vueRuntime.js';

// The assistant's name on its card. i18n-ignore: product name
export const ASSISTANT_NAME = 'GEV';

/** Bars in the dock waveform. */
export const VOICE_VISUALIZER_BARS = 15;

/**
 * Short state label for the narrow voice heading. The `voice` context lets
 * languages use shorter words; unknown states show upper-cased.
 * @param {string} status machine state (dataset.status)
 * @returns {string}
 */
export function voiceStatusLabel(status) {
  switch (status) {
    case 'idle':
      return t('OFF', { context: 'voice' });
    case 'connecting':
      return t('CONNECTING', { context: 'voice' });
    case 'listening':
      return t('LISTENING', { context: 'voice' });
    case 'executing':
      return t('EXECUTING', { context: 'voice' });
    case 'error':
      return t('ERROR', { context: 'voice' });
    default:
      return String(status || '').toUpperCase();
  }
}

/** The card before its first render: hidden, with its default labels. */
function initialCard() {
  return {
    visible: false,
    busy: null,
    phase: '',
    user: { visible: false, text: '', label: t('YOU') },
    pointer: { visible: false, kind: t('THIS'), text: '' },
    assistant: { visible: false, text: '' },
    steps: [],
    result: {
      visible: false,
      title: '',
      chips: [],
      lines: [],
      referents: [],
      notes: [],
    },
    announce: '',
  };
}

/** The control as it first renders, before any owner writes to it. */
function initialState(panel) {
  return {
    panel,
    root: {
      status: 'idle',
      speaker: 'idle',
      provider: null,
      providerChoice: null,
      pushToTalk: null,
      microphone: null,
      rowGrace: false,
      errorDismissed: false,
      // Which assistant the dock shows as selected: idle, voice or chat.
      assistantMode: 'idle',
      chatOpen: false,
      chatBusy: false,
      // Set once either side has spoken this voice session.
      voiceExchange: false,
    },
    // The provider field and its select.
    provider: {
      hidden: true,
      options: [],
      value: '',
      title: () => t('Changing provider reconnects voice if it is on.'),
    },
    tier: {
      hidden: false,
      text: () => t('STD'),
      pressed: false,
      title: () => t('Voice model tier — applies next session'),
    },
    cost: {
      hidden: false,
      text: '~$0.00',
      level: 'ok',
      title: () => t('Estimated session cost'),
    },
    costWarning: { hidden: true, text: '', level: null, title: null },
    button: {
      label: () =>
        t('Voice control — activate to toggle voice; hold Space to speak'),
      pressed: null,
    },
    mic: { text: () => t('ON/OFF') },
    status: { text: () => voiceStatusLabel('idle') },
    detail: { text: () => t('VOICE STANDBY'), title: null },
    help: {
      text: () =>
        t('Hold Space to speak · tap Space to activate focused controls'),
    },
    // A typed chat error reads as chat's, without the microphone hint.
    error: { text: '', typed: false },
    // Connection and turn state beside the selected mode's indicator.
    phase: { text: '' },
    voicePanel: {
      hidden: true,
      view: null,
      previewHidden: false,
      settingsHidden: true,
      settingsExpanded: false,
      selected: 'preview',
      minimized: false,
      // 'chat' while Settings were opened from chat.
      context: null,
      // Chat's frame, so Settings opened from chat keep its size.
      frameWidth: null,
      frameHeight: null,
    },
    // The typed chat panel; its messages publish apart (setChatMessages).
    chat: {
      open: false,
      minimized: false,
      busy: false,
      status: () => t('Silent chat · microphone off'),
      empty: true,
      quickChecked: true,
      // The latest reply, shown above the minimized bar.
      miniReply: '',
      // A reply is typing out; the conversation is busy for screen readers.
      revealing: false,
      // Says chat bills the OpenAI key while voice uses ChatGPT sign-in.
      authNote: '',
      suggestions: [],
      attachments: [],
      attachMenuOpen: false,
      layers: [],
      locked: false,
      sendDisabled: true,
      // The input's text; bumped revision means the owner wrote it.
      draft: '',
      draftRevision: 0,
      rows: 2,
      backVisible: false,
    },
    // The minimized voice bar's last sentence from each side.
    mini: { user: '', assistant: '' },
    // Above the dock, or docked into the right rail's lane.
    // `yielded` names the panel minimized to make room for a dock tray;
    // `trayDocked` marks a dock taken only while a tray was open.
    layout: { docked: false, yielded: null, trayDocked: false },
    previewEmpty: {
      hidden: false,
      text: () => t('Voice replies appear here.'),
    },
    preferences: {
      previewChecked: true,
      previewNote: '',
      timeoutChoice: '5',
      timeoutMinutes: '5',
      timeoutInputHidden: false,
      timeoutNote: () => t('These preferences stay in this browser.'),
      timeoutStatus: '',
      // Bumped by every owner write of the fields, so the view restores a
      // refused edit but leaves a draft alone across other renders.
      revision: 0,
    },
    card: initialCard(),
  };
}

// The rendered elements the presenter focuses or measures, by name.
const ELEMENT_IDS = Object.freeze({
  root: 'gev-voice-control',
  button: 'gev-voice-button',
  provider: 'gev-voice-provider',
  voicePanel: 'gev-voice-panel',
  previewPanel: 'gev-voice-preview-panel',
  settingsPanel: 'gev-voice-settings-panel',
  previewTab: 'gev-voice-preview-tab',
  settingsTab: 'gev-voice-settings-tab',
  settingsButton: 'gev-voice-settings-button',
  settingsClose: 'gev-voice-settings-close',
  card: 'gev-voice-card',
  chatButton: 'gev-chat-button',
  chatPanel: 'gev-chat-panel',
  chatInput: 'gev-chat-input',
  chatLayer: 'gev-chat-layer',
  chatFile: 'gev-chat-file',
  chatBack: 'gev-chat-back',
  voiceBack: 'gev-voice-back',
  chatMiniReply: 'gev-chat-mini-reply',
});

let controlCount = 0;

const sameBars = (a, b) =>
  a === b ||
  (Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every(
      (bar, index) =>
        bar.level === b[index].level && bar.opacity === b[index].opacity,
    ));

/**
 * The voice control, independent of its connection backend. Session owners
 * write its state by part (`update('detail', {text})`) and listen for what
 * the person does (`on('button', fn)`); the command dock's VoiceControl view
 * renders it from the voice store. A newer control replaces this one there.
 * @param {object} [options]
 * @param {boolean} [options.panel] Show the Voice Settings panel and preview.
 */
export function createVoiceControl({
  panel = false,
  store = useVoiceStore(applicationPinia()),
} = {}) {
  const id = ++controlCount;
  const listeners = new Map();
  // The fields given as functions, by part: they are called again when the
  // locale changes, so the control's words follow the language.
  const wording = new Map();
  const word = (part, patch) => {
    let fields = wording.get(part);
    let worded = patch;
    for (const [field, value] of Object.entries(patch)) {
      if (typeof value !== 'function') {
        fields?.delete(field);
        continue;
      }
      if (!fields) wording.set(part, (fields = new Map()));
      fields.set(field, value);
      if (worded === patch) worded = { ...patch };
      worded[field] = value();
    }
    return worded;
  };
  let state = initialState(Boolean(panel));
  for (const [part, value] of Object.entries(state))
    if (part !== 'card' && value && typeof value === 'object')
      state[part] = word(part, value);
  // The default card's labels follow the locale until a card replaces it.
  let defaultCard = true;
  // Each bar's `--audio-level` and `--audio-opacity`, or null at rest.
  let bars = null;
  let chatMessages = [];
  let removed = false;
  const owns = () => !removed && store.controls === ui;
  const publish = () => {
    if (owns()) store.publish({ ...state, id });
  };
  const element = (name) =>
    owns()
      ? (globalThis.document?.getElementById(ELEMENT_IDS[name]) ?? null)
      : null;
  const shown = (node) =>
    Boolean(
      node?.checkVisibility?.({
        opacityProperty: true,
        visibilityProperty: true,
      }) ?? node,
    );
  const ui = {
    get panel() {
      return state.panel;
    },
    /** The current state; read-only, replaced on every update. */
    get state() {
      return state;
    },
    /**
     * Merge `patch` into one part of the control. A field given as a
     * function is shown as what it returns, and called again when the
     * locale changes; give translated words that way.
     */
    update(part, patch) {
      if (removed) return;
      state = { ...state, [part]: { ...state[part], ...word(part, patch) } };
      publish();
    },
    /** Replace one part of the control. */
    replace(part, value) {
      if (removed) return;
      wording.delete(part);
      if (part === 'card') defaultCard = false;
      state = { ...state, [part]: value };
      publish();
    },
    /**
     * Listen for an interaction the view reports: `button`, `tier`,
     * `provider-change`, `settings-button`, `settings-close`, `tab`,
     * `tab-keydown`, `panel-keydown`, `pointerenter`, `pointerleave`,
     * `preview-change`, `timeout-select`, `timeout-input`, `card-dismiss`,
     * `voice-back`, `voice-minimize`, `layout-dock`; the chat's
     * `chat-button`, `chat-close`, `chat-minimize`, `chat-restore`,
     * `chat-back`, `chat-input`, `chat-keydown`, `chat-submit`, `chat-stop`,
     * `chat-prompt`, `chat-suggestion`, `chat-quick-change`,
     * `chat-attach-toggle`, `chat-layer`, `chat-file-button`, `chat-files`,
     * `chat-attachment-remove`; and `locale` after a locale change, for an
     * owner's own words.
     * @returns {() => void} Removes the listener.
     */
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
      return () => listeners.get(name)?.delete(listener);
    },
    /** The view reports an interaction; listeners run in the order added. */
    emit(name, ...args) {
      if (removed) return;
      for (const listener of [...(listeners.get(name) ?? [])])
        listener(...args);
    },
    /** The waveform's bars, or null at rest. */
    get bars() {
      return bars;
    },
    /** The chat conversation, as last published. */
    get chatMessages() {
      return chatMessages;
    },
    /**
     * Show the chat conversation. Published apart from the rest of the
     * control: a typed reply reveals frame by frame.
     * @param {Array<{id: number, role: string, text: string}>} next
     */
    setChatMessages(next) {
      if (removed) return;
      chatMessages = next;
      if (owns()) store.publishChat(chatMessages);
    },
    /**
     * Show the waveform's bars (null rests it). Published apart from the
     * rest of the control, and only when they change.
     * @param {?Array<{level: string, opacity: string}>} next
     */
    setBars(next) {
      if (removed || sameBars(bars, next)) return;
      bars = next;
      if (owns()) store.publishBars(bars);
    },
    /** The error tray's DISMISS. */
    dismissError() {
      ui.update('root', { errorDismissed: true });
    },
    /** The rendered element by name, or null before it renders. */
    element,
    /** Whether the named element is rendered and visible on the page. */
    visible: (name) => shown(element(name)),
    /**
     * Once the view has rendered the latest state, focus the first of the
     * named elements that is visible, or with `anyVisibility`, that is
     * rendered (focus may be what reveals it).
     * @param {string[]} names
     * @param {{anyVisibility?: boolean}} [options]
     */
    focus(names, { anyVisibility = false } = {}) {
      return nextTick(() => {
        const target = names
          .map(element)
          .find((node) => node && (anyVisibility || shown(node)));
        target?.focus?.();
        return target ?? null;
      });
    },
    /** Remove the control from the dock, unless a newer one replaced it. */
    remove() {
      if (removed) return;
      if (store.controls === ui) {
        store.connect(null);
        store.publish(null);
        store.publishBars(null);
        store.publishChat([]);
      }
      removed = true;
      offLocale();
      listeners.clear();
    },
  };
  const offLocale = onLocaleChange(() => {
    if (removed) return;
    for (const [part, fields] of wording) {
      const patch = {};
      for (const [field, value] of fields) patch[field] = value();
      state = { ...state, [part]: { ...state[part], ...patch } };
    }
    if (defaultCard) state = { ...state, card: initialCard() };
    publish();
    ui.emit('locale');
  });
  store.connect(ui);
  store.publishBars(null);
  store.publishChat(chatMessages);
  publish();
  return ui;
}
