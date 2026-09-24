/**
 * JARVIS AI Command Center — Universal AI Assistant inside God's Eye View.
 *
 * Provides a persistent tactical panel for:
 * - 💬 Universal AI conversation (free NVIDIA NIM models)
 * - 🌐 Globe control & geospatial tool execution
 * - 💻 Code generation, execution, debugging & iteration
 * - ⚡ Workflow automation — multi-step task execution
 * - 📚 Study mode (flashcards, quizzes, explanations)
 * - ✅ Task & mission management
 * - 🔍 Live web research & reference lookup
 * - 🧠 Persistent memory across conversations
 * - 👁️ Multimodal vision & document analysis
 * - 🎙️ Hands-free voice intercom ("Hey JARVIS" wake-word)
 * - 🛰️ Autonomous drone recon flyover & orbital SITREP commentary
 * - 🎛️ Multi-camera CCTV PiP surveillance grid
 * - 🗺️ Drag-and-drop 3D geospatial map plotting (GeoJSON/KML/CSV)
 * - ⚠️ Real-time geospatial anomaly & threat alert detection
 */

import {
  DroneReconController,
  CctvSurveillanceGrid,
  GeoDataPlotter,
  GeospatialThreatScanner,
} from './tactical/index.js';
import { JARVIS_API, NVIDIA_API } from './apiEndpoints.js';

/** Quick action prompts per mode */
const MODE_PRESETS = {
  globe: [
    'Fly to Tokyo Tower',
    'Show live satellites',
    'Enable CCTV cameras',
    'Traffic in Paris',
  ],
  computer: [
    'Inspect system hardware, CPU & RAM',
    'List top running processes',
    'Take a full desktop screenshot',
    'Open File Explorer',
    'Launch Notepad / Calculator',
    'Check git status and branch',
  ],
  general: [
    'What can you do?',
    'Explain quantum computing simply',
    'Compare React vs Vue vs Svelte',
    'Write a haiku about space',
  ],
  code: [
    '⚡ Auto-Debug & Fix Loop',
    'Write, execute & test a prime checker algorithm',
    'Build REST API in Node.js with validation',
    'Find bugs, memory leaks and optimize code',
  ],
  auto: [
    'Scrape top 10 HackerNews stories and save to file',
    'Research competitors and create a report',
    'Automate: fetch weather → analyze → save report',
    'Build a multi-step data pipeline',
  ],
  study: [
    'Create flashcards on orbital mechanics',
    'Quiz me on European geography',
    'Explain machine learning from scratch',
    'Teach me calculus step by step',
  ],
  tasks: [
    'Plan a satellite recon mission',
    'Create a study roadmap for AI/ML',
    'Break down a startup launch plan',
    'Weekly project planning template',
  ],
  research: [
    'Latest news on space exploration',
    'Compare GPT-4 vs Gemini vs Claude',
    'Wikipedia: International Space Station',
    'Research: best free AI APIs in 2025',
  ],
  memory: [
    'What do you remember about me?',
    'Remember that my favorite language is Python',
    'Forget my old project name',
    'Show all stored memories',
  ],
};

/**
 * Procedural Web Audio Sound Synthesizer — zero external audio assets required.
 * Generates futuristic sci-fi chimes, wake-word pings, tactical alert sirens, and data chirps.
 */
let _sharedCueAudioCtx = null;
function getSharedCueContext(audioContextRef) {
  if (audioContextRef) {
    if (typeof audioContextRef === 'function') {
      try {
        return new audioContextRef();
      } catch {
        return null;
      }
    }
    return audioContextRef;
  }
  if (_sharedCueAudioCtx && _sharedCueAudioCtx.state !== 'closed') {
    if (_sharedCueAudioCtx.state === 'suspended') {
      _sharedCueAudioCtx.resume().catch(() => {});
    }
    return _sharedCueAudioCtx;
  }
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioCtx) return null;
  try {
    _sharedCueAudioCtx = new AudioCtx();
    return _sharedCueAudioCtx;
  } catch {
    return null;
  }
}

export function playAudioCue(type = 'wake', { audioContextRef = null } = {}) {
  try {
    const ctx = getSharedCueContext(audioContextRef);
    if (!ctx || typeof ctx.createOscillator !== 'function') return;
    const now = ctx.currentTime || 0;

    if (type === 'wake') {
      // 2-tone futuristic chime (D5 -> A5)
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();
      osc1.type = 'sine';
      osc2.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now);
      osc2.frequency.setValueAtTime(880.0, now + 0.08);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.1);
      osc2.start(now + 0.08);
      osc2.stop(now + 0.35);
    } else if (type === 'alert') {
      // Tactical red alert ping
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1046.5, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.2);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.4);
    } else if (type === 'recon') {
      // Sci-fi scanner sweep
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(320, now);
      osc.frequency.exponentialRampToValueAtTime(1100, now + 0.25);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.3);
    } else if (type === 'data') {
      // 3-tone uplink chirp
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.setValueAtTime(659.25, now + 0.06);
      osc.frequency.setValueAtTime(783.99, now + 0.12);
      gain.gain.setValueAtTime(0.07, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.25);
    } else if (type === 'comm') {
      // 2-tone tactical radio chirp
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(1318.5, now + 0.04);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.12);
    }
  } catch {}
}

/**
 * AI Voice Personas / Voice Models with customized acoustic properties.
 */
export const VOICE_MODELS = Object.freeze({
  jarvis: {
    id: 'jarvis',
    name: 'JARVIS Classic',
    gender: 'male',
    pitch: 0.92,
    rate: 1.04,
    preferredVoices: [
      'Google UK English Male',
      'Microsoft George',
      'Microsoft Ryan',
      'Daniel',
      'Arthur',
    ],
    description: 'British Tactical Commander (Deep RP Male)',
  },
  friday: {
    id: 'friday',
    name: 'FRIDAY Tactical',
    gender: 'female',
    pitch: 1.08,
    rate: 1.12,
    preferredVoices: [
      'Google UK English Female',
      'Microsoft Hazel',
      'Microsoft Susan',
      'Moira',
      'Samantha',
    ],
    description: 'Crisp Combat OS (Irish/British Female)',
  },
  edith: {
    id: 'edith',
    name: 'EDITH Cybernetic',
    gender: 'neutral',
    pitch: 0.96,
    rate: 0.98,
    preferredVoices: ['Alex', 'Fred', 'Microsoft David', 'Victoria'],
    description: 'Calm High-Precision Tactical Synthetic',
  },
  sophia: {
    id: 'sophia',
    name: 'SOPHIA Neural',
    gender: 'female',
    pitch: 1.0,
    rate: 1.0,
    preferredVoices: [
      'Microsoft Jenny Natural',
      'Microsoft Aria',
      'Google US English',
      'Zira',
    ],
    description: 'Warm Conversational Natural Human',
  },
  titan: {
    id: 'titan',
    name: 'TITAN Strategic',
    gender: 'male',
    pitch: 0.82,
    rate: 0.94,
    preferredVoices: [
      'Microsoft Guy Natural',
      'Microsoft Mark',
      'Tom',
      'Bruce',
    ],
    description: 'Resonant Deep Bass Command Core',
  },
});

/**
 * Detect written language from text script and lexical tokens.
 * Supports Devanagari (Hindi), Japanese, Chinese, Arabic, Cyrillic, Spanish, French, German, Italian, English.
 */
export function detectTextLanguage(text) {
  if (!text || typeof text !== 'string') return 'en-US';
  const trimmed = text.trim();
  // Devanagari script (Hindi, Sanskrit, Marathi, Nepali)
  if (/[\u0900-\u097F]/.test(trimmed)) return 'hi-IN';
  // Japanese Hiragana or Katakana
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(trimmed)) return 'ja-JP';
  // Chinese Han ideographs (excluding kana)
  if (/[\u4E00-\u9FFF]/.test(trimmed)) return 'zh-CN';
  // Arabic
  if (/[\u0600-\u06FF]/.test(trimmed)) return 'ar-SA';
  // Cyrillic (Russian, Ukrainian)
  if (/[\u0400-\u04FF]/.test(trimmed)) return 'ru-RU';
  // Spanish punctuation or typical keywords
  if (
    /[¿¡áéíóúüñ]/i.test(trimmed) ||
    /\b(hola|gracias|buenos|por favor|cómo|estás|amigo|adiós|muchas)\b/i.test(
      trimmed,
    )
  )
    return 'es-ES';
  // French accents or keywords
  if (
    /[àâçéèêëîïôûùüÿœæ]/i.test(trimmed) ||
    /\b(bonjour|merci|s'il vous plaît|oui|non|avec|pourquoi|salut)\b/i.test(
      trimmed,
    )
  )
    return 'fr-FR';
  // German umlauts or keywords
  if (
    /[äöüß]/i.test(trimmed) ||
    /\b(hallo|danke|bitte|guten tag|wie geht|ich bin|tschüss)\b/i.test(trimmed)
  )
    return 'de-DE';
  // Italian keywords
  if (
    /\b(ciao|grazie|buongiorno|per favore|come stai|arrivederci)\b/i.test(
      trimmed,
    )
  )
    return 'it-IT';
  // Portuguese
  if (
    /[ãõç]/i.test(trimmed) ||
    /\b(olá|obrigado|bom dia|por favor)\b/i.test(trimmed)
  )
    return 'pt-BR';
  return 'en-US';
}

/**
 * Select the highest-quality browser TTS voice matching target language and voice persona model.
 * Prioritizes Microsoft Online / Natural, Google, Apple Neural voices matching persona timbre.
 */
export function selectBestVoice(
  voices,
  targetLang,
  preferredVoiceName = '',
  voiceModelId = '',
) {
  if (!voices || voices.length === 0) return null;
  if (preferredVoiceName) {
    const matched = voices.find((v) => v.name === preferredVoiceName);
    if (matched) return matched;
  }

  const primaryLang = (targetLang || 'en').split('-')[0].toLowerCase();
  const modelProfile = voiceModelId ? VOICE_MODELS[voiceModelId] : null;

  // 1. Look for matching language with Neural / Natural / Online / Google in name
  const naturalVoices = voices.filter(
    (v) =>
      v.lang.toLowerCase().startsWith(primaryLang) &&
      /natural|neural|online|google|siri|premium/i.test(v.name),
  );

  if (naturalVoices.length > 0) {
    if (modelProfile?.preferredVoices) {
      for (const pref of modelProfile.preferredVoices) {
        const match = naturalVoices.find((v) => v.name.includes(pref));
        if (match) return match;
      }
    }
    if (modelProfile?.gender === 'female') {
      const fem = naturalVoices.find((v) =>
        /female|woman|girl|aria|jenny|hazel|susan|moira|samantha/i.test(v.name),
      );
      if (fem) return fem;
    } else if (modelProfile?.gender === 'male') {
      const male = naturalVoices.find((v) =>
        /male|man|boy|guy|george|ryan|daniel|david|mark|tom|bruce/i.test(
          v.name,
        ),
      );
      if (male) return male;
    }
    return naturalVoices[0];
  }

  // 2. Look for persona preferred voice from all voices
  if (modelProfile?.preferredVoices) {
    for (const pref of modelProfile.preferredVoices) {
      const match = voices.find(
        (v) =>
          v.lang.toLowerCase().startsWith(primaryLang) && v.name.includes(pref),
      );
      if (match) return match;
    }
  }

  // 3. Look for exact locale match (e.g. hi-IN or en-US)
  const exact = voices.find(
    (v) => v.lang.toLowerCase() === targetLang.toLowerCase(),
  );
  if (exact) return exact;

  // 4. Look for primary language prefix match
  const langMatch = voices.find((v) =>
    v.lang.toLowerCase().startsWith(primaryLang),
  );
  if (langMatch) return langMatch;

  // 5. Default fallback to any voice
  return voices[0] || null;
}

/**
 * Extracts and cleans thinking/reasoning traces from model outputs.
 * Supports <think>...</think>, ```thought...```, and leading reasoning blocks.
 */
export function extractThinking(text) {
  if (!text) return { content: '', reasoning: '' };
  let cleaned = String(text);
  let reasoning = '';

  // 1. Closed <think>...</think>, <thought>...</thought>, or <reasoning>...</reasoning>
  const thinkRegex =
    /<(?:think|thought|reasoning)>([\s\S]*?)<\/(?:think|thought|reasoning)>/gi;
  let match;
  while ((match = thinkRegex.exec(cleaned)) !== null) {
    reasoning = (reasoning ? reasoning + '\n\n' : '') + match[1].trim();
  }
  cleaned = cleaned.replace(thinkRegex, '').trim();

  // 2. Unclosed <think>, <thought>, <reasoning> during active streaming
  const unclosedThink = /<(?:think|thought|reasoning)>([\s\S]*)$/i;
  const unclosedMatch = unclosedThink.exec(cleaned);
  if (unclosedMatch) {
    reasoning = (reasoning ? reasoning + '\n\n' : '') + unclosedMatch[1].trim();
    cleaned = cleaned.replace(unclosedThink, '').trim();
  }

  // 3. Fenced thought blocks ```thought ... ```
  const thoughtBlock = /```(?:thought|thinking)\n?([\s\S]*?)```/gi;
  let tbMatch;
  while ((tbMatch = thoughtBlock.exec(cleaned)) !== null) {
    reasoning = (reasoning ? reasoning + '\n\n' : '') + tbMatch[1].trim();
  }
  cleaned = cleaned.replace(thoughtBlock, '').trim();

  // 4. "Here's a thinking process: ..."
  if (cleaned.startsWith("Here's a thinking process:")) {
    const parts = cleaned.split(/\n\n(?=[A-Z#*])/);
    if (parts.length > 1) {
      reasoning = (reasoning ? reasoning + '\n\n' : '') + parts[0].trim();
      cleaned = parts.slice(1).join('\n\n').trim();
    }
  }

  return { content: cleaned, reasoning };
}

/**
 * Format markdown-like text to HTML safely with code highlighting, tables, and structured styling.
 */
export function formatMarkdown(text, { hideThinking = true } = {}) {
  if (!text) return '';
  let src = String(text);
  if (hideThinking) {
    const extracted = extractThinking(src);
    src = extracted.content;
  }
  if (!src) return '';

  let escaped = src
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks: ```lang ... ``` → syntax highlighted with Run, Debug, Copy buttons
  escaped = escaped.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const langLabel = lang || 'javascript';
    return `<div class="ai-code-block"><div class="ai-code-header"><span class="ai-code-lang">${langLabel}</span><div class="ai-code-actions"><button type="button" class="ai-code-btn ai-run-btn" title="Run code in sandbox">▶ Run</button><button type="button" class="ai-code-btn ai-debug-btn" title="Autonomous debug loop">⚡ Auto-Debug</button><button type="button" class="ai-code-btn ai-copy-btn" onclick="navigator.clipboard.writeText(this.closest('.ai-code-block').querySelector('code').textContent).then(()=>{this.textContent='✓ Copied';setTimeout(()=>this.textContent='Copy',1500)})">Copy</button></div></div><pre><code class="language-${langLabel}">${code.trim()}</code></pre></div>`;
  });

  // Markdown tables
  escaped = escaped.replace(/((?:\|[^\n]+\|\n?)+)/g, (tableMatch) => {
    const rows = tableMatch.trim().split('\n').filter(Boolean);
    if (rows.length < 2) return tableMatch;
    let tableHtml = '<div class="ai-table-wrapper"><table class="ai-table">';
    rows.forEach((row, i) => {
      if (i === 1 && /^\s*\|?\s*[-:]+[-| :]*\s*\|?\s*$/.test(row)) return;
      const cols = row
        .split('|')
        .map((c) => c.trim())
        .slice(1, -1);
      const tag = i === 0 ? 'th' : 'td';
      tableHtml +=
        '<tr>' + cols.map((c) => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
    });
    tableHtml += '</table></div>';
    return tableHtml;
  });

  // Inline code: `...`
  escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold: **...**
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italics: *...*
  escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Headers: ### ...
  escaped = escaped.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  escaped = escaped.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  escaped = escaped.replace(/^# (.+)$/gm, '<h2>$1</h2>');

  // Bullet points
  escaped = escaped.replace(/^\s*[-*]\s+(.*)$/gm, '<li>$1</li>');
  escaped = escaped.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

  // Numbered lists
  escaped = escaped.replace(/^\s*\d+\.\s+(.*)$/gm, '<li>$1</li>');

  // Line breaks to paragraphs
  return escaped
    .split(/\n\n+/)
    .map((p) =>
      p.startsWith('<pre>') ||
      p.startsWith('<ul>') ||
      p.startsWith('<div') ||
      p.startsWith('<h')
        ? p
        : `<p>${p.replace(/\n/g, '<br/>')}</p>`,
    )
    .join('');
}

/**
 * Format tool execution results into displayable HTML.
 */
function formatToolExecution(exec) {
  const name = exec.name || 'unknown';
  const status = exec.result?.error ? '❌' : '✅';
  let detail = '';

  if (name === 'system_command' || name === 'execute_system_command') {
    const r = exec.result || {};
    const exitBadge = r.exitCode === 0 ? '✅ exit 0' : `❌ exit ${r.exitCode}`;
    detail = `<div class="ai-tool-result">
      <div class="ai-tool-result-header">🖥️ Host Shell: ${exitBadge} · ${r.duration || 0}ms · in <code>${r.cwd || '.'}</code></div>
      ${r.stdout ? `<div class="ai-code-block"><div class="ai-code-header"><span class="ai-code-lang">stdout</span></div><pre><code>${r.stdout.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></pre></div>` : ''}
      ${r.stderr ? `<div class="ai-code-block ai-stderr"><div class="ai-code-header"><span class="ai-code-lang">stderr</span></div><pre><code>${r.stderr.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></pre></div>` : ''}
    </div>`;
  } else if (name === 'take_screenshot') {
    const r = exec.result || {};
    detail = `<div class="ai-tool-result">
      <div>📸 <strong>Desktop Screenshot Captured:</strong> <a href="${r.url}" target="_blank">${r.filename || 'screenshot.png'}</a> (${((r.sizeBytes || 0) / 1024).toFixed(0)} KB)</div>
      ${r.url ? `<div class="ai-screenshot-preview"><img src="${r.url}" alt="Screenshot" style="max-width:100%; border-radius:6px; border:1px solid rgba(0, 212, 255, 0.35); margin-top:6px;" /></div>` : ''}
    </div>`;
  } else if (name === 'list_processes') {
    const r = exec.result || {};
    const procs = r.processes || [];
    const rows = procs
      .slice(0, 10)
      .map(
        (p) =>
          `<tr><td>${p.pid}</td><td>${p.name}</td><td>${p.memoryMB} MB</td><td>${p.cpuSeconds}s</td></tr>`,
      )
      .join('');
    detail = `<div class="ai-tool-result">
      <table class="ai-proc-table">
        <thead><tr><th>PID</th><th>Process</th><th>Memory</th><th>CPU</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  } else if (name === 'system_info' || name === 'get_system_info') {
    const r = exec.result || {};
    detail = `<div class="ai-tool-result">
      <div>🖥️ <strong>${r.platform}</strong> (${r.arch}) · CPU: ${r.cpu?.cores} Cores · RAM: ${r.memory?.usedPercent}% used (${r.memory?.usedFormatted} / ${r.memory?.totalFormatted}) · Uptime: ${r.uptimeFormatted || '0m'}</div>
    </div>`;
  } else if (name === 'open_app_or_file' || name === 'open_app') {
    const r = exec.result || {};
    detail = `<div class="ai-tool-result">🚀 ${r.message || r.output || (r.success ? `Opened ${r.opened || 'target'}` : 'Failed to launch target')}</div>`;
  } else if (name === 'get_clipboard' || name === 'set_clipboard') {
    const r = exec.result || {};
    detail = `<div class="ai-tool-result">📋 Clipboard ${r.text !== undefined ? `content: <code>${(r.text || '').slice(0, 150)}</code>` : 'updated'}</div>`;
  } else if (name === 'execute_code' || name === 'debug_code') {
    const r = exec.result || {};
    const exitBadge = r.exitCode === 0 ? '✅ exit 0' : `❌ exit ${r.exitCode}`;
    detail = `<div class="ai-tool-result">
      <div class="ai-tool-result-header">${exitBadge} · ${r.duration || 0}ms${r.killed ? ' (TIMEOUT)' : ''}</div>
      ${r.stdout ? `<div class="ai-code-block"><div class="ai-code-header"><span class="ai-code-lang">stdout</span></div><pre><code>${r.stdout.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></pre></div>` : ''}
      ${r.stderr ? `<div class="ai-code-block ai-stderr"><div class="ai-code-header"><span class="ai-code-lang">stderr</span></div><pre><code>${r.stderr.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></pre></div>` : ''}
      ${r.errorAnalysis ? `<div class="ai-error-analysis"><div class="ai-error-title">🔍 Error Analysis</div><div class="ai-error-type">${r.errorAnalysis.primaryError || ''}</div>${r.errorAnalysis.suggestion ? `<div class="ai-error-sugg">💡 ${r.errorAnalysis.suggestion}</div>` : ''}</div>` : ''}
    </div>`;
  } else if (name === 'scrape_url') {
    const r = exec.result || {};
    detail = r.error
      ? `<span class="ai-tool-error">${r.error}</span>`
      : `<div class="ai-tool-result">Fetched ${(r.content || '').length} chars from ${r.url}</div>`;
  } else if (name === 'calculate') {
    const r = exec.result || {};
    detail = `<div class="ai-tool-result"><strong>${r.expression}</strong> = <code>${r.result}</code></div>`;
  } else if (name === 'remember' || name === 'recall' || name === 'forget') {
    detail = `<div class="ai-tool-result"><code>${JSON.stringify(exec.result, null, 2).replace(/</g, '&lt;')}</code></div>`;
  } else if (
    name === 'write_file' ||
    name === 'read_file' ||
    name === 'list_files' ||
    name === 'read_system_file' ||
    name === 'write_system_file' ||
    name === 'list_system_directory'
  ) {
    const r = exec.result || {};
    detail = `<div class="ai-tool-result"><code>${JSON.stringify(r, null, 2).replace(/</g, '&lt;').slice(0, 500)}</code></div>`;
  } else {
    detail = `<div class="ai-tool-result"><code>${JSON.stringify(exec.result).replace(/</g, '&lt;').slice(0, 300)}</code></div>`;
  }

  const argsStr = JSON.stringify(exec.args || {}).slice(0, 120);
  return `<details class="ai-tool-exec">
    <summary>${status} <strong>${name}</strong> <span class="ai-tool-iter">iter ${exec.iteration || 1}</span> <span class="ai-tool-args">${argsStr}</span></summary>
    ${detail}
  </details>`;
}

/**
 * Detect whether a user prompt represents a God's Eye View 3D Globe action,
 * navigation command, geospatial layer toggle, or tactical camera maneuver.
 */
export function isGlobePrompt(text) {
  if (!text || typeof text !== 'string') return false;
  const p = text.trim().toLowerCase();
  if (!p) return false;

  // Direct camera / flight commands
  if (
    /\b(?:fly|flight|take me|navigate|head|travel|pan|zoom|tilt|orbit|rotate|look at|show me|go to)\b/i.test(
      p,
    )
  ) {
    return true;
  }

  // Common geospatial entities
  if (
    /\b(?:satellite|satellites|aircraft|airplane|flight|flights|ads-b|plane|planes|vessel|vessels|ship|ships|ais|marine|maritime)\b/i.test(
      p,
    )
  ) {
    return true;
  }

  // Globe environment, lighting & visual parameters
  if (
    /\b(?:globe|earth|map|terrain|coordinates|elevation|latitude|longitude|standoff|heading|pitch|roll|time of day|daylight|night mode|night vision|sunlight|solar)\b/i.test(
      p,
    )
  ) {
    return true;
  }

  // Layer toggles & sensors
  if (
    /\b(?:borders|country borders|weather layer|clouds|osm|buildings|radar|transponder|squawk|tactical grid|hud summary)\b/i.test(
      p,
    )
  ) {
    return true;
  }

  // Tactical operations
  if (
    /\b(?:target lock|lock target|lock onto|track flight|track vessel|dossier|sitrep|measure distance)\b/i.test(
      p,
    )
  ) {
    return true;
  }

  // Notable cities and world landmarks frequently queried on the 3D globe
  if (
    /\b(?:tokyo|paris|london|austin|nyc|new york|san francisco|dubai|dc|washington|hawaii|fuji|eiffel|tower|kremlin|pentagon|taj mahal|colosseum|sydney|beijing|cairo|rome|berlin)\b/i.test(
      p,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Initialize JARVIS AI Command Center inside the DOM.
 */
export function initAiCommandCenter({
  containerId = 'ai-command-panel',
  documentRef = globalThis.document,
  getGlobeContext = () => null,
  executeGlobeAction = async () => null,
} = {}) {
  const panel = documentRef?.getElementById(containerId);
  if (!panel) return null;

  if (panel._aiCommandController) {
    panel._aiCommandController.updateGlobeCallbacks?.({
      getGlobeContext,
      executeGlobeAction,
    });
    return panel._aiCommandController;
  }

  let globeContextFn = getGlobeContext;
  let globeActionFn = executeGlobeAction;
  let currentMode = 'general';
  const messages = [];
  const attachedFiles = [];
  let isStreaming = false;
  let currentAbortController = null;
  let useStreaming = true;
  let currentSessionId = `session_${Date.now()}`;

  // Local storage keys
  const STORAGE_TASKS_KEY = 'gev_ai_tasks';
  const STORAGE_SESSION_KEY = 'gev_jarvis_session';
  const STORAGE_VOICE_KEY = 'gev_jarvis_voice_settings';

  // Voice and Persona state
  let voiceSettings = {
    lang: 'auto',
    preferredVoice: '',
    voiceModel: 'jarvis',
    rate: 1.04,
    pitch: 0.92,
    micLang: 'en-US',
  };
  try {
    const savedVoice = localStorage.getItem(STORAGE_VOICE_KEY);
    if (savedVoice) Object.assign(voiceSettings, JSON.parse(savedVoice));
  } catch {}

  function saveVoiceSettings() {
    try {
      localStorage.setItem(STORAGE_VOICE_KEY, JSON.stringify(voiceSettings));
    } catch {}
  }

  let currentPersona = 'jarvis';
  let currentTemperature = 0.6;

  // Elements
  const header = panel.querySelector('.ai-panel-header');
  const collapseBtn = panel.querySelector('.panel-collapse-btn');
  const modelBadge = panel.querySelector('.ai-active-model-badge');
  const tabs = panel.querySelectorAll('.ai-mode-tab');
  const messagesContainer = panel.querySelector('.ai-chat-messages');
  const quickPromptsContainer = panel.querySelector('.ai-quick-prompts');
  const inputEl = panel.querySelector('.ai-chat-input');
  const sendBtn = panel.querySelector('.ai-send-btn');
  const micBtn = panel.querySelector('.ai-mic-btn');
  const imageAttachBtn = panel.querySelector('.ai-img-attach-btn');
  const fileInput = panel.querySelector('.ai-file-input');
  const previewBar = panel.querySelector('.ai-image-preview-bar');
  const toolStatusEl = panel.querySelector('.ai-tool-status');
  const toolStatusText = panel.querySelector('.ai-tool-status-text');
  const toolLogEl = panel.querySelector('.ai-tool-log');
  const clearBtn = panel.querySelector('.ai-clear-btn');
  const historyBtn = panel.querySelector('.ai-history-btn');
  const fullscreenBtn = panel.querySelector('.ai-fullscreen-btn');
  const phoneBtn = panel.querySelector('.ai-phone-btn');
  const deviceModal = panel.querySelector('.ai-device-modal');
  const deviceCloseBtn = panel.querySelector('.ai-device-close-btn');
  const deviceQrBox = panel.querySelector('#ai-device-qr');
  const deviceUrlInput = panel.querySelector('.ai-device-url-input');
  const deviceCopyBtn = panel.querySelector('.ai-device-copy-btn');
  const cameraBtn = panel.querySelector('.ai-camera-btn');
  const cameraInput = panel.querySelector('.ai-camera-input');
  const historyDrawer = panel.querySelector('.ai-history-drawer');
  const historyList = panel.querySelector('.ai-history-list');
  const historyCloseBtn = panel.querySelector('.ai-history-close-btn');
  const historyNewBtn = panel.querySelector('.ai-history-new-btn');
  const historyBackBtn = panel.querySelector('.ai-history-back-btn');
  const historySearchInput = panel.querySelector('.ai-history-search-input');
  const streamToggle = panel.querySelector('.ai-stream-toggle');
  const voiceToggleBtn = panel.querySelector('.ai-voice-toggle-btn');
  const voiceSettingsBtn = panel.querySelector('.ai-voice-settings-btn');
  const voiceModal = panel.querySelector('.ai-voice-modal');
  const voiceModalCloseBtn = panel.querySelector('.ai-voice-modal-close-btn');
  const voiceLangSelect = panel.querySelector('#ai-voice-lang-select');
  const voiceModelSelect = panel.querySelector('#ai-voice-model-select');
  const voicePickerSelect = panel.querySelector('#ai-voice-picker-select');
  const voiceRateSlider = panel.querySelector('#ai-voice-rate');
  const voiceRateVal = panel.querySelector('#ai-voice-rate-val');
  const voicePitchSlider = panel.querySelector('#ai-voice-pitch');
  const voicePitchVal = panel.querySelector('#ai-voice-pitch-val');
  const micLangSelect = panel.querySelector('#ai-mic-lang-select');
  const voiceTestBtn = panel.querySelector('#ai-voice-test-btn');
  const voiceStopBtn = panel.querySelector('#ai-voice-stop-btn');
  const personaSelect = panel.querySelector('#ai-persona-select');
  const tempSlider = panel.querySelector('.ai-temp-slider');
  const tempVal = panel.querySelector('.ai-temp-val');
  const unlockBtn = panel.querySelector('.ai-unlock-btn');
  const exportBtn = panel.querySelector('.ai-export-btn');
  const modelDrawer = panel.querySelector('.ai-model-drawer');
  const modelCloseBtn = panel.querySelector('.ai-model-close-btn');
  const modelOpts = panel.querySelectorAll('.ai-model-opt');
  const quickModelBtns = panel.querySelectorAll('.ai-quick-model-btn');
  const latencyDisplay = panel.querySelector('.ai-latency-display');
  const memoryCountDisplay = panel.querySelector('.ai-memory-count-display');
  const telemetryChip = panel.querySelector('.ai-system-telemetry-chip');
  const telemetryText = panel.querySelector('.ai-telemetry-text');
  const systemDrawer = panel.querySelector('.ai-system-drawer');
  const systemCloseBtn = panel.querySelector('.ai-system-close-btn');

  // GenAI Image Generation Drawer
  const genaiDrawer = panel.querySelector('.ai-genai-drawer');
  const genaiBackBtn = panel.querySelector('.ai-genai-back-btn');
  const genaiCloseBtn = panel.querySelector('.ai-genai-close-btn');
  const genaiGenerateBtn = panel.querySelector('#ai-genai-generate-btn');
  const genaiModelSelect = panel.querySelector('#ai-genai-model-select');
  const genaiAspectSelect = panel.querySelector('#ai-genai-aspect-select');
  const genaiPromptInput = panel.querySelector('#ai-genai-prompt');
  const genaiNegativePromptInput = panel.querySelector(
    '#ai-genai-negative-prompt',
  );
  const genaiGallery = panel.querySelector('#ai-genai-gallery');
  const genaiBtn = panel.querySelector('#ai-genai-btn');

  // Navigation & In-Chat Search DOM Elements
  const breadcrumb = panel.querySelector('.ai-nav-breadcrumb');
  const viewTabs = panel.querySelectorAll('.ai-view-tab');
  const searchToggleBtn = panel.querySelector('.ai-search-toggle-btn');
  const searchBar = panel.querySelector('.ai-search-bar');
  const searchInput = panel.querySelector('.ai-search-input');
  const searchCount = panel.querySelector('.ai-search-count');
  const searchPrevBtn = panel.querySelector('.ai-search-prev-btn');
  const searchNextBtn = panel.querySelector('.ai-search-next-btn');
  const searchCloseBtn = panel.querySelector('.ai-search-close-btn');
  const scrollNavigator = panel.querySelector('.ai-scroll-navigator');
  const scrollTopBtn = panel.querySelector('.ai-scroll-top-btn');
  const scrollBottomBtn = panel.querySelector('.ai-scroll-bottom-btn');
  const scrollUnreadBadge = panel.querySelector('.ai-scroll-unread-badge');
  const modeScrollLeft = panel.querySelector('.ai-mode-scroll-left');
  const modeScrollRight = panel.querySelector('.ai-mode-scroll-right');
  const modeTabsContainer = panel.querySelector('.ai-mode-tabs');
  const modelScrollLeft = panel.querySelector('.ai-model-scroll-left');
  const modelScrollRight = panel.querySelector('.ai-model-scroll-right');
  const modelQuickScroll = panel.querySelector('.ai-model-quick-scroll');
  const closeBtn = panel.querySelector('.ai-close-btn');
  const collapsedHint = panel.querySelector('.ai-collapsed-hint');
  const drawerBackBtns = panel.querySelectorAll('.ai-drawer-back-btn');
  const globalFab = documentRef?.getElementById?.('ai-quick-toggle-fab');
  const topNavToggleBtn = documentRef?.getElementById?.('top-ai-toggle-btn');
  const wakewordToggleBtn = panel.querySelector('.ai-wakeword-toggle-btn');
  const wakewordModalBtn = panel.querySelector('#ai-wakeword-modal-toggle');
  const wakewordStatusBadge = panel.querySelector('#ai-wakeword-status');

  // Tactical Superpower Sub-Controllers
  // Create the controller object first so tactical sub-controllers can
  // reference it directly during construction (no fragile post-hoc wiring).
  const controller = {};
  const droneRecon = new DroneReconController({
    getViewer: () => globalThis.__godsEyeView?.viewer,
    aiController: controller,
    playCue: playAudioCue,
  });

  const cctvGrid = new CctvSurveillanceGrid({
    getViewer: () => globalThis.__godsEyeView?.viewer,
    documentRef,
    playCue: playAudioCue,
  });

  const geoPlotter = new GeoDataPlotter({
    getViewer: () => globalThis.__godsEyeView?.viewer,
    aiController: controller,
    documentRef,
    playCue: playAudioCue,
  });
  geoPlotter.init();

  const threatScanner = new GeospatialThreatScanner({
    getViewer: () => globalThis.__godsEyeView?.viewer,
    aiController: controller,
    documentRef,
    playCue: playAudioCue,
  });
  threatScanner.start();

  // Hands-Free Wake-Word Intercom Engine
  let wakeWordActive = false;
  let wakeRecognition = null;
  let wakeWordStopped = false;
  let wakeRestartCount = 0;
  const WAKE_RESTART_MAX = 3;
  const WAKE_RESTART_DELAY_MS = 500;
  const SpeechRecClass =
    globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

  function syncWakeWordUi() {
    wakewordToggleBtn?.classList?.toggle?.('active', wakeWordActive);
    if (wakewordToggleBtn) {
      wakewordToggleBtn.title = wakeWordActive
        ? 'Hands-Free "Hey JARVIS" Active (Click to mute)'
        : 'Enable Hands-Free "Hey JARVIS" Wake-Word Intercom';
    }
    if (wakewordModalBtn) {
      wakewordModalBtn.classList?.toggle?.('active', wakeWordActive);
      wakewordModalBtn.textContent = wakeWordActive
        ? 'Disable "Hey JARVIS"'
        : 'Enable "Hey JARVIS" Wake-Word';
    }
    if (wakewordStatusBadge) {
      wakewordStatusBadge.textContent = wakeWordActive
        ? 'LISTENING (Hey JARVIS)'
        : 'STANDBY';
      wakewordStatusBadge.classList?.toggle?.('active', wakeWordActive);
    }
  }

  function startWakeWordEngine() {
    if (!SpeechRecClass) {
      appendMessage(
        'assistant',
        '⚠️ Hands-Free SpeechRecognition is not supported in this browser. Please use Chrome or Edge.',
      );
      return;
    }
    try {
      if (wakeRecognition) {
        try {
          wakeRecognition.abort?.();
        } catch {}
      }
      wakeRecognition = new SpeechRecClass();
      wakeRecognition.continuous = true;
      wakeRecognition.interimResults = false;
      wakeRecognition.lang = voiceSettings.micLang || 'en-US';

      wakeRecognition.onresult = (event) => {
        if (!wakeWordActive) return;
        const lastResult = event.results?.[event.results.length - 1];
        const transcript = lastResult?.[0]?.transcript?.trim() || '';
        if (!transcript) return;

        const wakeMatch = transcript.match(
          /\b(?:hey\s+|ok\s+|okay\s+)?jarvis\b/i,
        );
        if (wakeMatch) {
          playAudioCue('wake');
          const pulse = panel.querySelector('.ai-status-pulse');
          if (pulse) {
            pulse.classList?.add?.('pulse-wake');
            setTimeout(() => pulse.classList?.remove?.('pulse-wake'), 1500);
          }

          if (panel.classList?.contains?.('collapsed')) {
            togglePanel(true);
          }

          const commandMatch = transcript.match(
            /\b(?:hey\s+|ok\s+|okay\s+)?jarvis[\s,.:;!?-]+(.*)$/i,
          );
          const cmd = commandMatch ? commandMatch[1].trim() : '';

          if (cmd && inputEl) {
            inputEl.value = cmd;
            void handleSend();
          } else {
            speakText('Online. What is your mission, Operator?');
            if (inputEl) setTimeout(() => inputEl.focus?.(), 60);
          }
        }
      };

      wakeRecognition.onerror = (e) => {
        if (
          wakeWordActive &&
          !wakeWordStopped &&
          e?.error !== 'no-speech' &&
          e?.error !== 'aborted'
        ) {
          if (wakeRestartCount < WAKE_RESTART_MAX) {
            wakeRestartCount++;
            setTimeout(() => {
              if (wakeWordActive && !wakeWordStopped) {
                try {
                  wakeRecognition.start?.();
                } catch {}
              }
            }, WAKE_RESTART_DELAY_MS);
          }
        }
      };

      wakeRecognition.onend = () => {
        if (wakeWordActive && !wakeWordStopped) {
          if (wakeRestartCount < WAKE_RESTART_MAX) {
            wakeRestartCount++;
            setTimeout(() => {
              if (wakeWordActive && !wakeWordStopped) {
                try {
                  wakeRecognition.start?.();
                } catch {}
              }
            }, WAKE_RESTART_DELAY_MS);
          }
        }
      };

      wakeRecognition.start?.();
      wakeWordStopped = false;
      wakeRestartCount = 0;
      wakeWordActive = true;
      syncWakeWordUi();
      playAudioCue('wake');
      appendMessage(
        'assistant',
        '🎙️ **Hands-Free Intercom Online.** Say *"Hey JARVIS"* followed by your command without touching your mouse or keyboard.',
      );
    } catch (err) {
      wakeWordActive = false;
      syncWakeWordUi();
      appendMessage(
        'assistant',
        `⚠️ Could not start Hands-Free Intercom: ${err.message || err}`,
      );
    }
  }

  function stopWakeWordEngine() {
    wakeWordActive = false;
    wakeWordStopped = true;
    wakeRestartCount = 0;
    if (wakeRecognition) {
      try {
        wakeRecognition.stop?.();
      } catch {}
    }
    syncWakeWordUi();
    appendMessage(
      'assistant',
      '🎙️ **Hands-Free Intercom Disengaged.** Standby mode active.',
    );
  }

  function toggleWakeWord() {
    if (wakeWordActive) stopWakeWordEngine();
    else startWakeWordEngine();
  }

  wakewordToggleBtn?.addEventListener?.('click', toggleWakeWord);
  wakewordModalBtn?.addEventListener?.('click', toggleWakeWord);
  syncWakeWordUi();

  function syncPanelUiState() {
    const isCollapsed = panel.classList?.contains?.('collapsed');
    if (collapseBtn) {
      collapseBtn.textContent = isCollapsed ? '+' : '−';
      collapseBtn.setAttribute?.('aria-expanded', String(!isCollapsed));
      collapseBtn.title = isCollapsed
        ? 'Expand JARVIS (Ctrl+K)'
        : 'Collapse JARVIS (Ctrl+K)';
    }
    if (globalFab) {
      globalFab.classList?.toggle?.('active', !isCollapsed);
      globalFab.setAttribute?.('aria-expanded', String(!isCollapsed));
    }
    if (topNavToggleBtn) {
      topNavToggleBtn.classList?.toggle?.('active', !isCollapsed);
      topNavToggleBtn.setAttribute?.('aria-expanded', String(!isCollapsed));
    }
  }

  // Header click toggles panel unless clicking interactive children
  header?.addEventListener?.('click', (e) => {
    if (
      e?.target?.closest?.(
        'button, input, select, textarea, a, .ai-header-btn, .ai-nav-breadcrumb, .ai-active-model-badge',
      )
    ) {
      return;
    }
    togglePanel();
  });

  collapsedHint?.addEventListener?.('click', (e) => {
    e.stopPropagation?.();
    togglePanel(true);
  });

  closeBtn?.addEventListener?.('click', (e) => {
    e.stopPropagation?.();
    togglePanel(false);
  });

  globalFab?.addEventListener?.('click', (e) => {
    e.stopPropagation?.();
    togglePanel();
  });

  topNavToggleBtn?.addEventListener?.('click', (e) => {
    e.stopPropagation?.();
    togglePanel();
  });

  drawerBackBtns?.forEach?.((btn) => {
    btn.addEventListener?.('click', () => switchView('chat'));
  });

  if (typeof MutationObserver !== 'undefined' && panel) {
    try {
      const panelObserver = new MutationObserver(() => syncPanelUiState());
      panelObserver.observe(panel, {
        attributes: true,
        attributeFilter: ['class'],
      });
    } catch {}
  }
  syncPanelUiState();

  let activeModel = 'auto';
  try {
    const savedModel = localStorage.getItem('jarvis_active_model');
    if (savedModel) activeModel = savedModel;
  } catch {}
  if (modelBadge) {
    if (activeModel === 'auto') {
      modelBadge.textContent = '🎯 Auto-MoE';
      modelBadge.title =
        'Active: Auto-MoE (All Models & Providers Working Simultaneously)';
    } else if (
      activeModel === 'ensemble' ||
      activeModel === 'council' ||
      activeModel === 'swarm'
    ) {
      modelBadge.textContent = '👥 Council';
      modelBadge.title = 'Active: JARVIS Council (Multi-Model Swarm)';
    } else {
      const clean = (activeModel.split('/').pop() || activeModel).replace(
        /-instruct|-it/g,
        '',
      );
      modelBadge.textContent = clean;
      modelBadge.title = `Active Model: ${activeModel}`;
    }
  }
  let autoSpeak = false;
  let currentView = 'chat';

  // Speech synthesis (TTS) with full multilingual and neural voice detection
  function speakText(text) {
    if (!globalThis.speechSynthesis) return;
    try {
      globalThis.speechSynthesis.cancel();
      const clean = text
        .replace(/```[\s\S]*?```/g, 'Code block omitted.')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/[*_#~]/g, '')
        .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
        .replace(/<[^>]+>/g, '')
        .slice(0, 600);

      const targetLang =
        voiceSettings.lang === 'auto'
          ? detectTextLanguage(clean)
          : voiceSettings.lang;

      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.lang = targetLang;
      utterance.rate = Number(voiceSettings.rate) || 1.0;
      utterance.pitch = Number(voiceSettings.pitch) || 1.0;

      const voices = globalThis.speechSynthesis.getVoices?.() || [];
      playAudioCue('comm');
      const chosenVoice = selectBestVoice(
        voices,
        targetLang,
        voiceSettings.preferredVoice,
        voiceSettings.voiceModel || 'jarvis',
      );
      if (chosenVoice) utterance.voice = chosenVoice;

      globalThis.speechSynthesis.speak(utterance);
    } catch {
      // Speech synthesis error is non-blocking
    }
  }

  // Populate dynamic voice dropdown options
  function populateVoiceOptions() {
    if (!voicePickerSelect || !globalThis.speechSynthesis) return;
    const voices = globalThis.speechSynthesis.getVoices?.() || [];
    const currentLang = voiceSettings.lang;
    const primary =
      currentLang === 'auto' ? '' : currentLang.split('-')[0].toLowerCase();

    voicePickerSelect.innerHTML =
      '<option value="">Auto-Select Best Natural Voice</option>';

    const sorted = [...voices].sort((a, b) => {
      const aNat = /natural|neural|online|google/i.test(a.name) ? 1 : 0;
      const bNat = /natural|neural|online|google/i.test(b.name) ? 1 : 0;
      return bNat - aNat;
    });

    for (const v of sorted) {
      if (primary && !v.lang.toLowerCase().startsWith(primary)) continue;
      const opt = documentRef.createElement('option');
      opt.value = v.name;
      const badge = /natural|neural|online|google/i.test(v.name)
        ? ' [⚡ Neural]'
        : '';
      opt.textContent = `${v.name} (${v.lang})${badge}`;
      if (v.name === voiceSettings.preferredVoice) opt.selected = true;
      voicePickerSelect.appendChild(opt);
    }
  }

  if (globalThis.speechSynthesis?.onvoiceschanged !== undefined) {
    globalThis.speechSynthesis.onvoiceschanged = populateVoiceOptions;
  }
  populateVoiceOptions();

  // Sync initial voice settings to UI
  if (voiceLangSelect) voiceLangSelect.value = voiceSettings.lang || 'auto';
  if (voiceModelSelect)
    voiceModelSelect.value = voiceSettings.voiceModel || 'jarvis';
  if (voiceRateSlider) {
    voiceRateSlider.value = String(voiceSettings.rate || 1.0);
    if (voiceRateVal) voiceRateVal.textContent = `${voiceSettings.rate}x`;
  }
  if (voicePitchSlider) {
    voicePitchSlider.value = String(voiceSettings.pitch || 1.0);
    if (voicePitchVal) voicePitchVal.textContent = String(voiceSettings.pitch);
  }
  if (micLangSelect) micLangSelect.value = voiceSettings.micLang || 'en-US';

  voiceSettingsBtn?.addEventListener('click', () => switchView('voice'));
  voiceModalCloseBtn?.addEventListener('click', () => switchView('chat'));
  genaiBtn?.addEventListener('click', () => switchView('genai'));

  voiceModelSelect?.addEventListener('change', () => {
    voiceSettings.voiceModel = voiceModelSelect.value;
    const model = VOICE_MODELS[voiceModelSelect.value];
    if (model) {
      voiceSettings.pitch = model.pitch;
      voiceSettings.rate = model.rate;
      if (voicePitchSlider) voicePitchSlider.value = String(model.pitch);
      if (voicePitchVal)
        voicePitchVal.textContent = String(model.pitch.toFixed(2));
      if (voiceRateSlider) voiceRateSlider.value = String(model.rate);
      if (voiceRateVal) voiceRateVal.textContent = `${model.rate.toFixed(2)}x`;
    }
    saveVoiceSettings();
    populateVoiceOptions();
    syncPersonaCardSelection();
    speakText(`Voice model calibrated to ${model?.name || 'custom'}.`);
  });

  // Persona card quick-select
  panel.querySelectorAll('.ai-persona-card').forEach((card) => {
    card.addEventListener('click', () => {
      const persona = card.dataset.persona;
      if (!persona) return;
      voiceSettings.voiceModel = persona;
      if (voiceModelSelect) voiceModelSelect.value = persona;
      const model = VOICE_MODELS[persona];
      if (model) {
        voiceSettings.pitch = model.pitch;
        voiceSettings.rate = model.rate;
        if (voicePitchSlider) voicePitchSlider.value = String(model.pitch);
        if (voicePitchVal)
          voicePitchVal.textContent = String(model.pitch.toFixed(2));
        if (voiceRateSlider) voiceRateSlider.value = String(model.rate);
        if (voiceRateVal)
          voiceRateVal.textContent = `${model.rate.toFixed(2)}x`;
      }
      saveVoiceSettings();
      populateVoiceOptions();
      syncPersonaCardSelection();
      speakText(`Voice model calibrated to ${model?.name || persona}.`);
    });
  });

  function syncPersonaCardSelection() {
    panel.querySelectorAll('.ai-persona-card').forEach((card) => {
      card.classList.toggle(
        'active',
        card.dataset.persona === voiceSettings.voiceModel,
      );
    });
  }
  syncPersonaCardSelection();

  voiceLangSelect?.addEventListener('change', () => {
    voiceSettings.lang = voiceLangSelect.value;
    voiceSettings.preferredVoice = '';
    saveVoiceSettings();
    populateVoiceOptions();
  });
  voicePickerSelect?.addEventListener('change', () => {
    voiceSettings.preferredVoice = voicePickerSelect.value;
    saveVoiceSettings();
  });
  voiceRateSlider?.addEventListener('input', () => {
    voiceSettings.rate = parseFloat(voiceRateSlider.value) || 1.0;
    if (voiceRateVal)
      voiceRateVal.textContent = `${voiceSettings.rate.toFixed(2)}x`;
    saveVoiceSettings();
  });
  voicePitchSlider?.addEventListener('input', () => {
    voiceSettings.pitch = parseFloat(voicePitchSlider.value) || 1.0;
    if (voicePitchVal)
      voicePitchVal.textContent = voiceSettings.pitch.toFixed(2);
    saveVoiceSettings();
  });
  micLangSelect?.addEventListener('change', () => {
    voiceSettings.micLang = micLangSelect.value;
    if (recognition) recognition.lang = voiceSettings.micLang;
    saveVoiceSettings();
  });

  voiceTestBtn?.addEventListener('click', () => {
    const lang = voiceSettings.lang === 'auto' ? 'en-US' : voiceSettings.lang;
    const personaProfile =
      VOICE_MODELS[voiceSettings.voiceModel] || VOICE_MODELS.jarvis;
    let sample =
      'Hello Operator, JARVIS voice synthesis online and calibrated.';
    if (lang.startsWith('hi'))
      sample = 'नमस्ते, मैं जार्विस हूँ। आपकी क्या मदद कर सकता हूँ?';
    else if (lang.startsWith('es'))
      sample = 'Hola, soy JARVIS. Sistema de voz en español calibrado.';
    else if (lang.startsWith('fr'))
      sample = 'Bonjour, je suis JARVIS. Synthèse vocale française activée.';
    else if (lang.startsWith('de'))
      sample = 'Hallo, ich bin JARVIS. Sprachausgabe erfolgreich kalibriert.';
    else if (lang.startsWith('ja'))
      sample =
        'こんにちは、ジャービスです。音声出力システムが正常に作動しています。';
    else if (lang.startsWith('zh'))
      sample = '你好，我是贾维斯。多语言语音合成系统已就绪。';
    else if (lang.startsWith('ru'))
      sample = 'Здравствуйте, я Джарвис. Голосовая система откалибрована.';
    else
      sample = `Testing ${personaProfile.name} persona: ${personaProfile.description}.`;
    speakText(sample);
  });
  voiceStopBtn?.addEventListener('click', () => {
    globalThis.speechSynthesis?.cancel?.();
  });

  // Persona and Temperature controls
  personaSelect?.addEventListener('change', () => {
    currentPersona = personaSelect.value;
  });
  tempSlider?.addEventListener('input', () => {
    currentTemperature = parseFloat(tempSlider.value) || 0.6;
    if (tempVal) tempVal.textContent = currentTemperature.toFixed(2);
  });

  // Emergency Unlock & Reset button
  function unlockAndResetChat() {
    isStreaming = false;
    currentAbortController?.abort();
    currentAbortController = null;
    globalThis.speechSynthesis?.cancel?.();
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.innerHTML = '<span>⚡</span> SEND';
      sendBtn.classList.remove('ai-send-btn-stop');
    }
    if (inputEl) {
      inputEl.disabled = false;
      inputEl.focus();
    }
    hideToolStatus();
    panel.querySelectorAll('.ai-msg.typing').forEach((el) => el.remove());
    if (historyDrawer) historyDrawer.hidden = true;
    historyBtn?.classList.remove('active');
    if (modelDrawer) modelDrawer.hidden = true;
    if (voiceModal) voiceModal.hidden = true;
    if (deviceModal) deviceModal.hidden = true;
    if (systemDrawer) systemDrawer.hidden = true;
    if (latencyDisplay) latencyDisplay.textContent = '⚡ ready';
  }
  unlockBtn?.addEventListener('click', () => {
    unlockAndResetChat();
    appendMessage(
      'assistant',
      'Chat input unlocked and reset. Ready for your prompt.',
    );
  });

  // Centralized View & Drawer Navigation
  function switchView(viewName) {
    if (currentView === viewName && viewName !== 'chat') {
      viewName = 'chat';
    }
    currentView = viewName;

    viewTabs.forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.view === viewName);
    });

    historyBtn?.classList?.toggle?.('active', viewName === 'history');

    if (breadcrumb) {
      const labels = {
        chat: '› Chat',
        history: '› History',
        models: '› Models',
        voice: '› Voice',
        device: '› Mobile',
        system: '› System',
      };
      breadcrumb.textContent = labels[viewName] || `› ${viewName}`;
      breadcrumb.title = `Current View: ${(labels[viewName] || viewName).replace('› ', '')} (Click to return to Chat)`;
    }

    if (historyDrawer) historyDrawer.hidden = viewName !== 'history';
    if (modelDrawer) modelDrawer.hidden = viewName !== 'models';
    if (voiceModal) voiceModal.hidden = viewName !== 'voice';
    if (deviceModal) deviceModal.hidden = viewName !== 'device';
    if (systemDrawer) systemDrawer.hidden = viewName !== 'system';
    if (genaiDrawer) genaiDrawer.hidden = viewName !== 'genai';

    if (viewName === 'history') {
      void loadHistory();
    } else if (viewName === 'voice') {
      populateVoiceOptions();
    } else if (viewName === 'device') {
      void showDeviceModal();
    } else if (viewName === 'system') {
      void refreshSystemView();
    } else if (viewName === 'genai') {
      // ensure gallery is visible
    } else if (viewName === 'chat') {
      if (inputEl) setTimeout(() => inputEl.focus(), 60);
    }
  }

  viewTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      switchView(tab.dataset.view || 'chat');
    });
  });

  breadcrumb?.addEventListener('click', () => switchView('chat'));

  // Horizontal scroll navigation for Mode Tabs & Model Quick Bar
  modeScrollLeft?.addEventListener('click', () => {
    modeTabsContainer?.scrollBy({ left: -140, behavior: 'smooth' });
  });
  modeScrollRight?.addEventListener('click', () => {
    modeTabsContainer?.scrollBy({ left: 140, behavior: 'smooth' });
  });

  modelScrollLeft?.addEventListener('click', () => {
    modelQuickScroll?.scrollBy({ left: -140, behavior: 'smooth' });
  });
  modelScrollRight?.addEventListener('click', () => {
    modelQuickScroll?.scrollBy({ left: 140, behavior: 'smooth' });
  });

  // In-Chat Search & Navigator
  let searchMatches = [];
  let currentMatchIndex = -1;

  function updateSearchHighlights() {
    if (typeof panel.querySelectorAll === 'function') {
      panel.querySelectorAll('.ai-msg.ai-search-match').forEach((el) => {
        el.classList?.remove?.('ai-search-match', 'ai-search-active-match');
      });
    }

    if (searchMatches.length === 0) {
      if (searchCount) searchCount.textContent = '0/0';
      return;
    }

    if (currentMatchIndex < 0) currentMatchIndex = 0;
    if (currentMatchIndex >= searchMatches.length)
      currentMatchIndex = searchMatches.length - 1;

    searchMatches.forEach((match, idx) => {
      match.el.classList?.add?.('ai-search-match');
      if (idx === currentMatchIndex) {
        match.el.classList?.add?.('ai-search-active-match');
        if (typeof match.el.scrollIntoView === 'function') {
          match.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    });

    if (searchCount) {
      searchCount.textContent = `${currentMatchIndex + 1}/${searchMatches.length}`;
    }
  }

  function performChatSearch(query) {
    const q = (query || '').toLowerCase().trim();
    searchMatches = [];
    currentMatchIndex = -1;

    if (!q || !messagesContainer) {
      updateSearchHighlights();
      return;
    }

    const allMsgEls =
      typeof messagesContainer.querySelectorAll === 'function'
        ? Array.from(messagesContainer.querySelectorAll('.ai-msg'))
        : [];
    allMsgEls.forEach((el) => {
      const text = (
        el.querySelector?.('.ai-msg-content')?.textContent ||
        el.textContent ||
        ''
      ).toLowerCase();
      if (text.includes(q)) {
        searchMatches.push({ el, text });
      }
    });

    if (searchMatches.length > 0) {
      currentMatchIndex = 0;
    }
    updateSearchHighlights();
  }

  function toggleChatSearch(forceState = null) {
    if (!searchBar) return;
    const willOpen = forceState !== null ? forceState : searchBar.hidden;
    searchBar.hidden = !willOpen;
    searchToggleBtn?.classList.toggle('active', willOpen);
    if (willOpen) {
      if (searchInput) {
        searchInput.focus?.();
        searchInput.select?.();
        performChatSearch(searchInput.value);
      }
    } else {
      searchMatches = [];
      updateSearchHighlights();
      if (inputEl) inputEl.focus?.();
    }
  }

  searchToggleBtn?.addEventListener('click', () => toggleChatSearch());
  searchCloseBtn?.addEventListener('click', () => toggleChatSearch(false));
  searchInput?.addEventListener('input', () =>
    performChatSearch(searchInput.value),
  );
  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchMatches.length === 0) return;
      if (e.shiftKey) {
        currentMatchIndex =
          (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
      } else {
        currentMatchIndex = (currentMatchIndex + 1) % searchMatches.length;
      }
      updateSearchHighlights();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      toggleChatSearch(false);
    }
  });

  searchPrevBtn?.addEventListener('click', () => {
    if (searchMatches.length > 0) {
      currentMatchIndex =
        (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
      updateSearchHighlights();
    }
  });
  searchNextBtn?.addEventListener('click', () => {
    if (searchMatches.length > 0) {
      currentMatchIndex = (currentMatchIndex + 1) % searchMatches.length;
      updateSearchHighlights();
    }
  });

  // In-Chat Floating Scroll Navigator
  function updateScrollNavigatorVisibility() {
    if (!messagesContainer || !scrollNavigator) return;
    const distFromBottom =
      (messagesContainer.scrollHeight || 0) -
      (messagesContainer.scrollTop || 0) -
      (messagesContainer.clientHeight || 0);
    const isScrolledUp = distFromBottom > 80;
    const hasScrollable =
      (messagesContainer.scrollHeight || 0) >
      (messagesContainer.clientHeight || 0) + 40;

    if (isScrolledUp && hasScrollable) {
      scrollNavigator.hidden = false;
    } else {
      scrollNavigator.hidden = true;
      if (scrollUnreadBadge) scrollUnreadBadge.hidden = true;
    }
  }

  if (typeof messagesContainer?.addEventListener === 'function') {
    messagesContainer.addEventListener(
      'scroll',
      updateScrollNavigatorVisibility,
    );
  }

  function scrollToLatestMessage(smooth = true) {
    if (!messagesContainer) return;
    if (typeof messagesContainer.scrollTo === 'function') {
      messagesContainer.scrollTo({
        top: messagesContainer.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto',
      });
    } else {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
    if (scrollUnreadBadge) scrollUnreadBadge.hidden = true;
    if (inputEl) setTimeout(() => inputEl.focus?.(), 60);
  }

  function scrollToTopOfChat(smooth = true) {
    if (!messagesContainer) return;
    if (typeof messagesContainer.scrollTo === 'function') {
      messagesContainer.scrollTo({
        top: 0,
        behavior: smooth ? 'smooth' : 'auto',
      });
    } else {
      messagesContainer.scrollTop = 0;
    }
  }

  scrollBottomBtn?.addEventListener('click', () => scrollToLatestMessage(true));
  scrollTopBtn?.addEventListener('click', () => scrollToTopOfChat(true));

  // Click outside drawers/modals to return to chat
  panel.addEventListener('click', (e) => {
    if (
      currentView !== 'chat' &&
      !e.target.closest(
        '.ai-history-drawer, .ai-history-btn, .ai-model-drawer, .ai-active-model-badge, .ai-quick-model-btn, .ai-voice-modal, .ai-voice-settings-btn, .ai-device-modal, .ai-phone-btn, .ai-view-nav',
      )
    ) {
      switchView('chat');
    }
  });

  globalThis.addEventListener?.('keydown', (e) => {
    if (e.key === 'Escape') {
      if (searchBar && !searchBar.hidden) {
        toggleChatSearch(false);
      } else if (currentView !== 'chat') {
        switchView('chat');
      }
    }
    // Alt+1 to Alt+5 View Navigation shortcuts
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      if (e.key === '1') {
        e.preventDefault();
        switchView('chat');
      } else if (e.key === '2') {
        e.preventDefault();
        switchView('history');
      } else if (e.key === '3') {
        e.preventDefault();
        switchView('models');
      } else if (e.key === '4') {
        e.preventDefault();
        switchView('voice');
      } else if (e.key === '5') {
        e.preventDefault();
        switchView('device');
      }
    }
  });

  // Voice toggle button
  voiceToggleBtn?.addEventListener?.('click', () => {
    autoSpeak = !autoSpeak;
    voiceToggleBtn.textContent = autoSpeak ? '🔊' : '🔇';
    voiceToggleBtn.title = autoSpeak
      ? 'Auto-Speak Voice Active (Click to mute)'
      : 'Auto-Speak Voice Muted (Click to enable)';
    if (!autoSpeak) globalThis.speechSynthesis?.cancel?.();
  });

  // Unified Model Switcher
  function switchModel(selectedModel, notify = true) {
    if (!selectedModel) return;
    activeModel = selectedModel;
    try {
      localStorage.setItem('jarvis_active_model', selectedModel);
    } catch {}
    modelOpts.forEach((b) =>
      b.classList?.toggle?.('active', b.dataset.model === selectedModel),
    );
    quickModelBtns.forEach((b) =>
      b.classList?.toggle?.('active', b.dataset.model === selectedModel),
    );
    if (modelBadge) {
      if (selectedModel === 'auto') {
        modelBadge.textContent = '🎯 Auto-MoE';
        modelBadge.title =
          'Active: Auto-MoE (Intelligent Dynamic Task Routing)';
      } else if (
        selectedModel === 'ensemble' ||
        selectedModel === 'council' ||
        selectedModel === 'swarm'
      ) {
        modelBadge.textContent = '👥 Council';
        modelBadge.title =
          'Active: JARVIS Council (Multi-Provider Swarm running concurrently across all providers)';
      } else {
        const cleanName = (
          selectedModel.split('/').pop() || selectedModel
        ).replace(/-instruct|-it/g, '');
        modelBadge.textContent = cleanName;
        modelBadge.title = `Active Model: ${selectedModel}`;
      }
    }
    switchView('chat');
    if (notify) {
      const msgCount = messages.length;
      const ctxNote =
        msgCount > 0 ? ` (Context preserved: ${msgCount} messages)` : '';
      if (selectedModel === 'auto') {
        appendMessage(
          'assistant',
          `🎯 **Intelligent Auto-MoE active.** Prompts will automatically analyze domain and route to the best specialized model and provider dynamically${ctxNote}.`,
        );
      } else if (
        selectedModel === 'ensemble' ||
        selectedModel === 'council' ||
        selectedModel === 'swarm'
      ) {
        appendMessage(
          'assistant',
          `👥 **JARVIS Omni-Swarm Council activated.** Prompts will execute concurrently across your configured providers (Gemini, Groq, Cerebras, Mistral, Cohere, SambaNova, NVIDIA) in parallel, followed by consensus synthesis${ctxNote}.`,
        );
      } else {
        const cleanName = (
          selectedModel.split('/').pop() || selectedModel
        ).replace(/-instruct|-it/g, '');
        appendMessage(
          'assistant',
          `⚡ Active model switched to **${cleanName}**${ctxNote}.`,
        );
      }
    }
  }

  // Model Picker Drawer & Quick Chips
  modelBadge?.addEventListener?.('click', () => switchView('models'));
  modelCloseBtn?.addEventListener?.('click', () => switchView('chat'));
  modelOpts.forEach((btn) => {
    btn.addEventListener?.('click', () => {
      switchModel(btn.dataset.model);
    });
  });
  quickModelBtns.forEach((btn) => {
    btn.addEventListener?.('click', () => {
      switchModel(btn.dataset.model);
    });
  });

  // Conversation Export (Markdown Tactical Briefing)
  function exportConversation() {
    if (messages.length === 0) return;
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let md = `# JARVIS Tactical Intelligence Dossier\n**Date:** ${new Date().toLocaleString()}\n**Active Model:** ${activeModel}\n**Mode:** ${currentMode.toUpperCase()}\n\n---\n\n`;
    for (const msg of messages) {
      const roleLabel = msg.role === 'user' ? '👤 OPERATOR' : '🤖 JARVIS';
      md += `### ${roleLabel}\n\n${msg.content}\n\n---\n\n`;
    }
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = documentRef.createElement('a');
    a.href = url;
    a.download = `JARVIS_Mission_Briefing_${dateStr}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  exportBtn?.addEventListener?.('click', exportConversation);

  // Update memory count in status bar
  async function updateMemoryCount() {
    try {
      const res = await fetch(JARVIS_API.memory);
      if (res.ok) {
        const data = await res.json();
        const count = Object.keys(data.memory || {}).length;
        if (memoryCountDisplay) {
          memoryCountDisplay.textContent = `🧠 ${count} memories`;
        }
      }
    } catch {
      /* optional */
    }
  }
  void updateMemoryCount();

  // Fetch active model status & free provider
  async function updateActiveModel() {
    try {
      const res = await fetch(NVIDIA_API.status);
      if (res.ok) {
        const data = await res.json();
        if (data.model) {
          if (
            activeModel === 'council' ||
            activeModel === 'ensemble' ||
            activeModel === 'swarm' ||
            activeModel === 'auto'
          ) {
            if (modelBadge) {
              const isConfigured = Boolean(data.configured);
              const swarmCount =
                data.swarmCount ||
                (data.activeProviders ? data.activeProviders.length : 1);
              modelBadge.textContent = `⚡ Omni-Swarm (${swarmCount}) ${isConfigured ? '🟢' : '⚠️'}`;
              modelBadge.title = `⚡ Omni-Provider Swarm Active | ${swarmCount} AI providers configured and running simultaneously in parallel`;
              if (isConfigured) {
                modelBadge.style.borderColor = 'rgba(57, 255, 20, 0.6)';
                modelBadge.style.boxShadow = '0 0 8px rgba(57, 255, 20, 0.3)';
              } else {
                modelBadge.style.borderColor = 'rgba(255, 170, 0, 0.6)';
                modelBadge.style.boxShadow = '0 0 8px rgba(255, 170, 0, 0.3)';
              }
            }
          } else {
            let hasSavedModel = false;
            try {
              hasSavedModel = Boolean(
                localStorage.getItem('jarvis_active_model'),
              );
            } catch {}
            if (!hasSavedModel) {
              activeModel = data.model;
            }
            if (modelBadge) {
              const currentOrDataModel = activeModel || data.model;
              const shortModel = (
                currentOrDataModel.split('/').pop() || currentOrDataModel
              ).replace(/-instruct|-it/g, '');
              let prefix = '⚡';
              let providerName = 'AI Provider';
              const lower = currentOrDataModel.toLowerCase();
              if (lower.startsWith('groq') || lower.includes('groq')) {
                prefix = '🚀';
                providerName = 'Groq Cloud';
              } else if (
                lower.startsWith('gemini') ||
                lower.includes('gemini')
              ) {
                prefix = '🟢';
                providerName = 'Google Gemini';
              } else if (
                lower.startsWith('cerebras') ||
                lower.includes('cerebras')
              ) {
                prefix = '⚡';
                providerName = 'Cerebras';
              } else if (
                lower.startsWith('mistral') ||
                lower.includes('codestral') ||
                lower.includes('pixtral')
              ) {
                prefix = '🌪️';
                providerName = 'Mistral AI';
              } else if (
                lower.startsWith('cohere') ||
                lower.includes('command-r')
              ) {
                prefix = '🧠';
                providerName = 'Cohere';
              } else if (
                lower.startsWith('deepseek') ||
                lower.includes('deepseek')
              ) {
                prefix = '🔬';
                providerName = 'DeepSeek';
              } else if (
                lower.startsWith('sambanova') ||
                lower.includes('sambanova')
              ) {
                prefix = '⚡';
                providerName = 'SambaNova';
              } else if (
                lower.startsWith('openrouter') ||
                lower.includes('openrouter')
              ) {
                prefix = '🌐';
                providerName = 'OpenRouter';
              } else if (
                lower.startsWith('together') ||
                lower.includes('together')
              ) {
                prefix = '🤝';
                providerName = 'Together AI';
              } else if (lower.includes('nemotron')) {
                prefix = '⚡';
                providerName = 'NVIDIA NIM';
              } else {
                const url = data.baseUrl || '';
                if (url.includes('groq.com')) {
                  prefix = '🚀';
                  providerName = 'Groq Cloud';
                } else if (url.includes('googleapis.com')) {
                  prefix = '🟢';
                  providerName = 'Google Gemini';
                } else if (url.includes('cohere.com')) {
                  prefix = '🧠';
                  providerName = 'Cohere';
                } else if (url.includes('sambanova.ai')) {
                  prefix = '⚡';
                  providerName = 'SambaNova';
                } else if (url.includes('cerebras.ai')) {
                  prefix = '⚡';
                  providerName = 'Cerebras';
                } else if (url.includes('mistral.ai')) {
                  prefix = '🌪️';
                  providerName = 'Mistral AI';
                } else if (url.includes('openrouter.ai')) {
                  prefix = '🌐';
                  providerName = 'OpenRouter';
                }
              }

              const isConfigured = Boolean(data.configured);
              const statusIcon = isConfigured ? '🟢' : '⚠️';
              modelBadge.textContent = `${prefix} ${shortModel} ${statusIcon}`;
              modelBadge.title = isConfigured
                ? `✓ KEY SAVED & ACTIVE | Model: ${currentOrDataModel} (${providerName})`
                : `⚠️ NO KEY PASTED YET | Click to open POWER UP station and paste your key`;
              if (isConfigured) {
                modelBadge.style.borderColor = 'rgba(57, 255, 20, 0.6)';
                modelBadge.style.boxShadow = '0 0 8px rgba(57, 255, 20, 0.3)';
              } else {
                modelBadge.style.borderColor = 'rgba(255, 170, 0, 0.6)';
                modelBadge.style.boxShadow = '0 0 8px rgba(255, 170, 0, 0.3)';
              }
            }
          }
        }
      }
    } catch {
      // Status failure is non-blocking
    }
  }
  void updateActiveModel();

  // Render quick prompts for current mode
  function renderQuickPrompts() {
    if (!quickPromptsContainer) return;
    quickPromptsContainer.innerHTML = '';
    const presets = MODE_PRESETS[currentMode] || [];
    for (const prompt of presets) {
      const chip = documentRef.createElement('button');
      chip.type = 'button';
      chip.className = 'ai-prompt-chip';
      chip.textContent = prompt;
      chip.addEventListener('click', () => {
        if (inputEl) {
          inputEl.value = prompt;
          void handleSend();
        }
      });
      quickPromptsContainer.appendChild(chip);
    }
  }

  // Switch active mode
  function setMode(newMode) {
    currentMode = newMode;
    tabs.forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.mode === newMode);
    });
    renderQuickPrompts();
    const modeNames = {
      general: '💬 CHAT',
      computer: '🖥️ COMPUTER',
      globe: '🌐 GLOBE',
      code: '💻 CODE',
      auto: '⚡ AUTO',
      study: '📚 STUDY',
      tasks: '✅ TASKS',
      research: '🔍 RESEARCH',
      memory: '🧠 MEMORY',
    };
    appendMessage(
      'assistant',
      `Switched to **${modeNames[newMode] || newMode.toUpperCase()}** mode. How can I help?`,
    );
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode;
      if (mode && mode !== currentMode) {
        setMode(mode);
      }
    });
  });

  // Append a message to the UI
  function appendMessage(
    role,
    text,
    {
      reasoning = null,
      toolExecutions = null,
      iterations = null,
      council = null,
      routedModel = null,
      routedReason = null,
    } = {},
  ) {
    if (!messagesContainer) return null;

    const msgEl = documentRef.createElement('div');
    msgEl.className = `ai-msg ${role}`;

    const bubble = documentRef.createElement('div');
    bubble.className = 'ai-msg-bubble';

    // Message Header (Author, Model badge, Timestamp)
    const headerDiv = documentRef.createElement('div');
    headerDiv.className = 'ai-msg-header';
    const nowStr = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    if (role === 'assistant') {
      let modelShort = 'JARVIS';
      if (activeModel === 'auto') {
        modelShort = 'Auto-MoE';
      } else if (activeModel === 'ensemble' || activeModel === 'council') {
        modelShort = 'Council';
      } else {
        modelShort = (activeModel.split('/').pop() || 'JARVIS').replace(
          /-instruct|-it/g,
          '',
        );
      }
      headerDiv.innerHTML = `<span class="ai-msg-author">🤖 JARVIS</span><span class="ai-msg-model-tag">${modelShort}</span><span class="ai-msg-time">${nowStr}</span>`;
      if (routedModel) {
        const shortRouted = (
          routedModel.split('/').pop() || routedModel
        ).replace(/-instruct|-it/g, '');
        const badge = documentRef.createElement('span');
        badge.className = 'ai-msg-routed-badge';
        badge.title = routedReason || `Dynamically routed to ${routedModel}`;
        badge.textContent = `🎯 ${shortRouted}`;
        headerDiv.appendChild(badge);
      }
    } else {
      headerDiv.innerHTML = `<span class="ai-msg-author">👤 OPERATOR</span><span class="ai-msg-time">${nowStr}</span>`;
    }
    bubble.appendChild(headerDiv);

    // Iteration badge for multi-step tool loops
    if (iterations && iterations > 1) {
      const iterBadge = documentRef.createElement('div');
      iterBadge.className = 'ai-iter-badge';
      iterBadge.textContent = `${iterations} iterations`;
      bubble.appendChild(iterBadge);
    }

    // JARVIS Council Swarm Deliberation Accordion
    if (Array.isArray(council) && council.length > 0) {
      const councilBox = documentRef.createElement('details');
      councilBox.className = 'ai-council-box';
      const councilPills = council
        .map(
          (c) =>
            `<span class="ai-council-tag">${c.name || c.model?.split('/').pop() || 'Model'}</span>`,
        )
        .join('');
      const cardsHtml = council
        .map(
          (c) => `
        <div class="ai-council-card">
          <div class="ai-council-card-header">
            <span class="ai-council-card-model">🤖 ${c.name || c.model?.split('/').pop() || 'Specialist'}</span>
            <span class="ai-council-card-role">${c.role || 'Deliberator'}</span>
          </div>
          <div class="ai-council-card-content">${formatMarkdown(c.content || '(no content)')}</div>
        </div>
      `,
        )
        .join('');
      councilBox.innerHTML = `
        <summary class="ai-council-summary">
          <span class="ai-council-title">👥 JARVIS Council Deliberation (${council.length} Models)</span>
          <span class="ai-council-models-preview">${councilPills}</span>
        </summary>
        <div class="ai-council-body">
          ${cardsHtml}
        </div>
      `;
      bubble.appendChild(councilBox);
    }

    // Extract thinking traces from text if present
    const extracted = extractThinking(text);
    const cleanText = extracted.content;
    const finalReasoning = reasoning || extracted.reasoning;

    if (finalReasoning) {
      const thinkBox = documentRef.createElement('details');
      thinkBox.className = 'ai-thinking-box';
      thinkBox.innerHTML = `<summary class="ai-thinking-summary">💭 Tactical Reasoning Trace</summary><div class="ai-thinking-content">${formatMarkdown(finalReasoning, { hideThinking: false })}</div>`;
      bubble.appendChild(thinkBox);
    }

    // Tool execution results
    if (toolExecutions && toolExecutions.length > 0) {
      const toolsContainer = documentRef.createElement('div');
      toolsContainer.className = 'ai-tool-executions';
      toolsContainer.innerHTML =
        `<div class="ai-tools-header">🔧 Tool Executions (${toolExecutions.length})</div>` +
        toolExecutions.map(formatToolExecution).join('');
      bubble.appendChild(toolsContainer);

      // Render inline image card if image was generated
      for (const ex of toolExecutions) {
        if (ex.name === 'generate_image' && ex.result?.imageUrl) {
          const imgCard = documentRef.createElement('div');
          imgCard.className = 'ai-genai-result-card';
          imgCard.innerHTML = `
            <div class="ai-genai-preview-wrap">
              <img src="${ex.result.imageUrl}" alt="${ex.result.prompt || 'Generated Art'}" class="ai-genai-preview-img" loading="lazy" />
            </div>
            <div class="ai-genai-meta-bar">
              <span class="ai-genai-model-tag">🎨 ${ex.result.model || 'Stable Diffusion 3'}</span>
              <a href="${ex.result.imageUrl}" download="${ex.result.filename || 'jarvis-generated.png'}" target="_blank" class="ai-genai-download-btn">⬇️ Download Image</a>
            </div>
          `;
          bubble.appendChild(imgCard);
        }
      }
    }

    const contentDiv = documentRef.createElement('div');
    contentDiv.className = 'ai-msg-content';
    contentDiv.innerHTML = formatMarkdown(cleanText);
    bubble.appendChild(contentDiv);

    if (role === 'assistant') {
      const actionsDiv = documentRef.createElement('div');
      actionsDiv.className = 'ai-msg-actions';
      actionsDiv.innerHTML = `
        <button type="button" class="ai-msg-action-btn ai-msg-like-btn" title="Good response">👍</button>
        <button type="button" class="ai-msg-action-btn ai-msg-dislike-btn" title="Needs work">👎</button>
        <button type="button" class="ai-msg-action-btn ai-msg-regen-btn" title="Regenerate">🔄 Regenerate</button>
        <button type="button" class="ai-msg-action-btn ai-msg-branch-btn" title="Branch from here">🌿 Branch</button>
        <button type="button" class="ai-msg-action-btn ai-msg-copy-btn" title="Copy response to clipboard">📋 Copy</button>
        <button type="button" class="ai-msg-action-btn ai-msg-speak-btn" title="Speak this response">🔊 Speak</button>
      `;

      const likeBtn = actionsDiv.querySelector('.ai-msg-like-btn');
      const dislikeBtn = actionsDiv.querySelector('.ai-msg-dislike-btn');
      const regenBtn = actionsDiv.querySelector('.ai-msg-regen-btn');
      const branchBtn = actionsDiv.querySelector('.ai-msg-branch-btn');

      let feedback = null;
      likeBtn?.addEventListener('click', () => {
        feedback = 'good';
        likeBtn.classList.add('active');
        dislikeBtn.classList.remove('active');
        likeBtn.textContent = '👍 ✓';
        playAudioCue('data');
      });
      dislikeBtn?.addEventListener('click', () => {
        feedback = 'bad';
        dislikeBtn.classList.add('active');
        likeBtn.classList.remove('active');
        dislikeBtn.textContent = '👎 ✗';
        playAudioCue('alert');
      });
      regenBtn?.addEventListener('click', () => {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        if (lastUser && inputEl) {
          inputEl.value = lastUser.content;
          void handleSend();
        }
        playAudioCue('comm');
      });
      branchBtn?.addEventListener('click', () => {
        if (typeof controller.branchConversation === 'function') {
          controller.branchConversation(msgEl);
        }
        playAudioCue('data');
      });
      actionsDiv
        .querySelector('.ai-msg-copy-btn')
        ?.addEventListener('click', async (e) => {
          try {
            await navigator.clipboard?.writeText(cleanText || text);
            e.target.textContent = '✓ Copied';
            setTimeout(() => {
              e.target.textContent = '📋 Copy';
            }, 1500);
          } catch {}
        });
      actionsDiv
        .querySelector('.ai-msg-speak-btn')
        ?.addEventListener('click', () => {
          speakText(cleanText || text);
        });
      bubble.appendChild(actionsDiv);

      if (autoSpeak && (cleanText || text)) {
        speakText(cleanText || text);
      }
    }

    msgEl.appendChild(bubble);
    messagesContainer.appendChild(msgEl);

    // Smart auto-scroll: if user is near bottom or role is user, scroll to bottom
    const distFromBottom =
      messagesContainer.scrollHeight -
      messagesContainer.scrollTop -
      messagesContainer.clientHeight;
    if (role === 'user' || distFromBottom <= 140) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    } else {
      if (scrollNavigator) scrollNavigator.hidden = false;
      if (scrollUnreadBadge) scrollUnreadBadge.hidden = false;
    }
    updateScrollNavigatorVisibility();

    if (searchBar && !searchBar.hidden && searchInput?.value) {
      performChatSearch(searchInput.value);
    }

    const updateThinking = (reasoningText) => {
      let box = bubble.querySelector('.ai-thinking-box');
      if (!box && reasoningText) {
        box = documentRef.createElement('details');
        box.className = 'ai-thinking-box';
        bubble.insertBefore(box, contentDiv);
      }
      if (box) {
        if (!reasoningText) {
          box.remove();
        } else {
          box.innerHTML = `<summary class="ai-thinking-summary">💭 Tactical Reasoning Trace</summary><div class="ai-thinking-content">${formatMarkdown(reasoningText, { hideThinking: false })}</div>`;
        }
      }
    };

    return { msgEl, bubble, headerDiv, contentDiv, updateThinking };
  }

  // Toggle panel collapse/expand smoothly
  function togglePanel(open = null) {
    const isCollapsed = panel.classList.contains('collapsed');
    const shouldOpen = open !== null ? open : isCollapsed;
    if (
      collapseBtn &&
      typeof collapseBtn.click === 'function' &&
      typeof collapseBtn.addEventListener !== 'function'
    ) {
      if (shouldOpen === isCollapsed) {
        collapseBtn.click();
      }
    } else {
      panel.classList.toggle('collapsed', !shouldOpen);
    }
    syncPanelUiState();

    if (shouldOpen) {
      if (inputEl) setTimeout(() => inputEl.focus?.(), 80);
    }
    if (
      typeof globalThis.dispatchEvent === 'function' &&
      typeof Event === 'function'
    ) {
      try {
        globalThis.dispatchEvent(new Event('resize'));
      } catch {}
    }
  }

  // File attachment handling (images + text files)
  function renderFilePreviews() {
    if (!previewBar) return;
    previewBar.innerHTML = '';
    previewBar.hidden = attachedFiles.length === 0;

    attachedFiles.forEach((file, index) => {
      const thumb = documentRef.createElement('div');
      thumb.className = 'ai-img-preview-thumb';
      if (file.type === 'image') {
        thumb.innerHTML = `
          <img src="${file.data}" alt="Attachment" />
          <button type="button" class="ai-img-remove-btn" title="Remove">×</button>
        `;
      } else {
        thumb.innerHTML = `
          <div class="ai-file-thumb">📄</div>
          <span class="ai-file-name">${file.name}</span>
          <button type="button" class="ai-img-remove-btn" title="Remove">×</button>
        `;
      }
      thumb
        .querySelector('.ai-img-remove-btn')
        ?.addEventListener('click', () => {
          attachedFiles.splice(index, 1);
          renderFilePreviews();
        });
      previewBar.appendChild(thumb);
    });
  }

  imageAttachBtn?.addEventListener('click', () => fileInput?.click());

  fileInput?.addEventListener('change', () => {
    const files = Array.from(fileInput.files || []);
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const dataUrl = e.target?.result;
          if (dataUrl && typeof dataUrl === 'string') {
            attachedFiles.push({
              type: 'image',
              data: dataUrl,
              name: file.name,
            });
            renderFilePreviews();
          }
        };
        reader.readAsDataURL(file);
      } else {
        const reader = new FileReader();
        reader.onload = (e) => {
          const text = e.target?.result;
          if (text && typeof text === 'string') {
            attachedFiles.push({ type: 'text', data: text, name: file.name });
            renderFilePreviews();
          }
        };
        reader.readAsText(file);
      }
    }
    fileInput.value = '';
  });

  // Handle paste for screenshots / images
  panel.addEventListener('paste', (event) => {
    const items = event.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.indexOf('image') !== -1) {
        const file = item.getAsFile();
        if (file) {
          const reader = new FileReader();
          reader.onload = (e) => {
            const dataUrl = e.target?.result;
            if (dataUrl && typeof dataUrl === 'string') {
              attachedFiles.push({
                type: 'image',
                data: dataUrl,
                name: 'pasted_image',
              });
              renderFilePreviews();
            }
          };
          reader.readAsDataURL(file);
        }
      }
    }
  });

  // Unified Speech & Voice Control Integration
  let recognition = null;
  const SpeechRec =
    globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (SpeechRec) {
    try {
      recognition = new SpeechRec();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = voiceSettings?.micLang || 'en-US';

      recognition.onresult = (event) => {
        const transcript = event.results?.[0]?.[0]?.transcript || '';
        if (transcript && inputEl) {
          inputEl.value = inputEl.value
            ? `${inputEl.value} ${transcript}`
            : transcript;
          inputEl.focus();
        }
      };

      recognition.onend = () => {
        if (!getVoiceSession()?.isActive?.()) {
          micBtn?.classList.remove('recording');
        }
      };
    } catch {}
  }

  const getVoiceSession = () =>
    globalThis.window?.__gevVoiceSession ||
    globalThis.window?.__godsEyeView?.voiceCommands?.session ||
    globalThis.window?.__gevVoiceCommands?.session ||
    null;

  let lastVoiceUserText = '';
  let lastVoiceAssistantText = '';

  function handleVoiceEvent(event) {
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'state') {
      const isListening = event.state === 'listening';
      micBtn?.classList.toggle('recording', isListening);
      if (wakewordStatusBadge) {
        wakewordStatusBadge.textContent = event.state.toUpperCase();
        wakewordStatusBadge.classList.toggle('active', isListening);
      }
      if (latencyDisplay) {
        latencyDisplay.textContent = `🎙️ ${event.state}`;
      }
    } else if (event.type === 'transcript') {
      const text = (event.text || '').trim();
      if (!text) return;
      const isUser = event.role === 'user' || event.speaker === 'user';
      if (isUser && (event.final || event.isFinal)) {
        if (text !== lastVoiceUserText) {
          lastVoiceUserText = text;
          if (panel.classList.contains('collapsed')) {
            togglePanel(true);
          }
          appendMessage(
            'user',
            `<div class="ai-msg-voice-tag">🎙️ VOICE COMMAND</div>\n\n${text}`,
          );
        }
      } else if (!isUser && (event.final || event.isFinal)) {
        if (text !== lastVoiceAssistantText) {
          lastVoiceAssistantText = text;
          appendMessage('assistant', text);
        }
      }
    } else if (event.type === 'action-call') {
      const argsStr = event.arguments
        ? Object.entries(event.arguments)
            .map(
              ([k, v]) =>
                `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`,
            )
            .join(', ')
        : '';
      appendMessage(
        'assistant',
        `<div class="ai-tool-card"><div class="ai-tool-card-header">⚡ GLOBE ACTION EXECUTED</div><div class="ai-tool-card-body"><strong>${event.name}</strong>${argsStr ? ` (${argsStr})` : ''}</div></div>`,
      );
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('gev:voice-event', (e) => {
      handleVoiceEvent(e.detail?.event);
    });
  }

  micBtn?.addEventListener('click', () => {
    const session = getVoiceSession();
    if (session) {
      if (session.isActive?.()) {
        session.stop();
        micBtn.classList.remove('recording');
      } else {
        micBtn.classList.add('recording');
        void session.start?.({ pushToTalk: false })?.catch?.(() => {
          micBtn.classList.remove('recording');
        });
      }
      return;
    }
    if (recognition) {
      if (micBtn.classList.contains('recording')) {
        recognition.stop();
        micBtn.classList.remove('recording');
      } else {
        micBtn.classList.add('recording');
        try {
          recognition.start();
        } catch {
          micBtn.classList.remove('recording');
        }
      }
    }
  });

  // Stream toggle
  streamToggle?.addEventListener('click', () => {
    useStreaming = !useStreaming;
    streamToggle.dataset.streaming = String(useStreaming);
    streamToggle.title = useStreaming ? 'Streaming ON' : 'Streaming OFF';
    streamToggle.style.opacity = useStreaming ? '1' : '0.4';
  });

  // Clear chat
  clearBtn?.addEventListener('click', () => {
    messages.length = 0;
    if (messagesContainer) messagesContainer.innerHTML = '';
    appendMessage('assistant', '**Chat cleared.** Ready for new commands.');
    renderQuickPrompts();
  });

  // Full screen toggle
  fullscreenBtn?.addEventListener('click', () => {
    panel.classList.toggle('ai-fullscreen');
    fullscreenBtn.textContent = panel.classList.contains('ai-fullscreen')
      ? '⊡'
      : '⛶';
  });

  // Conversation History
  async function loadHistory() {
    try {
      const res = await fetch(JARVIS_API.sessions);
      if (!res.ok) return;
      const data = await res.json();
      if (!historyList) return;
      historyList.innerHTML = '';
      const sessions = data.sessions || [];
      if (sessions.length === 0) {
        historyList.innerHTML =
          '<div class="ai-history-empty">No saved conversations yet.<br/>Your chats will appear here automatically.</div>';
        return;
      }
      for (const session of sessions) {
        const item = documentRef.createElement('div');
        item.className = 'ai-history-item';
        item.innerHTML = `
          <div class="ai-history-item-info">
            <div class="ai-history-item-title">${(session.title || 'Untitled').replace(/</g, '&lt;')}</div>
            <div class="ai-history-item-meta">${session.mode || 'general'} · ${session.messageCount || 0} msgs</div>
          </div>
          <button type="button" class="ai-history-delete-btn" title="Delete conversation">🗑</button>
        `;
        item.addEventListener('click', (e) => {
          if (e.target.closest('.ai-history-delete-btn')) {
            e.stopPropagation();
            void deleteSessionById(session.id);
            return;
          }
          void loadSessionById(session.id);
        });
        historyList.appendChild(item);
      }
    } catch {
      /* history load is optional */
    }
  }

  // Real-time search filter for history sessions
  historySearchInput?.addEventListener('input', () => {
    const q = (historySearchInput.value || '').toLowerCase().trim();
    const items = historyList?.querySelectorAll('.ai-history-item') || [];
    items.forEach((item) => {
      const text = (item.textContent || '').toLowerCase();
      item.style.display = text.includes(q) ? 'flex' : 'none';
    });
  });

  async function saveCurrentSession() {
    if (messages.length === 0) return;
    try {
      const title =
        messages.find((m) => m.role === 'user')?.content?.slice(0, 50) ||
        'Untitled';
      await fetch(JARVIS_API.sessions, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save',
          sessionId: currentSessionId,
          data: {
            title,
            mode: currentMode,
            messages,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
      });
    } catch {
      /* save failure is non-blocking */
    }
  }

  async function loadSessionById(sessionId) {
    try {
      const res = await fetch(JARVIS_API.sessions, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'load', sessionId }),
      });
      const data = await res.json();
      const session = data.result;
      if (session && session.messages) {
        messages.length = 0;
        if (messagesContainer) messagesContainer.innerHTML = '';
        currentSessionId = sessionId;
        if (session.mode) setMode(session.mode);
        for (const msg of session.messages) {
          messages.push(msg);
          appendMessage(msg.role, msg.content);
        }
      }
    } catch (err) {
      appendMessage(
        'assistant',
        `⚠️ Could not load conversation: ${err.message || err}`,
      );
    } finally {
      switchView('chat');
      isStreaming = false;
      if (sendBtn) sendBtn.disabled = false;
      if (inputEl) {
        inputEl.disabled = false;
        setTimeout(() => inputEl.focus(), 60);
      }
    }
  }

  async function deleteSessionById(sessionId) {
    try {
      await fetch(JARVIS_API.sessions, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', sessionId }),
      });
      void loadHistory();
    } catch {
      /* delete failure is non-blocking */
    }
  }

  historyBtn?.addEventListener('click', () => switchView('history'));
  historyCloseBtn?.addEventListener('click', () => switchView('chat'));
  historyBackBtn?.addEventListener('click', () => switchView('chat'));
  historyNewBtn?.addEventListener('click', () => {
    void saveCurrentSession();
    messages.length = 0;
    if (messagesContainer) messagesContainer.innerHTML = '';
    currentSessionId = `session_${Date.now()}`;
    switchView('chat');
    isStreaming = false;
    if (sendBtn) sendBtn.disabled = false;
    if (inputEl) {
      inputEl.disabled = false;
      setTimeout(() => inputEl.focus(), 60);
    }
    appendMessage(
      'assistant',
      '**New conversation started.** How can JARVIS help?',
    );
    renderQuickPrompts();
  });

  // Phone / Android Connect Modal
  async function showDeviceModal() {
    if (!deviceModal) return;
    try {
      const res = await fetch(JARVIS_API.deviceInfo);
      if (res.ok) {
        const data = await res.json();
        if (deviceQrBox && data.qrSvg) {
          deviceQrBox.innerHTML = data.qrSvg;
        }
        if (deviceUrlInput && data.lanUrl) {
          deviceUrlInput.value = data.lanUrl;
        }
      }
    } catch {
      if (deviceUrlInput && globalThis.location) {
        deviceUrlInput.value = `${globalThis.location.origin}/`;
      }
    }
  }

  phoneBtn?.addEventListener('click', () => switchView('device'));
  deviceCloseBtn?.addEventListener('click', () => switchView('chat'));

  deviceCopyBtn?.addEventListener('click', () => {
    if (deviceUrlInput && deviceUrlInput.value) {
      void navigator.clipboard?.writeText(deviceUrlInput.value);
      deviceCopyBtn.textContent = '✓ Copied';
      setTimeout(() => {
        deviceCopyBtn.textContent = 'Copy';
      }, 1500);
    }
  });

  // Camera capture button for Android / mobile
  cameraBtn?.addEventListener('click', () => cameraInput?.click());
  cameraInput?.addEventListener('change', () => {
    const file = cameraInput.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result;
        if (dataUrl && typeof dataUrl === 'string') {
          attachedFiles.push({
            type: 'image',
            data: dataUrl,
            name: 'camera_capture.jpg',
          });
          renderFilePreviews();
        }
      };
      reader.readAsDataURL(file);
    }
    cameraInput.value = '';
  });

  // AI Image Generation button
  genaiGenerateBtn?.addEventListener('click', async () => {
    const prompt = genaiPromptInput?.value?.trim() || '';
    const negativePrompt = genaiNegativePromptInput?.value?.trim() || '';
    const model =
      genaiModelSelect?.value || 'stabilityai/stable-diffusion-3-medium';
    const aspectRatio = genaiAspectSelect?.value || '1:1';

    if (!prompt) {
      appendMessage('assistant', 'Please enter a prompt to generate an image.');
      return;
    }

    showToolStatus('Generating image...');
    genaiGenerateBtn.disabled = true;
    genaiGenerateBtn.textContent = '⏳ Generating...';

    try {
      const res = await fetch(NVIDIA_API.assistant, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            ...messages.slice(0, -1),
            { role: 'user', content: prompt },
          ],
          mode: currentMode,
          model: model,
          stream: false,
          persona: currentPersona,
          temperature: currentTemperature,
          tools: [
            {
              type: 'function',
              function: {
                name: 'generate_image',
                description:
                  'Generate an AI image or artwork using NVIDIA GenAI models (Stable Diffusion 3 / Flux). Saves image to public assets and returns the web URL.',
                parameters: {
                  type: 'object',
                  properties: {
                    prompt: {
                      type: 'string',
                      description:
                        'Detailed visual prompt describing the image to generate',
                    },
                    aspect_ratio: {
                      type: 'string',
                      enum: ['1:1', '16:9', '9:16', '4:3', '3:2'],
                      description: 'Aspect ratio (default 1:1)',
                    },
                    negative_prompt: {
                      type: 'string',
                      description: 'What to exclude from the image',
                    },
                  },
                  required: ['prompt'],
                },
              },
            },
          ],
          tool_choice: {
            type: 'function',
            function: { name: 'generate_image' },
          },
        }),
      });

      const data = await res.json();
      hideToolStatus();
      genaiGenerateBtn.disabled = false;
      genaiGenerateBtn.textContent = '🎨 Generate';

      if (!res.ok || !data.ok) {
        appendMessage(
          'assistant',
          `⚠️ Image generation failed: ${data.error || 'Unknown error'}`,
        );
        return;
      }

      const toolExecs = data.toolExecutions || [];
      const imageResult = toolExecs.find(
        (exec) => exec.name === 'generate_image',
      );

      if (imageResult && imageResult.result?.imageUrl) {
        // Add to gallery
        const galleryItem = documentRef.createElement('div');
        galleryItem.className = 'ai-genai-gallery-item';
        galleryItem.innerHTML = `
          <div class="ai-genai-preview-wrap">
            <img src="${imageResult.result.imageUrl}" alt="${prompt}" class="ai-genai-preview-img" loading="lazy" />
          </div>
          <div class="ai-genai-meta-bar">
            <span class="ai-genai-model-tag">🎨 ${imageResult.result.model || 'Generated'}</span>
            <a href="${imageResult.result.imageUrl}" download="${imageResult.result.filename || 'jarvis-generated.png'}" target="_blank" class="ai-genai-download-btn">⬇️ Download Image</a>
          </div>
        `;

        // Add download handler
        const downloadBtn = galleryItem.querySelector('.ai-genai-download-btn');
        if (downloadBtn) {
          downloadBtn.addEventListener('click', (e) => {
            e.target.textContent = '✓ Downloading...';
            setTimeout(() => {
              e.target.textContent = '⬇️ Download Image';
            }, 1500);
          });
        }

        genaiGallery.insertBefore(galleryItem, genaiGallery.firstChild);
        genaiGallery.querySelector('.ai-genai-empty')?.classList.add('hidden');

        appendMessage('assistant', `🎨 Generated image: "${prompt}"`, {
          toolExecutions: [
            {
              name: 'generate_image',
              args: {
                prompt,
                negative_prompt: negativePrompt,
                aspect_ratio: aspectRatio,
                model,
              },
              result: imageResult.result,
              iteration: 1,
            },
          ],
        });

        // Clear prompt for next generation
        genaiPromptInput.value = '';
        genaiNegativePromptInput.value = '';
      } else {
        appendMessage(
          'assistant',
          '⚠️ Image generation completed but no image was returned.',
        );
      }
    } catch (err) {
      hideToolStatus();
      genaiGenerateBtn.disabled = false;
      genaiGenerateBtn.textContent = '🎨 Generate';
      appendMessage(
        'assistant',
        `⚠️ Image generation error: ${err.message || err}`,
      );
    }
  });

  // Code block Run & Auto-Debug event delegation
  panel.addEventListener('click', async (e) => {
    const runBtn = e.target.closest('.ai-run-btn');
    if (runBtn) {
      const block = runBtn.closest('.ai-code-block');
      const code = block?.querySelector('code')?.textContent || '';
      const lang =
        block?.querySelector('.ai-code-lang')?.textContent || 'javascript';
      const origText = runBtn.textContent;
      runBtn.textContent = '⏳ Running...';
      try {
        const res = await fetch(JARVIS_API.execute, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool: 'execute_code',
            args: { language: lang, code },
          }),
        });
        const data = await res.json();
        runBtn.textContent = origText;
        appendMessage('assistant', `Execution result for \`${lang}\`:`, {
          toolExecutions: [
            {
              name: 'execute_code',
              args: { language: lang },
              result: data.result,
              iteration: 1,
            },
          ],
        });
      } catch (err) {
        runBtn.textContent = origText;
        appendMessage('assistant', `⚠️ Execution failed: ${err.message}`);
      }
      return;
    }

    const debugBtn = e.target.closest('.ai-debug-btn');
    if (debugBtn) {
      const block = debugBtn.closest('.ai-code-block');
      const code = block?.querySelector('code')?.textContent || '';
      const lang =
        block?.querySelector('.ai-code-lang')?.textContent || 'javascript';
      setMode('code');
      if (inputEl) {
        inputEl.value = `Execute this ${lang} code and run an autonomous debug loop. Inspect errors, fix any bugs or failed checks, and iterate until exit code is 0:\n\`\`\`${lang}\n${code}\n\`\`\``;
        void handleSend();
      }
    }
  });

  // Show/hide tool execution status
  function showToolStatus(text) {
    if (toolStatusEl) toolStatusEl.hidden = false;
    if (toolStatusText) toolStatusText.textContent = text;
  }
  function hideToolStatus() {
    if (toolStatusEl) toolStatusEl.hidden = true;
    if (toolLogEl) toolLogEl.innerHTML = '';
  }

  // SSE Streaming handler
  async function handleStreamingSend(text, currentImages, textFiles) {
    let fullContent = '';
    let reasoningBuffer = '';
    const handle = appendMessage('assistant', '');

    try {
      const userContent =
        textFiles.length > 0
          ? text +
            '\n\n--- Attached Files ---\n' +
            textFiles.map((f) => `[${f.name}]\n${f.data}`).join('\n\n')
          : text;

      const startTime = Date.now();
      const response = await fetch(NVIDIA_API.assistant, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            ...messages.slice(0, -1),
            { role: 'user', content: userContent },
          ],
          mode: currentMode,
          model: activeModel,
          images: currentImages,
          webSearch: currentMode === 'research',
          context: globeContextFn(),
          stream: true,
          persona: currentPersona,
          temperature: currentTemperature,
        }),
        signal: currentAbortController?.signal,
      });

      if (latencyDisplay) {
        latencyDisplay.textContent = `⚡ ${Date.now() - startTime}ms`;
      }
      void updateMemoryCount();

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        handle.contentDiv.innerHTML = formatMarkdown(
          `⚠️ ${errData.error || 'Stream failed'}`,
        );
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') break;

          try {
            const parsed = JSON.parse(payload);
            if (parsed.error) {
              fullContent += `\n\n⚠️ ${parsed.error}`;
              handle.contentDiv.innerHTML = formatMarkdown(fullContent);
              break;
            }
            if (parsed.meta) {
              if (parsed.meta.routedModel && handle?.headerDiv) {
                const shortRouted = (
                  parsed.meta.routedModel.split('/').pop() ||
                  parsed.meta.routedModel
                ).replace(/-instruct|-it/g, '');
                const badge = documentRef.createElement('span');
                badge.className = 'ai-msg-routed-badge';
                badge.title =
                  parsed.meta.routedMeta?.reason ||
                  `Dynamically routed to ${parsed.meta.routedModel}`;
                badge.textContent = `🎯 ${shortRouted}`;
                handle.headerDiv.appendChild(badge);
              }
              if (
                Array.isArray(parsed.meta.council) &&
                parsed.meta.council.length > 0 &&
                handle?.bubble
              ) {
                const councilBox = documentRef.createElement('details');
                councilBox.className = 'ai-council-box';
                const councilPills = parsed.meta.council
                  .map(
                    (c) =>
                      `<span class="ai-council-tag">${c.name || c.model?.split('/').pop() || 'Model'}</span>`,
                  )
                  .join('');
                const cardsHtml = parsed.meta.council
                  .map(
                    (c) => `
                  <div class="ai-council-card">
                    <div class="ai-council-card-header">
                      <span class="ai-council-card-model">🤖 ${c.name || c.model?.split('/').pop() || 'Specialist'}</span>
                      <span class="ai-council-card-role">${c.role || 'Deliberator'}</span>
                    </div>
                    <div class="ai-council-card-content">${formatMarkdown(c.content || '(no content)')}</div>
                  </div>
                `,
                  )
                  .join('');
                councilBox.innerHTML = `
                  <summary class="ai-council-summary">
                    <span class="ai-council-title">👥 JARVIS Council Deliberation (${parsed.meta.council.length} Models)</span>
                    <span class="ai-council-models-preview">${councilPills}</span>
                  </summary>
                  <div class="ai-council-body">
                    ${cardsHtml}
                  </div>
                `;
                if (handle.contentDiv) {
                  handle.bubble.insertBefore(councilBox, handle.contentDiv);
                } else {
                  handle.bubble.appendChild(councilBox);
                }
              }
              continue;
            }
            const deltaReasoning =
              parsed.choices?.[0]?.delta?.reasoning_content ||
              parsed.choices?.[0]?.delta?.reasoning ||
              '';
            if (deltaReasoning) {
              reasoningBuffer += deltaReasoning;
              handle.updateThinking?.(reasoningBuffer);
            }

            const delta = parsed.choices?.[0]?.delta?.content || '';
            if (delta) {
              fullContent += delta;
              const { content: cleanStream, reasoning: streamReasoning } =
                extractThinking(fullContent);
              if (streamReasoning) {
                reasoningBuffer =
                  (reasoningBuffer ? reasoningBuffer + '\n\n' : '') +
                  streamReasoning;
                handle.updateThinking?.(reasoningBuffer);
              }
              handle.contentDiv.innerHTML = formatMarkdown(
                cleanStream ||
                  (reasoningBuffer ? '_Formulating tactical response..._' : ''),
              );
              const dist =
                messagesContainer.scrollHeight -
                messagesContainer.scrollTop -
                messagesContainer.clientHeight;
              if (dist <= 140) {
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
              } else {
                if (scrollNavigator) scrollNavigator.hidden = false;
                if (scrollUnreadBadge) scrollUnreadBadge.hidden = false;
              }
            }
          } catch {
            /* skip malformed chunks */
          }
        }
      }

      const { content: cleanFinal, reasoning: finalExtraReasoning } =
        extractThinking(fullContent);
      if (finalExtraReasoning) {
        reasoningBuffer =
          (reasoningBuffer ? reasoningBuffer + '\n\n' : '') +
          finalExtraReasoning;
        handle.updateThinking?.(reasoningBuffer);
      }
      const finalDisplay =
        cleanFinal || (fullContent ? fullContent : 'Response completed.');
      handle.contentDiv.innerHTML = formatMarkdown(finalDisplay);
      messages.push({ role: 'assistant', content: finalDisplay });

      // Connect copy and speak actions for the streamed response
      const copyBtn = handle.bubble?.querySelector?.('.ai-msg-copy-btn');
      if (copyBtn) {
        copyBtn.onclick = async (e) => {
          try {
            await navigator.clipboard?.writeText(fullContent);
            e.target.textContent = '✓ Copied';
            setTimeout(() => {
              e.target.textContent = '📋 Copy';
            }, 1500);
          } catch {}
        };
      }
      const speakBtn = handle.bubble?.querySelector?.('.ai-msg-speak-btn');
      if (speakBtn) {
        speakBtn.onclick = () => speakText(fullContent);
      }
      if (autoSpeak && fullContent) {
        speakText(fullContent);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        fullContent += '\n\n*(Generation stopped by operator)*';
        handle.contentDiv.innerHTML = formatMarkdown(fullContent);
        if (fullContent.trim()) {
          messages.push({ role: 'assistant', content: fullContent });
        }
        return;
      }
      handle.contentDiv.innerHTML = formatMarkdown(
        `⚠️ Stream error: ${err.message}`,
      );
    }
  }

  // Send message
  async function handleSend() {
    if (isStreaming) {
      currentAbortController?.abort();
      return;
    }
    if (!inputEl) return;
    const text = inputEl.value.trim();
    if (!text && attachedFiles.length === 0) return;

    inputEl.value = '';
    const currentImages = attachedFiles
      .filter((f) => f.type === 'image')
      .map((f) => f.data);
    const textFiles = attachedFiles.filter((f) => f.type === 'text');
    attachedFiles.length = 0;
    renderFilePreviews();

    appendMessage('user', text);
    messages.push({ role: 'user', content: text });

    const lower = text.toLowerCase();

    // 1. Drone Recon command
    if (
      lower.startsWith('/drone') ||
      lower.startsWith('drone recon') ||
      lower.startsWith('fly recon') ||
      lower.includes('recon orbit')
    ) {
      const target =
        text
          .replace(
            /^\/drone\s*|^(?:fly\s+)?drone\s+recon\s*(?:over|around|on)?\s*|^recon\s+orbit\s*(?:over|around|on)?\s*/i,
            '',
          )
          .trim() || 'Current Target';
      await droneRecon.startRecon({ targetName: target });
      return;
    }

    // 2. Stop Recon command
    if (
      lower === '/stoprecon' ||
      lower === 'stop recon' ||
      lower === 'abort recon'
    ) {
      droneRecon.stop();
      return;
    }

    // 3. CCTV Grid command
    if (
      lower === '/cctv' ||
      lower.startsWith('/cctv') ||
      lower === 'cctv grid' ||
      lower.includes('show cctv grid') ||
      lower.includes('surveillance grid')
    ) {
      const sampleFeeds = [
        {
          id: 'cctv_tokyo_1',
          name: 'Shinjuku Crossing West',
          agency: 'Tokyo Metro Police',
          city: 'Tokyo',
          imageUrl:
            'https://images.unsplash.com/photo-1503899036084-c55cdd92da26?w=600&auto=format&fit=crop&q=60',
          longitude: 139.7005,
          latitude: 35.6896,
        },
        {
          id: 'cctv_paris_1',
          name: 'Champs-Élysées Central',
          agency: 'Préfecture de Police',
          city: 'Paris',
          imageUrl:
            'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=600&auto=format&fit=crop&q=60',
          longitude: 2.3075,
          latitude: 48.8698,
        },
        {
          id: 'cctv_london_1',
          name: 'Trafalgar Square North',
          agency: 'TfL Surveillance',
          city: 'London',
          imageUrl:
            'https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?w=600&auto=format&fit=crop&q=60',
          longitude: -0.1281,
          latitude: 51.508,
        },
        {
          id: 'cctv_ny_1',
          name: 'Times Square Tower Cam',
          agency: 'NYPD Recon',
          city: 'New York',
          imageUrl:
            'https://images.unsplash.com/photo-1538688525198-9b88f6f53126?w=600&auto=format&fit=crop&q=60',
          longitude: -73.9855,
          latitude: 40.758,
        },
      ];

      for (const feed of sampleFeeds) {
        cctvGrid.addFeed(feed);
      }
      appendMessage(
        'assistant',
        '🎛️ **SURVEILLANCE GRID DEPLOYED**: Pinned 4 live tactical feeds into the floating Picture-in-Picture wall. Click 🎯 on any camera card to immediately fly to its location on the 3D globe.',
      );
      return;
    }

    // 4. Clear Plot command
    if (
      lower === '/clearplot' ||
      lower === 'clear plot' ||
      lower === 'clear datasets'
    ) {
      geoPlotter.clearAll();
      return;
    }

    // 5. Scan Threats command
    if (
      lower === '/scan' ||
      lower === 'scan threats' ||
      lower.includes('threat scan') ||
      lower.includes('scan anomalies')
    ) {
      threatScanner.scanNow();
      appendMessage(
        'assistant',
        '⚠️ **TACTICAL SCAN COMPLETE**: Scanned all active airspace ADS-B squawk transponders and seismic monitors. Active threat alerts rendered on HUD.',
      );
      return;
    }

    isStreaming = true;
    currentAbortController = new AbortController();
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.innerHTML = '<span>⏹</span> STOP';
      sendBtn.classList.add('ai-send-btn-stop');
    }

    // Show visual typing indicator
    const typingIndicator = documentRef.createElement('div');
    typingIndicator.className = 'ai-msg assistant typing';
    typingIndicator.innerHTML = `
      <div class="ai-msg-bubble">
        <span class="ai-typing-dots"><span></span><span></span><span></span></span>
        <span>${currentMode === 'globe' ? 'Executing globe commands...' : currentMode === 'code' ? 'Writing & executing code...' : currentMode === 'auto' ? 'Running workflow...' : activeModel === 'ensemble' || activeModel === 'council' || activeModel === 'swarm' || activeModel === 'auto' ? '⚡ Omni-Provider Swarm deliberating simultaneously across all models...' : 'JARVIS thinking...'}</span>
      </div>
    `;
    messagesContainer?.appendChild(typingIndicator);
    if (messagesContainer)
      messagesContainer.scrollTop = messagesContainer.scrollHeight;

    try {
      const isGlobeAction = currentMode === 'globe' || isGlobePrompt(text);
      if (isGlobeAction) {
        // Route to globe control endpoint (/api/nvidia/chat) which contains full GEV action tools
        const response = await fetch(NVIDIA_API.chat, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages,
            model: activeModel,
            context: globeContextFn(),
          }),
          signal: currentAbortController?.signal,
        });

        const data = await response.json();
        typingIndicator.remove();

        if (!response.ok || !data.ok) {
          appendMessage(
            'assistant',
            `⚠️ Error: ${data.error || 'Globe action failed'}`,
          );
        } else {
          const toolCalls = data.message?.tool_calls || [];
          if (toolCalls.length > 0) {
            for (const call of toolCalls) {
              const name = call.function?.name;
              let args = {};
              try {
                args =
                  typeof call.function?.arguments === 'string'
                    ? JSON.parse(call.function.arguments || '{}')
                    : call.function?.arguments || {};
              } catch {}
              await globeActionFn(name, args);
            }

            const actionSummaries = toolCalls
              .map((t) => {
                const name = t.function?.name;
                let args = {};
                try {
                  args =
                    typeof t.function?.arguments === 'string'
                      ? JSON.parse(t.function.arguments || '{}')
                      : t.function?.arguments || {};
                } catch {}
                if (name === 'fly_to_location') {
                  const target =
                    args.query ||
                    (args.locationId
                      ? args.locationId.toUpperCase()
                      : 'coordinates');
                  return `✈️ **Camera Vector**: Inbound to **${target}**`;
                }
                if (name === 'zoom_camera') {
                  return `🔍 **Camera Altitude**: Zoom adjusted (${args.direction || 'active'})`;
                }
                if (name === 'tilt_camera') {
                  return `📐 **Camera Pitch**: ${args.pitch !== undefined ? `${args.pitch}°` : 'adjusted'}`;
                }
                if (name === 'orbit_camera') {
                  return `🔄 **Orbital Tracking**: Active around target`;
                }
                if (name === 'toggle_layer') {
                  return `🗺️ **Layer Status**: \`${args.layerId}\` ${args.enable ? 'activated' : 'deactivated'}`;
                }
                if (name === 'toggle_gestures') {
                  return `👋 **Touchless Gestures**: ${args.enable ? 'online' : 'standby'}`;
                }
                if (name === 'set_time_of_day') {
                  return `☀️ **Lighting / Solar**: Set to ${args.time || args.hour || 'target phase'}`;
                }
                return `⚡ **Action Executed**: \`${name}\``;
              })
              .join('\n- ');

            const defaultText = `### 🛰️ Tactical Globe Directive Executed\n- ${actionSummaries}\n\n*Camera guidance and geospatial layers updated in real time.*`;
            const contentToDisplay =
              data.message?.content?.trim() || defaultText;
            appendMessage('assistant', contentToDisplay);
            messages.push({ role: 'assistant', content: contentToDisplay });
          } else if (data.message?.content) {
            appendMessage('assistant', data.message.content);
            messages.push({ role: 'assistant', content: data.message.content });
          }
        }
      } else if (
        useStreaming &&
        currentMode !== 'code' &&
        currentMode !== 'auto' &&
        activeModel !== 'stabilityai/stable-diffusion-3-medium' &&
        !/\b(generate (an? )?image|create (an? )?image|draw|paint|sketch|artwork|picture of)\b/i.test(
          text,
        )
      ) {
        // Use SSE streaming for chat-like modes
        typingIndicator.remove();
        await handleStreamingSend(text, currentImages, textFiles);
      } else {
        // Non-streaming: supports full tool execution loops
        showToolStatus('JARVIS executing...');

        const userContent =
          textFiles.length > 0
            ? text +
              '\n\n--- Attached Files ---\n' +
              textFiles.map((f) => `[${f.name}]\n${f.data}`).join('\n\n')
            : text;

        const startTime = Date.now();
        const response = await fetch(NVIDIA_API.assistant, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [
              ...messages.slice(0, -1),
              { role: 'user', content: userContent },
            ],
            mode: currentMode,
            model: activeModel,
            images: currentImages,
            webSearch: currentMode === 'research',
            context: globeContextFn(),
            stream: false,
            persona: currentPersona,
            temperature: currentTemperature,
          }),
          signal: currentAbortController?.signal,
        });

        const data = await response.json();
        typingIndicator.remove();
        hideToolStatus();

        if (latencyDisplay) {
          latencyDisplay.textContent = `⚡ ${Date.now() - startTime}ms`;
        }
        void updateMemoryCount();

        if (!response.ok || !data.ok) {
          appendMessage(
            'assistant',
            `⚠️ ${data.error || 'Assistant service unavailable'}`,
          );
        } else {
          let reply = data.message?.content || 'Task completed.';
          let reasoning = data.message?.reasoning || null;
          const toolExecs = data.toolExecutions || [];
          const iters = data.iterations || 1;
          const council = data.council || null;
          const routedModel =
            data.routedMeta?.model ||
            (data.model && data.model !== activeModel ? data.model : null);
          const routedReason = data.routedMeta?.reason || null;

          if (!reasoning && reply.startsWith("Here's a thinking process:")) {
            const parts = reply.split(/\n\n(?=[A-Z#*])/);
            if (parts.length > 1) {
              reasoning = parts[0];
              reply = parts.slice(1).join('\n\n');
            }
          }

          appendMessage('assistant', reply, {
            reasoning,
            toolExecutions: toolExecs,
            iterations: iters,
            council,
            routedModel,
            routedReason,
          });
          messages.push({ role: 'assistant', content: reply });
        }
      }
    } catch (err) {
      typingIndicator.remove();
      hideToolStatus();
      if (err.name === 'AbortError') {
        appendMessage('assistant', '_Operation stopped by user._');
      } else {
        appendMessage('assistant', `⚠️ Network error: ${err.message || err}`);
      }
    } finally {
      typingIndicator.remove();
      hideToolStatus();
      isStreaming = false;
      currentAbortController = null;
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.innerHTML = '<span>⚡</span> SEND';
        sendBtn.classList.remove('ai-send-btn-stop');
      }
      inputEl.focus();

      // Auto-save session every few messages
      if (messages.length % 4 === 0) void saveCurrentSession();
    }
  }

  sendBtn?.addEventListener('click', () => void handleSend());
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  });

  // Global keyboard shortcuts
  globalThis.addEventListener?.('keydown', (e) => {
    // Ctrl+K / Cmd+K: Toggle panel
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      togglePanel();
    }
    // Ctrl+L: Clear chat
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
      if (!panel.classList.contains('collapsed')) {
        e.preventDefault();
        clearBtn?.click();
      }
    }
    // Ctrl+F: In-Chat Search
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      if (!panel.classList.contains('collapsed')) {
        e.preventDefault();
        toggleChatSearch();
      }
    }
    // Ctrl+H: Toggle History
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') {
      if (!panel.classList.contains('collapsed')) {
        e.preventDefault();
        switchView(currentView === 'history' ? 'chat' : 'history');
      }
    }
    // Ctrl+M: Toggle Models View
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') {
      if (!panel.classList.contains('collapsed')) {
        e.preventDefault();
        switchView(currentView === 'models' ? 'chat' : 'models');
      }
    }
    // Ctrl+/: Cycle modes
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      const modes = [
        'general',
        'globe',
        'code',
        'auto',
        'study',
        'tasks',
        'research',
        'memory',
      ];
      const idx = modes.indexOf(currentMode);
      setMode(modes[(idx + 1) % modes.length]);
    }
    // Ctrl+Home / Ctrl+End: Scroll to Top / Bottom
    if ((e.ctrlKey || e.metaKey) && e.key === 'Home') {
      if (!panel.classList.contains('collapsed')) {
        e.preventDefault();
        scrollToTopOfChat(true);
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'End') {
      if (!panel.classList.contains('collapsed')) {
        e.preventDefault();
        scrollToLatestMessage(true);
      }
    }
  });

  // Initial welcome message and quick prompts
  renderQuickPrompts();
  appendMessage(
    'assistant',
    '**JARVIS Online.** Powered by NVIDIA NIM with Host Computer Control. I can execute system commands, manage files, open applications, monitor processes, write & debug code, automate workflows, and handle hands-free voice intercom. What is your mission?',
  );

  // System Telemetry Polling & Action
  async function refreshSystemTelemetry() {
    try {
      const res = await fetch(JARVIS_API.systemInfo);
      if (res.ok) {
        const data = await res.json();
        if (data.ok && data.info) {
          const memPct = data.info.memory?.usedPercent ?? '--';
          if (telemetryText) {
            telemetryText.textContent = `RAM: ${memPct}% · CPU: ${data.info.cpu?.cores || 0}C`;
          }
          return data.info;
        }
      }
    } catch {}
    return null;
  }

  void refreshSystemTelemetry();
  const telemetryInterval = setInterval(() => {
    void refreshSystemTelemetry();
  }, 30000);
  telemetryInterval?.unref?.();

  // Host System Automation & Diagnostics Controller
  async function refreshDiagnosticsWidget() {
    try {
      const res = await fetch(JARVIS_API.diagnostics);
      if (!res.ok) return;
      const data = await res.json();
      const diag = data.diagnostics;
      if (!diag) return;

      const badge = panel.querySelector('#ai-sys-health-badge');
      if (badge) {
        badge.textContent = `${diag.grade} · ${diag.status}`;
        badge.style.color =
          diag.healthScore >= 80
            ? '#00ffaa'
            : diag.healthScore >= 60
              ? '#ffaa00'
              : '#ff4444';
      }
      const cpuVal = panel.querySelector('#ai-sys-cpu-val');
      if (cpuVal) cpuVal.textContent = `${diag.cpu?.cores || 0} Cores`;

      const ramVal = panel.querySelector('#ai-sys-ram-val');
      if (ramVal) {
        ramVal.textContent = `${diag.memory?.usedFormatted || '--'} (${diag.memory?.usedPercent || 0}%)`;
      }

      const uptimeVal = panel.querySelector('#ai-sys-uptime-val');
      if (uptimeVal) uptimeVal.textContent = diag.uptime || '--';

      const pingVal = panel.querySelector('#ai-sys-ping-val');
      if (pingVal) pingVal.textContent = 'Probing...';

      const storageList = panel.querySelector('#ai-sys-storage-list');
      if (storageList && diag.disks) {
        storageList.innerHTML = diag.disks
          .map(
            (d) => `
          <div class="ai-sys-disk-row">
            <span>${d.drive}</span>
            <div class="ai-sys-disk-bar">
              <div class="ai-sys-disk-fill" style="width: ${d.usedPercent}%;"></div>
            </div>
            <span>${d.usedFormatted} / ${d.totalFormatted}</span>
          </div>
        `,
          )
          .join('');
      }

      void fetch(JARVIS_API.execute, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'ping_host', args: { host: '8.8.8.8' } }),
      })
        .then((r) => r.json())
        .then((pData) => {
          if (pingVal && pData.result) {
            pingVal.textContent = pData.result.latencyMs
              ? `${pData.result.latencyMs}ms`
              : pData.result.reachable
                ? 'Online'
                : 'Offline';
          }
        })
        .catch(() => {
          if (pingVal) pingVal.textContent = 'Offline';
        });
    } catch {}
  }

  async function refreshWindowsWidget() {
    const listEl = panel.querySelector('#ai-sys-windows-list');
    if (!listEl) return;
    try {
      const res = await fetch(JARVIS_API.windows);
      if (!res.ok) return;
      const data = await res.json();
      const wins = data.windows || [];
      if (wins.length === 0) {
        listEl.innerHTML =
          '<div class="ai-sys-empty">No visible open application windows.</div>';
        return;
      }
      listEl.innerHTML = wins
        .map(
          (w) => `
        <div class="ai-sys-window-row">
          <div class="ai-sys-window-info" title="${(w.title || '').replace(/"/g, '&quot;')}">
            <strong>${(w.process || '').replace(/</g, '&lt;')}</strong> · ${(w.title || '').slice(0, 30).replace(/</g, '&lt;')}
          </div>
          <div class="ai-sys-window-actions">
            <button type="button" class="ai-sys-window-btn ai-sys-focus-win-btn" data-pid="${w.pid}">Focus</button>
            <button type="button" class="ai-sys-window-btn ai-sys-close-win-btn" data-pid="${w.pid}">Close</button>
          </div>
        </div>
      `,
        )
        .join('');
    } catch {
      listEl.innerHTML =
        '<div class="ai-sys-empty">Could not load windows.</div>';
    }
  }

  async function refreshTasksWidget() {
    const listEl = panel.querySelector('#ai-sys-tasks-list');
    if (!listEl) return;
    try {
      const res = await fetch(JARVIS_API.schedules);
      if (!res.ok) return;
      const data = await res.json();
      const tasks = data.tasks || [];
      if (tasks.length === 0) {
        listEl.innerHTML =
          '<div class="ai-sys-empty">No active schedules or timers.</div>';
        return;
      }
      listEl.innerHTML = tasks
        .map(
          (t) => `
        <div class="ai-sys-task-row">
          <div class="ai-sys-window-info">
            <strong>${(t.name || 'Task').replace(/</g, '&lt;')}</strong> · [${t.status}] ${t.delaySeconds ? `${t.delaySeconds}s` : ''}${t.intervalSeconds ? ` every ${t.intervalSeconds}s` : ''}
          </div>
          <div class="ai-sys-task-actions">
            <button type="button" class="ai-sys-window-btn ai-sys-close-win-btn ai-sys-cancel-task-btn" data-task-id="${t.id}">Cancel</button>
          </div>
        </div>
      `,
        )
        .join('');
    } catch {
      listEl.innerHTML =
        '<div class="ai-sys-empty">Could not load tasks.</div>';
    }
  }

  async function refreshSystemView() {
    await Promise.all([
      refreshDiagnosticsWidget(),
      refreshWindowsWidget(),
      refreshTasksWidget(),
    ]);
  }

  systemCloseBtn?.addEventListener('click', () => switchView('chat'));
  telemetryChip?.addEventListener('click', () => switchView('system'));
  genaiCloseBtn?.addEventListener('click', () => switchView('chat'));
  genaiBackBtn?.addEventListener('click', () => switchView('chat'));

  // System Drawer quick actions
  panel
    .querySelector('.ai-sys-quick-actions')
    ?.addEventListener('click', async (e) => {
      const btn = e.target.closest('.ai-sys-action-btn');
      if (!btn) return;
      const action = btn.dataset.sysAction;
      btn.style.opacity = '0.5';

      try {
        if (action === 'screenshot') {
          const res = await fetch(JARVIS_API.execute, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool: 'take_screenshot', args: {} }),
          });
          const data = await res.json();
          if (data.result?.url) {
            switchView('chat');
            appendMessage(
              'assistant',
              `📸 Captured full desktop screenshot: [${data.result.filename}](${data.result.url})`,
              {
                toolExecutions: [
                  {
                    name: 'take_screenshot',
                    args: {},
                    result: data.result,
                    iteration: 1,
                  },
                ],
              },
            );
          }
        } else if (action === 'diagnose') {
          await refreshDiagnosticsWidget();
        } else if (action === 'clean') {
          const res = await fetch(JARVIS_API.execute, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool: 'clean_temp_files', args: {} }),
          });
          const data = await res.json();
          alert(data.result?.message || 'Cleaned temp files.');
          await refreshDiagnosticsWidget();
        } else if (action === 'mute') {
          await fetch(JARVIS_API.execute, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tool: 'control_media_volume',
              args: { action: 'mute' },
            }),
          });
        } else if (action === 'refresh') {
          await refreshSystemView();
        }
      } catch {}

      btn.style.opacity = '1';
    });

  // Windows tray actions delegation
  panel
    .querySelector('#ai-sys-windows-list')
    ?.addEventListener('click', async (e) => {
      const focusBtn = e.target.closest('.ai-sys-focus-win-btn');
      if (focusBtn) {
        const pid = focusBtn.dataset.pid;
        await fetch(JARVIS_API.execute, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool: 'focus_window',
            args: { identifier: pid },
          }),
        });
        return;
      }
      const closeBtn = e.target.closest('.ai-sys-close-win-btn');
      if (closeBtn) {
        const pid = closeBtn.dataset.pid;
        await fetch(JARVIS_API.execute, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool: 'close_window',
            args: { identifier: pid },
          }),
        });
        setTimeout(() => void refreshWindowsWidget(), 500);
      }
    });

  // Task scheduler actions
  panel
    .querySelector('#ai-refresh-windows-btn')
    ?.addEventListener('click', () => {
      void refreshWindowsWidget();
    });

  const addTaskBtn = panel.querySelector('#ai-add-task-btn');
  const addTaskForm = panel.querySelector('#ai-sys-add-task-form');
  const cancelTaskFormBtn = panel.querySelector('#ai-cancel-task-form-btn');
  const submitTaskBtn = panel.querySelector('#ai-submit-task-btn');

  addTaskBtn?.addEventListener('click', () => {
    if (addTaskForm) addTaskForm.hidden = !addTaskForm.hidden;
  });
  cancelTaskFormBtn?.addEventListener('click', () => {
    if (addTaskForm) addTaskForm.hidden = true;
  });

  submitTaskBtn?.addEventListener('click', async () => {
    const nameInput = panel.querySelector('#ai-task-name-input');
    const delayInput = panel.querySelector('#ai-task-delay-input');
    const msgInput = panel.querySelector('#ai-task-msg-input');

    const name = nameInput?.value?.trim() || 'Scheduled Reminder';
    const delaySeconds = Number(delayInput?.value) || 60;
    const message =
      msgInput?.value?.trim() || 'JARVIS scheduled alarm triggered!';

    try {
      await fetch(JARVIS_API.schedules, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, delaySeconds, message }),
      });
      if (addTaskForm) addTaskForm.hidden = true;
      if (nameInput) nameInput.value = '';
      if (msgInput) msgInput.value = '';
      await refreshTasksWidget();
    } catch {}
  });

  panel
    .querySelector('#ai-sys-tasks-list')
    ?.addEventListener('click', async (e) => {
      const cancelBtn = e.target.closest('.ai-sys-cancel-task-btn');
      if (cancelBtn) {
        const taskId = cancelBtn.dataset.taskId;
        await fetch(JARVIS_API.schedules, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cancel', taskId }),
        });
        await refreshTasksWidget();
      }
    });

  function appendVoiceExchange(userSpeech, aiResponse) {
    if (!userSpeech && !aiResponse) return;
    if (userSpeech) {
      appendMessage('user', `🎙️ **VOICE:** ${userSpeech}`);
      messages.push({ role: 'user', content: userSpeech });
    }
    if (aiResponse) {
      appendMessage('assistant', aiResponse);
      messages.push({ role: 'assistant', content: aiResponse });
    }
  }

  Object.assign(controller, {
    toggle: togglePanel,
    setMode,
    switchView,
    switchModel: (model, notify = false) => switchModel(model, notify),
    getModel: () => activeModel,
    appendMessage,
    appendVoiceExchange,
    toggleSearch: toggleChatSearch,
    scrollToBottom: scrollToLatestMessage,
    scrollToTop: scrollToTopOfChat,
    getView: () => currentView,
    sendMessage: (text) => {
      if (inputEl) inputEl.value = text;
      void handleSend();
    },
    updateGlobeCallbacks: ({ getGlobeContext: g, executeGlobeAction: a }) => {
      if (typeof g === 'function') globeContextFn = g;
      if (typeof a === 'function') globeActionFn = a;
    },
    unlock: unlockAndResetChat,
    speak: speakText,
    getVoiceSettings: () => ({ ...voiceSettings }),
    setVoiceSettings: (newSettings) => {
      Object.assign(voiceSettings, newSettings);
      saveVoiceSettings();
    },
    /**
     * Branch the conversation at a given message element. Marks the message
     * as a branch point, clears subsequent messages, and lets the operator
     * continue from that turn without losing the prefix.
     */
    branchConversation: (messageEl) => {
      if (!messageEl) return;
      const index = messagesContainer?.children
        ? Array.from(messagesContainer.children).indexOf(messageEl)
        : -1;
      if (index < 0) return;
      // Keep messages up to and including the branch point
      const branchAt = Math.max(0, index);
      const kept = messages.slice(0, branchAt + 1);
      // Remove DOM siblings after the branch point
      while (messagesContainer.children.length > branchAt + 1) {
        messagesContainer.children[branchAt + 1].remove();
      }
      messageEl.classList.add('ai-branch-point');
      messages.length = 0;
      messages.push(...kept);
      playAudioCue('data');
    },
    droneRecon,
    cctvGrid,
    geoPlotter,
    threatScanner,
    toggleWakeWord,
    isWakeWordActive: () => wakeWordActive,
    playAudioCue,
    requestTacticalSitrep: () => {
      const prompt =
        'Tactical SITREP: Summarize current airspace, maritime traffic, and active threats in view.';
      if (inputEl) {
        inputEl.value = prompt;
        void handleSend();
      }
      playAudioCue('recon');
    },
    toggleVoice: () => {
      micBtn?.click();
    },
    confirmPendingAction: () => {
      playAudioCue('data');
    },
    dismissCurrentAction: () => {
      if (currentAbortController) {
        currentAbortController.abort();
      }
      playAudioCue('comm');
    },
  });
  panel._aiCommandController = controller;
  if (typeof globalThis !== 'undefined') {
    globalThis.__gevAiCommandCenter = controller;
  }
  return controller;
}
