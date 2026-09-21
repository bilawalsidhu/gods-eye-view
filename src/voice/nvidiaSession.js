/**
 * JARVIS Voice & Globe Command Session Adapter powered by NVIDIA NIM free models.
 * Uses browser Web Speech API for recognition and SpeechSynthesis for voice feedback,
 * orchestrating tool execution via NVIDIA NIM chat completions.
 *
 * Enhanced features:
 * - Mode switching via voice ("switch to code mode", "research mode")
 * - Wake word detection ("hey jarvis", "jarvis")
 * - Smart voice synthesis with voice selection
 * - Tool execution feedback via speech
 */

const MODE_KEYWORDS = {
  'code mode': 'code',
  'coding mode': 'code',
  code: 'code',
  'chat mode': 'general',
  'general mode': 'general',
  chat: 'general',
  'study mode': 'study',
  study: 'study',
  'research mode': 'research',
  research: 'research',
  'task mode': 'tasks',
  'tasks mode': 'tasks',
  tasks: 'tasks',
  'auto mode': 'auto',
  'automation mode': 'auto',
  automate: 'auto',
  'globe mode': 'globe',
  globe: 'globe',
  'memory mode': 'memory',
  memory: 'memory',
};

const WAKE_WORDS = ['hey jarvis', 'jarvis', 'hey j.a.r.v.i.s'];

export function createNvidiaSession({
  emit,
  runAction,
  ui = null,
  dataManager = null,
  signal = null,
} = {}) {
  let active = false;
  let recognition = null;
  let spaceKeyHeld = false;
  let isProcessing = false;
  let currentMode = 'general';
  let wakeWordActive = false;
  const conversationHistory = [];

  const SpeechRecognition =
    typeof window !== 'undefined'
      ? window.SpeechRecognition || window.webkitSpeechRecognition
      : null;

  /** Select a good voice for JARVIS with language awareness */
  function getJarvisVoice(text = '') {
    if (typeof window === 'undefined' || !window.speechSynthesis) return null;
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;

    // Detect language
    let targetLang = 'en';
    if (/[\u0900-\u097F]/.test(text)) targetLang = 'hi';
    else if (/[\u3040-\u30FF]/.test(text)) targetLang = 'ja';
    else if (/[\u4E00-\u9FFF]/.test(text)) targetLang = 'zh';
    else if (/[\u0400-\u04FF]/.test(text)) targetLang = 'ru';

    if (targetLang !== 'en') {
      const match = voices.find((v) => v.lang.startsWith(targetLang));
      if (match) return match;
    }

    let voiceModel = 'jarvis';
    try {
      const raw = localStorage.getItem('gev_jarvis_voice_settings');
      if (raw) voiceModel = JSON.parse(raw).voiceModel || 'jarvis';
    } catch {}

    if (voiceModel === 'friday' || voiceModel === 'sophia') {
      const femalePreferred = voices.find(
        (v) =>
          v.name.includes('Google UK English Female') ||
          v.name.includes('Microsoft Hazel') ||
          v.name.includes('Microsoft Susan') ||
          v.name.includes('Moira') ||
          v.name.includes('Samantha') ||
          (v.lang.startsWith('en') &&
            /female|woman|girl|aria|jenny/i.test(v.name)),
      );
      if (femalePreferred) return femalePreferred;
    }

    // Prefer a clear, authoritative English voice
    const preferred = voices.find(
      (v) =>
        v.name.includes('Google UK English Male') ||
        v.name.includes('Microsoft George') ||
        v.name.includes('Microsoft Ryan') ||
        v.name.includes('Microsoft David') ||
        v.name.includes('Daniel') ||
        v.name.includes('Arthur') ||
        (v.lang.startsWith('en') &&
          v.name.toLowerCase().includes('natural') &&
          v.name.toLowerCase().includes('male')) ||
        (v.lang.startsWith('en') && v.name.toLowerCase().includes('male')),
    );
    return (
      preferred || voices.find((v) => v.lang.startsWith('en')) || voices[0]
    );
  }

  function speakText(text) {
    if (typeof window === 'undefined' || !window.speechSynthesis || !text)
      return;
    try {
      window.speechSynthesis.cancel();
      // Clean up markdown and code from speech
      const cleanText = text
        .replace(/```[\s\S]*?```/g, 'Code block omitted.')
        .replace(/`[^`]+`/g, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/#{1,6}\s/g, '')
        .replace(/https?:\/\/\S+/g, 'link')
        .slice(0, 350); // Limit speech length

      const utterance = new SpeechSynthesisUtterance(cleanText);
      utterance.rate = 1.08;
      utterance.pitch = 0.95;
      utterance.volume = 0.9;
      const voice = getJarvisVoice(cleanText);
      if (voice) utterance.voice = voice;
      window.speechSynthesis.speak(utterance);
    } catch {
      /* Speech synthesis failure should not interrupt session */
    }
  }

  /** Check if text contains a mode switch command */
  function checkModeSwitch(text) {
    const lower = text.toLowerCase().trim();
    for (const [keyword, mode] of Object.entries(MODE_KEYWORDS)) {
      if (lower.includes(`switch to ${keyword}`) || lower === keyword) {
        return mode;
      }
    }
    return null;
  }

  /** Check for wake word in transcript */
  function checkWakeWord(text) {
    const lower = text.toLowerCase().trim();
    return WAKE_WORDS.some((w) => lower.startsWith(w));
  }

  /** Strip wake word from command */
  function stripWakeWord(text) {
    let lower = text.toLowerCase().trim();
    for (const w of WAKE_WORDS) {
      if (lower.startsWith(w)) {
        return text
          .slice(w.length)
          .trim()
          .replace(/^[,.\s]+/, '');
      }
    }
    return text;
  }

  async function processCommand(text) {
    if (!text || !text.trim() || isProcessing) return;

    // Check for wake word
    const hasWakeWord = checkWakeWord(text);
    if (hasWakeWord) {
      text = stripWakeWord(text);
      if (!text) {
        speakText("Yes? I'm listening.");
        emit({
          type: 'state',
          state: 'listening',
          detail: 'Awaiting command...',
        });
        return;
      }
    }

    // Check for mode switch
    const newMode = checkModeSwitch(text);
    if (newMode && newMode !== currentMode) {
      currentMode = newMode;
      const modeName = newMode.toUpperCase();
      speakText(`Switching to ${modeName} mode.`);
      emit({ type: 'state', state: 'listening', detail: `Mode: ${modeName}` });
      // Notify the AI Command Center UI if available
      if (typeof window !== 'undefined' && window.__gevAiCommandCenter) {
        window.__gevAiCommandCenter.setMode(newMode);
      }
      return;
    }

    isProcessing = true;
    emit({ type: 'state', state: 'executing', detail: `JARVIS: "${text}"` });
    emit({ type: 'transcript', speaker: 'user', text, isFinal: true });

    try {
      // Gather current viewer/entity context if available
      let context = null;
      try {
        if (dataManager?.contextStore) {
          context = dataManager.contextStore.getSnapshot?.() || null;
        }
      } catch {
        /* context is optional */
      }

      // Route to the appropriate endpoint based on mode
      const endpoint =
        currentMode === 'globe' ? '/api/nvidia/chat' : '/api/nvidia/assistant';
      const body =
        currentMode === 'globe'
          ? {
              messages: [
                ...conversationHistory.slice(-6),
                { role: 'user', content: text },
              ],
              context,
            }
          : {
              messages: [
                ...conversationHistory.slice(-6),
                { role: 'user', content: text },
              ],
              mode: currentMode,
              model: 'council',
              context,
              webSearch: currentMode === 'research',
              stream: false,
            };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(
          errData.error || `JARVIS request failed (HTTP ${response.status})`,
        );
      }

      const data = await response.json();
      const assistantMessage = data?.message || {};
      const toolCalls = assistantMessage.tool_calls || [];
      const content = assistantMessage.content || '';
      const toolExecutions = data.toolExecutions || [];

      conversationHistory.push({ role: 'user', content: text });
      conversationHistory.push({ role: 'assistant', content });

      // Execute globe tool calls
      if (currentMode === 'globe') {
        const executedResults = [];
        for (const call of toolCalls) {
          const toolName = call.function?.name;
          let args = {};
          try {
            args = JSON.parse(call.function?.arguments || '{}');
          } catch {
            args = {};
          }
          if (toolName) {
            emit({
              type: 'state',
              state: 'executing',
              detail: `Running ${toolName}...`,
            });
            try {
              const result = await runAction(toolName, args);
              executedResults.push({ name: toolName, ok: true, result });
            } catch (actionErr) {
              executedResults.push({
                name: toolName,
                ok: false,
                error: actionErr.message,
              });
            }
          }
        }

        let spokenReply = content;
        if (!spokenReply && executedResults.length > 0) {
          const successes = executedResults.filter((r) => r.ok);
          spokenReply =
            successes.length > 0
              ? `Done. ${successes.map((s) => s.name.replace(/_/g, ' ')).join(', ')}`
              : 'Action could not be completed.';
        }

        if (spokenReply) {
          emit({
            type: 'transcript',
            speaker: 'ai',
            text: spokenReply,
            isFinal: true,
          });
          speakText(spokenReply);
          if (
            typeof window !== 'undefined' &&
            window.__gevAiCommandCenter?.appendVoiceExchange
          ) {
            window.__gevAiCommandCenter.appendVoiceExchange(text, spokenReply);
          }
        }
      } else {
        // Non-globe modes — speak the response
        let spokenReply = content;

        // Mention tool executions if reply is brief
        if (toolExecutions.length > 0) {
          const toolNames = [
            ...new Set(toolExecutions.map((t) => t.name?.replace(/_/g, ' '))),
          ];
          if (!spokenReply) {
            spokenReply = `Done. Executed ${toolNames.join(', ')}.`;
          }
        }

        if (spokenReply) {
          emit({
            type: 'transcript',
            speaker: 'ai',
            text: spokenReply,
            isFinal: true,
          });
          speakText(spokenReply);
          if (
            typeof window !== 'undefined' &&
            window.__gevAiCommandCenter?.appendVoiceExchange
          ) {
            window.__gevAiCommandCenter.appendVoiceExchange(text, spokenReply);
          }
        }
      }

      emit({
        type: 'state',
        state: active ? 'listening' : 'idle',
        detail: active
          ? `Listening (${currentMode.toUpperCase()})...`
          : 'Voice off',
      });
    } catch (err) {
      emit({
        type: 'state',
        state: 'error',
        detail: err.message || 'JARVIS execution error',
      });
      speakText('Sorry, I encountered an error.');
    } finally {
      isProcessing = false;
    }
  }

  function startRecognition() {
    if (!SpeechRecognition) {
      emit({
        type: 'state',
        state: 'error',
        detail:
          'SpeechRecognition not supported. Use Chrome/Edge or text commands.',
      });
      return;
    }

    if (recognition) {
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
    }

    try {
      recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        emit({
          type: 'state',
          state: 'listening',
          detail: `JARVIS listening (${currentMode.toUpperCase()})...`,
        });
      };

      recognition.onresult = (event) => {
        let interim = '';
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          } else {
            interim += event.results[i][0].transcript;
          }
        }

        if (interim && !finalTranscript) {
          emit({ type: 'state', state: 'listening', detail: `"${interim}"` });
        }

        if (finalTranscript.trim()) {
          void processCommand(finalTranscript.trim());
        }
      };

      recognition.onerror = (event) => {
        if (event.error === 'no-speech' || event.error === 'aborted') {
          if (active && !isProcessing) {
            emit({
              type: 'state',
              state: 'listening',
              detail: `JARVIS listening (${currentMode.toUpperCase()})...`,
            });
          }
          return;
        }
        emit({
          type: 'state',
          state: 'error',
          detail: `Mic error: ${event.error}`,
        });
      };

      recognition.onend = () => {
        if (active && !isProcessing) {
          try {
            recognition.start();
          } catch {
            /* ignore restart error */
          }
        }
      };

      recognition.start();
    } catch (err) {
      emit({
        type: 'state',
        state: 'error',
        detail: err.message || 'Could not start microphone',
      });
    }
  }

  function stopRecognition() {
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
      recognition = null;
    }
  }

  return {
    capabilities: {
      costControls: false,
      pushToTalk: true,
    },
    async start({ pushToTalk = false } = {}) {
      active = true;
      emit({
        type: 'state',
        state: 'connecting',
        detail: 'Starting JARVIS Voice...',
      });
      speakText('JARVIS online. Ready for commands.');
      startRecognition();
    },
    stop() {
      active = false;
      stopRecognition();
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      emit({ type: 'state', state: 'idle', detail: 'Voice off' });
    },
    sendText(text) {
      void processCommand(text);
    },
    sendMapEvent(event) {
      /* no-op for nvidia chat session */
    },
    ignoreButtonClick() {
      return Boolean(spaceKeyHeld);
    },
    bindControls() {
      if (typeof window === 'undefined') return;

      window.addEventListener('keydown', (event) => {
        if (
          event.code === 'Space' &&
          !spaceKeyHeld &&
          !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)
        ) {
          spaceKeyHeld = true;
          if (!active) {
            active = true;
            startRecognition();
          }
        }
      });

      window.addEventListener('keyup', (event) => {
        if (event.code === 'Space' && spaceKeyHeld) {
          spaceKeyHeld = false;
          if (recognition) {
            try {
              recognition.stop();
            } catch {
              /* ignore */
            }
          }
        }
      });
    },
  };
}
