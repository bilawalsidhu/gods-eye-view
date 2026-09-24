/**
 * TypeScript declarations for the public API of `src/ui/apiEndpoints.js`.
 *
 * All client-side fetch calls in the JARVIS AI Command Center go through
 * these constants so endpoint paths live in one place and can be referenced
 * by name. This avoids silently diverging paths when endpoints are renamed
 * or restructured.
 */

/** JARVIS tool execution & automation endpoints. */
export declare const JARVIS_API: {
  readonly execute: '/api/jarvis/execute';
  readonly memory: '/api/jarvis/memory';
  readonly sessions: '/api/jarvis/sessions';
  readonly deviceInfo: '/api/jarvis/device-info';
  readonly systemInfo: '/api/jarvis/system-info';
  readonly windows: '/api/jarvis/windows';
  readonly schedules: '/api/jarvis/schedules';
  readonly diagnostics: '/api/jarvis/diagnostics';
};

/** NVIDIA NIM inference endpoints. */
export declare const NVIDIA_API: {
  readonly chat: '/api/nvidia/chat';
  readonly status: '/api/nvidia/status';
  readonly models: '/api/nvidia/models';
  readonly assistant: '/api/nvidia/assistant';
  readonly research: '/api/nvidia/research';
  readonly genaiImage: '/api/nvidia/genai/image';
  readonly visionAnalyze: '/api/nvidia/vision/analyze';
};

/** OpenAI Realtime voice endpoints. */
export declare const OPENAI_API: {
  readonly token: '/api/realtime/token';
  readonly debugLog: '/api/realtime/debug-log';
  readonly hudSummary: '/api/openai/hud-summary';
};

/** Convenience object for the full endpoint map. */
export declare const API_ENDPOINTS: {
  [key: string]: string;
};

export default API_ENDPOINTS;
