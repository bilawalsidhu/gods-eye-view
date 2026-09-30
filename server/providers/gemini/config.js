import { realtimeInstructions } from '../openai/instructions.js';
import { GEV_REALTIME_TOOLS } from '../openai/tools.js';

export const GEMINI_LIVE_MODEL_DEFAULT = 'gemini-3.8-live';
export const GEMINI_TOKEN_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
export const GEMINI_LIVE_WEBSOCKET_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

export function normalizeGeminiModel(value) {
  const model = String(value ?? GEMINI_LIVE_MODEL_DEFAULT)
    .trim()
    .replace(/^models\//, '');
  return /^gemini-[a-z0-9][a-z0-9.-]{0,119}$/.test(model) ? model : null;
}

/** REST BidiGenerateContentSetup fields, excluding its model resource name. */
export function createGeminiLiveConfig(
  annotationGuidance,
  inputMode = 'open-mic',
) {
  if (!['open-mic', 'push-to-talk'].includes(inputMode))
    throw new Error('Invalid Gemini input mode');
  const config = {
    generationConfig: { responseModalities: ['AUDIO'] },
    systemInstruction: {
      parts: [{ text: realtimeInstructions(annotationGuidance) }],
    },
    tools: [
      {
        functionDeclarations: GEV_REALTIME_TOOLS.map(
          ({ name, description, parameters }) => ({
            name,
            description,
            // GEV's canonical schemas are JSON Schema, not Google's Schema.
            parametersJsonSchema: structuredClone(parameters),
            // App actions must finish before the model confirms their result.
            behavior: 'BLOCKING',
          }),
        ),
      },
    ],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: {} },
  };
  if (inputMode === 'push-to-talk')
    config.realtimeInputConfig = {
      automaticActivityDetection: { disabled: true },
    };
  return config;
}
