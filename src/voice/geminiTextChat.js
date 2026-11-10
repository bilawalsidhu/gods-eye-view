import { createTextChat } from './textChat.js';

export function createGeminiTextChat(options) {
  return createTextChat({ ...options, provider: 'gemini' });
}
