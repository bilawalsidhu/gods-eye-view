import { getLocale } from '../i18n/index.js';

/**
 * Text-to-Speech (TTS / YYS 語音合成) client module.
 * Provides browser Web Speech API synthesis with native zh-TW/en support
 * and server-side fallback to /api/tts.
 */

let currentAudio = null;

/**
 * Speak the given text using browser SpeechSynthesis or /api/tts.
 * @param {string} text - Text to speak.
 * @param {object} [options]
 * @param {string} [options.lang] - BCP 47 language code (defaults to current locale).
 * @param {number} [options.rate=1.0] - Speech rate.
 * @param {number} [options.pitch=1.0] - Speech pitch.
 * @returns {Promise<boolean>} True if playback initiated.
 */
export async function speakText(
  text,
  { lang = null, rate = 1.0, pitch = 1.0 } = {},
) {
  const content = String(text || '').trim();
  if (!content) return false;

  stopSpeech();

  const activeLocale = lang || getLocale();
  const targetLang = activeLocale === 'zh-TW' ? 'zh-TW' : 'en-US';

  // 1. Try browser Web Speech API first (instant, free, authentic local voice)
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      const utterance = new SpeechSynthesisUtterance(content);
      utterance.lang = targetLang;
      utterance.rate = rate;
      utterance.pitch = pitch;

      const voices = window.speechSynthesis.getVoices();
      const matchingVoice = voices.find(
        (v) =>
          v.lang.toLowerCase().includes(targetLang.toLowerCase()) ||
          (targetLang.startsWith('zh') && v.lang.toLowerCase().includes('zh')),
      );
      if (matchingVoice) utterance.voice = matchingVoice;

      window.speechSynthesis.speak(utterance);
      return true;
    } catch (err) {
      console.warn('[TTS] Web Speech API failed, trying server fallback:', err);
    }
  }

  // 2. Server-side /api/tts fallback (OpenAI TTS / Custom TTS Base URL)
  if (typeof fetch !== 'undefined') {
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: content }),
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        currentAudio = audio;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          if (currentAudio === audio) currentAudio = null;
        };
        await audio.play();
        return true;
      }
    } catch (err) {
      console.warn('[TTS] Server /api/tts request failed:', err);
    }
  }

  return false;
}

/** Stop any currently active speech synthesis or audio playback. */
export function stopSpeech() {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }
  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    } catch {
      // ignore
    }
    currentAudio = null;
  }
}

/** Check if speech synthesis is supported in this environment. */
export function isSpeechSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}
