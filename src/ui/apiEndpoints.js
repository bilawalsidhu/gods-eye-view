/**
 * Centralized API endpoint definitions for the JARVIS AI Command Center.
 *
 * All client-side fetch calls go through these constants so that endpoint
 * paths live in one place and can be referenced by name. This avoids
 * silently diverging paths when endpoints are renamed or restructured.
 */

/** JARVIS tool execution & automation endpoints */
export const JARVIS_API = {
  execute: '/api/jarvis/execute',
  memory: '/api/jarvis/memory',
  sessions: '/api/jarvis/sessions',
  deviceInfo: '/api/jarvis/device-info',
  systemInfo: '/api/jarvis/system-info',
  windows: '/api/jarvis/windows',
  schedules: '/api/jarvis/schedules',
  diagnostics: '/api/jarvis/diagnostics',
};

/** NVIDIA NIM inference endpoints */
export const NVIDIA_API = {
  chat: '/api/nvidia/chat',
  status: '/api/nvidia/status',
  models: '/api/nvidia/models',
  assistant: '/api/nvidia/assistant',
  research: '/api/nvidia/research',
  genaiImage: '/api/nvidia/genai/image',
  visionAnalyze: '/api/nvidia/vision/analyze',
};

/** OpenAI Realtime voice endpoints */
export const OPENAI_API = {
  token: '/api/realtime/token',
  debugLog: '/api/realtime/debug-log',
  hudSummary: '/api/openai/hud-summary',
};

/** Convenience object for the full endpoint map. */
export const API_ENDPOINTS = {
  ...JARVIS_API,
  ...NVIDIA_API,
  ...OPENAI_API,
};

export default API_ENDPOINTS;
