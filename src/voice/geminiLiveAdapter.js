/**
 * @file geminiLiveAdapter.js
 * @description Client-side bridge for Google Gemini 3.8 Multimodal Live API.
 * Streams 16kHz PCM mic input, plays 24kHz PCM audio output, and maps Gemini tool calls to GEV actions.
 */

import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import { realtimeInstructions } from '../../server/providers/openai/instructions.js';

function sanitizeSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForGemini);

  const clean = {};
  const FORBIDDEN_KEYS = new Set(['additionalProperties', 'strict', '$schema', 'default']);

  for (const [key, value] of Object.entries(schema)) {
    if (FORBIDDEN_KEYS.has(key)) continue;

    if (key === 'type' && typeof value === 'string') {
      clean.type = value.toUpperCase();
    } else if (key === 'required' && Array.isArray(value)) {
      if (value.length > 0) clean.required = value;
    } else if (key === 'properties' && typeof value === 'object' && value !== null) {
      clean.properties = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        clean.properties[propName] = sanitizeSchemaForGemini(propSchema);
      }
    } else if (key === 'items' && typeof value === 'object' && value !== null) {
      clean.items = sanitizeSchemaForGemini(value);
    } else if (typeof value === 'object' && value !== null) {
      clean[key] = sanitizeSchemaForGemini(value);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

function convertToolsToGeminiDeclarations(openAiTools) {
  return (openAiTools || []).map((tool) => {
    const decl = {
      name: tool.name,
      description: tool.description || '',
    };
    if (tool.parameters) {
      decl.parameters = sanitizeSchemaForGemini(tool.parameters);
    }
    return decl;
  });
}

function downsampleTo16kHz(inputBuffer, inputSampleRate) {
  if (inputSampleRate === 16000) {
    const pcm16 = new Int16Array(inputBuffer.length);
    for (let i = 0; i < inputBuffer.length; i++) {
      const s = Math.max(-1, Math.min(1, inputBuffer[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm16;
  }

  const ratio = inputSampleRate / 16000;
  const newLength = Math.round(inputBuffer.length / ratio);
  const result = new Int16Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const index = Math.min(Math.floor(i * ratio), inputBuffer.length - 1);
    const s = Math.max(-1, Math.min(1, inputBuffer[index]));
    result[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return result;
}

function bytesToBase64(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i += 1024) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 1024, len)));
  }
  return btoa(binary);
}

export class GeminiLiveSession {
  constructor({ onMessage, onError, onClose, onOpen }) {
    this.ws = null;
    this.onMessage = onMessage;
    this.onError = onError;
    this.onClose = onClose;
    this.onOpen = onOpen;
    this.audioContext = null;
    this.processor = null;
    this.audioInput = null;
    this.playbackContext = null;
    this.nextPlayTime = 0;
    this.chunkCount = 0;
    this.isSetupComplete = false;
  }

  async connect(stream) {
    await this.initAudioCapture(stream);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/realtime/gemini-live`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[Gemini Live] Sending setup handshake to Google...');
        const setupMessage = {
          setup: {
            model: 'models/gemini-3.8-live',
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: 'Puck',
                  },
                },
              },
            },
            systemInstruction: {
              parts: [{ text: realtimeInstructions() }],
            },
            tools: [{
              functionDeclarations: convertToolsToGeminiDeclarations(GEV_REALTIME_TOOLS),
            }],
          },
        };
        this.ws.send(JSON.stringify(setupMessage));
        this.onOpen?.();
        resolve(this);
      };

      this.ws.onmessage = (event) => this.handleServerMessage(event);
      this.ws.onerror = (err) => {
        this.onError?.(err);
        reject(err);
      };
      this.ws.onclose = () => {
        this.stopAudioCapture();
        this.onClose?.();
      };
    });
  }

  async initAudioCapture(stream) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContext();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    const actualSampleRate = this.audioContext.sampleRate;
    this.audioInput = this.audioContext.createMediaStreamSource(stream);

    const bufferSize = 4096;
    this.processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

    this.processor.onaudioprocess = (e) => {
      if (!this.isSetupComplete || this.ws?.readyState !== WebSocket.OPEN) return;

      const inputData = e.inputBuffer.getChannelData(0);

      let maxAmp = 0;
      for (let i = 0; i < inputData.length; i++) {
        const abs = Math.abs(inputData[i]);
        if (abs > maxAmp) maxAmp = abs;
      }

      const pcm16 = downsampleTo16kHz(inputData, actualSampleRate);
      const bytes = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
      const base64Audio = bytesToBase64(bytes);

      this.chunkCount++;
      if (maxAmp > 0.03 && this.chunkCount % 10 === 0) {
        console.log(`[Gemini Live Mic] Level: ${maxAmp.toFixed(3)} (Streaming voice)`);
      }

      // Send both typed `audio` and fallback `mediaChunks` for maximum compatibility
      this.ws.send(JSON.stringify({
        realtimeInput: {
          audio: {
            mimeType: 'audio/pcm;rate=16000',
            data: base64Audio,
          },
          mediaChunks: [{
            mimeType: 'audio/pcm;rate=16000',
            data: base64Audio,
          }],
        },
      }));
    };

    this.audioInput.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  stopAudioCapture() {
    this.isSetupComplete = false;
    this.processor?.disconnect();
    this.audioInput?.disconnect();
    this.audioContext?.close().catch(() => {});
  }

  async handleServerMessage(event) {
    try {
      let text;
      if (typeof event.data === 'string') {
        text = event.data;
      } else if (event.data instanceof Blob) {
        text = await event.data.text();
      } else if (event.data instanceof ArrayBuffer) {
        text = new TextDecoder().decode(event.data);
      } else {
        text = String(event.data);
      }

      const data = JSON.parse(text);

      // 1. Setup Acknowledgement
      if (data.setupComplete) {
        console.log('%c[Gemini 3.8 Live] Setup Complete! Google is now listening...', 'color: #00ff00; font-weight: bold; font-size: 14px;');
        this.isSetupComplete = true;
        return;
      }

      // Log any transcripts or debug messages from Google
      if (data.inputTranscription?.text) {
        console.log('%c[You Said]: ' + data.inputTranscription.text, 'color: #ffff00; font-weight: bold;');
      }

      // 2. Audio & text responses
      const parts = data.serverContent?.modelTurn?.parts || [];
      for (const part of parts) {
        if (part.text) {
          console.log('%c[Gemini 3.8 Spoke]: ' + part.text, 'color: #00ffcc; font-weight: bold;');
        }
        if (part.inlineData && part.inlineData.data) {
          this.onMessage?.({ type: 'response.created' });
          this.playAudioChunk(part.inlineData.data);
        }
      }

      // 3. Function/Tool Execution (e.g., fly_to_location, change_style)
      if (data.toolCall) {
        for (const call of data.toolCall.functionCalls || []) {
          console.log('%c[Gemini 3.8 Live Executing Tool]: ' + call.name, 'color: #ff00ff; font-weight: bold;', call.args);
          this.onMessage?.({
            type: 'response.function_call_arguments.done',
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.args || {}),
          });
        }
      }

      if (data.serverContent?.turnComplete) {
        this.onMessage?.({ type: 'response.done', response: { status: 'completed' } });
      }
    } catch (err) {
      console.error('[Gemini Live Error parsing message]:', err);
    }
  }

  playAudioChunk(base64Data) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!this.playbackContext) {
      this.playbackContext = new AudioContext({ sampleRate: 24000 });
      this.nextPlayTime = this.playbackContext.currentTime;
    }
    if (this.playbackContext.state === 'suspended') {
      this.playbackContext.resume().catch(() => {});
    }

    const binaryString = atob(base64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768;
    }

    const audioBuffer = this.playbackContext.createBuffer(1, float32.length, 24000);
    audioBuffer.getChannelData(0).set(float32);

    const source = this.playbackContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.playbackContext.destination);

    const startTime = Math.max(this.playbackContext.currentTime, this.nextPlayTime);
    source.start(startTime);
    this.nextPlayTime = startTime + audioBuffer.duration;
  }

  sendToolResponse(callId, result) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      toolResponse: {
        functionResponses: [{
          id: callId,
          response: { output: result },
        }],
      },
    }));
  }

  close() {
    this.stopAudioCapture();
    if (this.playbackContext) {
      this.playbackContext.close().catch(() => {});
      this.playbackContext = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}