/**
 * TypeScript declarations for the public API of `src/ui/aiCommandCenter.js`.
 *
 * The JARVIS AI Command Center is a persistent tactical panel inside God's Eye
 * View providing universal AI conversation, globe control, code execution,
 * workflow automation, study mode, web research, persistent memory, multimodal
 * vision, hands-free voice intercom, drone recon, CCTV surveillance grid, and
 * geospatial threat scanning.
 */

import type {
  DroneReconController,
  CctvSurveillanceGrid,
  GeoDataPlotter,
  GeospatialThreatScanner,
} from './tactical/index.js';

/** Procedural Web Audio cue types. */
export type AudioCueType = 'wake' | 'alert' | 'recon' | 'data' | 'comm';

/** Options for the procedural audio cue synthesizer. */
export interface PlayAudioCueOptions {
  /** Optional AudioContext factory or instance used to prevent context exhaustion. */
  audioContextRef?: unknown;
}

/**
 * Procedural Web Audio Sound Synthesizer — zero external audio assets required.
 * Generates futuristic sci-fi chimes, wake-word pings, tactical alert sirens,
 * and data chirps.
 */
export declare function playAudioCue(
  type?: AudioCueType,
  options?: PlayAudioCueOptions,
): void;

/** A single voice persona model with customized acoustic properties. */
export interface VoiceModelProfile {
  readonly id: string;
  readonly name: string;
  readonly gender: 'male' | 'female' | 'neutral';
  readonly pitch: number;
  readonly rate: number;
  readonly preferredVoices: readonly string[];
  readonly description: string;
}

/**
 * AI Voice Personas / Voice Models with customized acoustic properties.
 * Frozen map of persona id -> acoustic profile.
 */
export declare const VOICE_MODELS: Readonly<
  Record<string, VoiceModelProfile>
>;

/**
 * Detect written language from text script and lexical tokens.
 * Supports Devanagari (Hindi), Japanese, Chinese, Arabic, Cyrillic, Spanish,
 * French, German, Italian, Portuguese, and English.
 */
export declare function detectTextLanguage(
  text: string | null | undefined,
): string;

/**
 * Select the highest-quality browser TTS voice matching target language and
 * voice persona model. Prioritizes Microsoft Online / Natural, Google, and
 * Apple Neural voices matching persona timbre.
 */
export declare function selectBestVoice(
  voices: SpeechSynthesisVoice[],
  targetLang: string,
  preferredVoiceName?: string,
  voiceModelId?: string,
): SpeechSynthesisVoice | null;

/**
 * Extracts and cleans thinking/reasoning traces from model outputs.
 * Supports ``, `<thought>...</thought>`,
 * `<reasoning>...</reasoning>`, fenced ```thought ... ``` blocks, and leading
 * "Here's a thinking process:" blocks.
 */
export declare function extractThinking(text: string): {
  content: string;
  reasoning: string;
};

/** Options for markdown formatting. */
export interface FormatMarkdownOptions {
  /** When true (default), thinking traces are stripped from the rendered output. */
  hideThinking?: boolean;
}

/**
 * Format markdown-like text to HTML safely with code highlighting, tables, and
 * structured styling.
 */
export declare function formatMarkdown(
  text: string,
  options?: FormatMarkdownOptions,
): string;

/**
 * Detect whether a user prompt represents a God's Eye View 3D Globe action,
 * navigation command, geospatial layer toggle, or tactical camera maneuver.
 */
export declare function isGlobePrompt(text: string): boolean;

/** Callback returning the current globe context for AI requests. */
export type GlobeContextProvider = () => Record<string, unknown> | null;

/** Callback executing a named globe action with structured arguments. */
export type GlobeActionExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/** Options accepted by {@link initAiCommandCenter}. */
export interface AiCommandCenterOptions {
  /** DOM id of the panel container element. Defaults to `'ai-command-panel'`. */
  containerId?: string;
  /** Document implementation used for element lookups. Defaults to `globalThis.document`. */
  documentRef?: Document;
  /** Callback returning the current globe context for AI requests. */
  getGlobeContext?: GlobeContextProvider;
  /** Callback executing a named globe action with structured arguments. */
  executeGlobeAction?: GlobeActionExecutor;
}

/** Voice settings snapshot returned by {@link AiCommandController.getVoiceSettings}. */
export interface VoiceSettings {
  lang: string;
  preferredVoice: string;
  voiceModel: string;
  rate: number;
  pitch: number;
  micLang: string;
}

/** Partial voice settings accepted by {@link AiCommandController.setVoiceSettings}. */
export type PartialVoiceSettings = Partial<VoiceSettings>;

/** Result returned by {@link AiCommandController.appendMessage}. */
export interface AppendedMessage {
  msgEl: HTMLElement;
  bubble: HTMLElement;
  headerDiv: HTMLElement;
  contentDiv: HTMLElement;
  updateThinking: (reasoningText: string) => void;
}

/**
 * Message role for chat messages appended via
 * {@link AiCommandController.appendMessage}.
 */
export type MessageRole = 'user' | 'assistant';

/** Options for {@link AiCommandController.appendMessage}. */
export interface AppendMessageOptions {
  reasoning?: string | null;
  toolExecutions?: unknown[] | null;
  iterations?: number | null;
  council?: unknown[] | null;
  routedModel?: string | null;
  routedReason?: string | null;
}

/**
 * Public controller interface exposed by the JARVIS AI Command Center.
 *
 * Returned by {@link initAiCommandCenter} and stashed on the panel element as
 * `_aiCommandController` for later retrieval.
 */
export interface AiCommandController {
  /** Toggle panel collapse/expand. With no argument, toggles current state. */
  toggle(open?: boolean | null): void;
  /** Switch the active conversation mode (e.g. `'general'`, `'globe'`, `'code'`). */
  setMode(newMode: string): void;
  /** Switch the active panel view (e.g. `'chat'`, `'history'`, `'models'`, `'voice'`). */
  switchView(viewName: string): void;
  /** Switch the active AI model/provider. */
  switchModel(model: string, notify?: boolean): void;
  /** Get the currently active model identifier. */
  getModel(): string;
  /**
   * Append a message to the chat UI.
   * @returns The created DOM elements, or `null` if the messages container is missing.
   */
  appendMessage(
    role: MessageRole,
    text: string,
    options?: AppendMessageOptions,
  ): AppendedMessage | null;
  /** Append a voice exchange (user speech + AI response) to the chat. */
  appendVoiceExchange(userSpeech?: string, aiResponse?: string): void;
  /** Toggle or force the in-chat search bar. */
  toggleSearch(forceState?: boolean | null): void;
  /** Scroll the chat to the latest message. */
  scrollToBottom(smooth?: boolean): void;
  /** Scroll the chat to the top. */
  scrollToTop(smooth?: boolean): void;
  /** Get the currently active view name. */
  getView(): string;
  /** Programmatically send a message as the operator. */
  sendMessage(text: string): void;
  /** Update the globe context/action callbacks after initialization. */
  updateGlobeCallbacks(options: {
    getGlobeContext?: GlobeContextProvider;
    executeGlobeAction?: GlobeActionExecutor;
  }): void;
  /** Unlock the chat input and reset streaming state. */
  unlock(): void;
  /** Speak text via the browser speech synthesis API. */
  speak(text: string): void;
  /** Get a snapshot of the current voice settings. */
  getVoiceSettings(): VoiceSettings;
  /** Merge partial voice settings into the current configuration. */
  setVoiceSettings(newSettings: PartialVoiceSettings): void;
  /** Autonomous drone recon flyover controller. */
  droneRecon: DroneReconController;
  /** Floating Picture-in-Picture CCTV surveillance grid controller. */
  cctvGrid: CctvSurveillanceGrid;
  /** Drag-and-drop 3D geospatial data plotter controller. */
  geoPlotter: GeoDataPlotter;
  /** Real-time geospatial anomaly & threat scanner controller. */
  threatScanner: GeospatialThreatScanner;
  /** Toggle the hands-free "Hey JARVIS" wake-word intercom. */
  toggleWakeWord(): void;
  /** Whether the hands-free wake-word intercom is currently active. */
  isWakeWordActive(): boolean;
  /** Play a procedural Web Audio cue. */
  playAudioCue(type?: AudioCueType, options?: PlayAudioCueOptions): void;
  /** Update the gesture status pill shown in the HUD. */
  setGestureStatus(options?: {
    enabled?: boolean;
    lastGesture?: string;
  }): void;
  /** Handle a gesture-driven target lock on a tracked entity. */
  handleGestureTargetLock(entity: unknown): void;
  /** Request a tactical SITREP summarizing current airspace, maritime traffic, and threats. */
  requestTacticalSitrep(): void;
  /** Toggle the push-to-talk voice control. */
  toggleVoice(): void;
  /** Confirm a pending AI action (plays a data cue). */
  confirmPendingAction(): void;
  /** Dismiss the current pending action (aborts streaming and plays a comm cue). */
  dismissCurrentAction(): void;
}

/**
 * Initialize JARVIS AI Command Center inside the DOM.
 *
 * @returns The command controller, or `null` if the panel container is missing.
 */
export declare function initAiCommandCenter(
  options?: AiCommandCenterOptions,
): AiCommandController | null;

/** Quick action prompts per conversation mode. */
export declare const MODE_PRESETS: Record<string, string[]>;