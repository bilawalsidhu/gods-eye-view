import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMarkdown, extractThinking, initAiCommandCenter, detectTextLanguage, selectBestVoice, playAudioCue, isGlobePrompt } from './aiCommandCenter.js';

test('isGlobePrompt accurately identifies 3D globe, flight, camera and landmark queries', () => {
  assert.equal(isGlobePrompt('Fly to Tokyo Tower'), true);
  assert.equal(isGlobePrompt('Take me to Paris'), true);
  assert.equal(isGlobePrompt('Zoom in on the target'), true);
  assert.equal(isGlobePrompt('Show satellites in orbit'), true);
  assert.equal(isGlobePrompt('Tilt camera 45 degrees'), true);
  assert.equal(isGlobePrompt('What is the capital of France?'), false);
  assert.equal(isGlobePrompt('Write a javascript function to sort an array'), false);
});

test('extractThinking cleanly separates <think> tags from output', () => {
  const raw =
    '<think>Checking satellite telemetry for ISS</think>### Orbit Confirmed\nISS altitude is 418km.';
  const res = extractThinking(raw);
  assert.equal(res.reasoning, 'Checking satellite telemetry for ISS');
  assert.equal(res.content, '### Orbit Confirmed\nISS altitude is 418km.');

  // Also support <thought> and <reasoning> tags from various reasoning model formats
  const rawThought =
    '<thought>Deep chain of thought evaluation</thought>Target solution verified.';
  const resThought = extractThinking(rawThought);
  assert.equal(resThought.reasoning, 'Deep chain of thought evaluation');
  assert.equal(resThought.content, 'Target solution verified.');

  const rawReasoning =
    '<reasoning>Analyzing geodetic parameters</reasoning>Bearing is 045 degrees.';
  const resReasoning = extractThinking(rawReasoning);
  assert.equal(resReasoning.reasoning, 'Analyzing geodetic parameters');
  assert.equal(resReasoning.content, 'Bearing is 045 degrees.');
});

test('formatMarkdown converts markdown tables to structured html', () => {
  const md = '| Column A | Column B |\n|---|---|\n| Data 1 | Data 2 |';
  const html = formatMarkdown(md);
  assert.ok(html.includes('<table class="ai-table">'));
  assert.ok(html.includes('<th>Column A</th>'));
  assert.ok(html.includes('<td>Data 1</td>'));
});

test('formatMarkdown hides <think> traces by default', () => {
  const md = '<think>Internal deliberation</think>Operational summary ready.';
  const html = formatMarkdown(md);
  assert.ok(!html.includes('Internal deliberation'));
  assert.ok(html.includes('Operational summary ready.'));
});

test('formatMarkdown converts markdown tags safely to html', () => {
  const md = '**Bold text** and *italic* and `code`';
  const html = formatMarkdown(md);
  assert.ok(html.includes('<strong>Bold text</strong>'));
  assert.ok(html.includes('<em>italic</em>'));
  assert.ok(html.includes('<code>code</code>'));
});

test('formatMarkdown handles multiline code blocks', () => {
  const md = '```javascript\nconsole.log(42);\n```';
  const html = formatMarkdown(md);
  assert.ok(html.includes('ai-code-block'));
  assert.ok(html.includes('console.log(42);'));
});

test('formatMarkdown escapes html tags', () => {
  const md = '<script>alert(1)</script>';
  const html = formatMarkdown(md);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('initAiCommandCenter returns null when container is missing', () => {
  const result = initAiCommandCenter({
    containerId: 'non-existent-panel',
    documentRef: { getElementById: () => null },
  });
  assert.equal(result, null);
});

test('initAiCommandCenter initializes panel and exposes toggle and setMode', () => {
  const elements = new Map();
  const mockClassList = new Set(['panel-collapsible', 'collapsed']);
  let collapseClickCount = 0;

  const mockCollapseBtn = {
    textContent: '+',
    click: () => {
      collapseClickCount++;
      if (mockClassList.has('collapsed')) {
        mockClassList.delete('collapsed');
      } else {
        mockClassList.add('collapsed');
      }
    },
    setAttribute: () => {},
  };

  const mockPanel = {
    id: 'ai-command-panel',
    classList: {
      contains: (cls) => mockClassList.has(cls),
      toggle: (cls, force) => {
        if (force === undefined) {
          if (mockClassList.has(cls)) mockClassList.delete(cls);
          else mockClassList.add(cls);
        } else if (force) {
          mockClassList.add(cls);
        } else {
          mockClassList.delete(cls);
        }
      },
    },
    querySelector: (sel) => {
      if (sel === '.panel-collapse-btn') return mockCollapseBtn;
      if (sel === '.ai-panel-header') return { addEventListener: () => {} };
      if (sel === '.ai-active-model-badge') return { textContent: '', title: '' };
      if (sel === '.ai-chat-messages') return { appendChild: () => {}, children: [] };
      if (sel === '.ai-quick-prompts') return { innerHTML: '', appendChild: () => {} };
      if (sel === '.ai-chat-input') return { value: '', focus: () => {}, addEventListener: () => {} };
      if (sel === '.ai-send-btn') return { addEventListener: () => {} };
      return null;
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
  };

  const mockDoc = {
    getElementById: (id) => (id === 'ai-command-panel' ? mockPanel : null),
    createElement: () => ({
      className: '',
      innerHTML: '',
      appendChild: () => {},
      addEventListener: () => {},
      querySelector: () => null,
    }),
  };

  const controller = initAiCommandCenter({
    containerId: 'ai-command-panel',
    documentRef: mockDoc,
  });

  assert.ok(controller !== null);
  assert.equal(typeof controller.toggle, 'function');
  assert.equal(typeof controller.setMode, 'function');
  assert.equal(typeof controller.sendMessage, 'function');
});

test('detectTextLanguage accurately identifies multiple languages and scripts', () => {
  // Hindi (Devanagari)
  assert.equal(detectTextLanguage('नमस्ते, आप कैसे हैं?'), 'hi-IN');
  assert.equal(detectTextLanguage('जार्विस प्रणाली सक्रिय है'), 'hi-IN');

  // Japanese
  assert.equal(detectTextLanguage('こんにちは、世界'), 'ja-JP');
  assert.equal(detectTextLanguage('ジャービスを起動します'), 'ja-JP');

  // Chinese
  assert.equal(detectTextLanguage('你好，人工智能系统'), 'zh-CN');

  // Arabic
  assert.equal(detectTextLanguage('مرحبا بك في نظام جارفيس'), 'ar-SA');

  // Russian (Cyrillic)
  assert.equal(detectTextLanguage('Привет, как дела?'), 'ru-RU');

  // Spanish
  assert.equal(detectTextLanguage('¿Hola cómo estás amigo?'), 'es-ES');
  assert.equal(detectTextLanguage('Muchas gracias por tu ayuda'), 'es-ES');

  // French
  assert.equal(detectTextLanguage('Bonjour mon ami, merci beaucoup'), 'fr-FR');

  // German
  assert.equal(detectTextLanguage('Guten Tag, wie geht es Ihnen?'), 'de-DE');

  // English fallback / default
  assert.equal(detectTextLanguage('Hello JARVIS, run tactical analysis on flight ADSB-204'), 'en-US');
  assert.equal(detectTextLanguage(''), 'en-US');
  assert.equal(detectTextLanguage(null), 'en-US');
});

test('selectBestVoice prioritizes neural and natural voices matching language', () => {
  const mockVoices = [
    { name: 'Microsoft David Desktop - English (United States)', lang: 'en-US' },
    { name: 'Microsoft Swara Online (Natural) - Hindi (India)', lang: 'hi-IN' },
    { name: 'Microsoft Guy Online (Natural) - English (United States)', lang: 'en-US' },
    { name: 'Google español', lang: 'es-ES' },
  ];

  // For Hindi, should pick Microsoft Swara Online (Natural)
  const hindiVoice = selectBestVoice(mockVoices, 'hi-IN');
  assert.ok(hindiVoice);
  assert.equal(hindiVoice.name, 'Microsoft Swara Online (Natural) - Hindi (India)');

  // For English, should pick Guy (Natural) over David (Desktop)
  const enVoice = selectBestVoice(mockVoices, 'en-US');
  assert.ok(enVoice);
  assert.equal(enVoice.name, 'Microsoft Guy Online (Natural) - English (United States)');

  // For Spanish, should pick Google español
  const esVoice = selectBestVoice(mockVoices, 'es-ES');
  assert.ok(esVoice);
  assert.equal(esVoice.name, 'Google español');

  // Direct preferred voice override
  const directVoice = selectBestVoice(mockVoices, 'en-US', 'Microsoft David Desktop - English (United States)');
  assert.ok(directVoice);
  assert.equal(directVoice.name, 'Microsoft David Desktop - English (United States)');
});

test('initAiCommandCenter provides unlock, speak, and voiceSettings controls', () => {
  const mockDoc = {
    getElementById: (id) => {
      if (id !== 'ai-command-panel') return null;
      return {
        id: 'ai-command-panel',
        classList: { contains: () => false, toggle: () => {} },
        querySelector: () => ({ addEventListener: () => {}, textContent: '', value: '', focus: () => {}, appendChild: () => {}, innerHTML: '' }),
        querySelectorAll: () => [],
        addEventListener: () => {},
      };
    },
    createElement: () => ({
      className: '',
      innerHTML: '',
      appendChild: () => {},
      addEventListener: () => {},
      querySelector: () => null,
    }),
  };

  const controller = initAiCommandCenter({
    containerId: 'ai-command-panel',
    documentRef: mockDoc,
  });

  assert.ok(controller);
  assert.equal(typeof controller.unlock, 'function');
  assert.equal(typeof controller.speak, 'function');
  assert.equal(typeof controller.getVoiceSettings, 'function');
  assert.equal(typeof controller.setVoiceSettings, 'function');

  controller.setVoiceSettings({ rate: 1.25, lang: 'hi-IN' });
  const settings = controller.getVoiceSettings();
  assert.equal(settings.rate, 1.25);
  assert.equal(settings.lang, 'hi-IN');
});

test('initAiCommandCenter exposes navigation controls and view switching', () => {
  const viewsHidden = {
    history: true,
    models: true,
    voice: true,
    device: true,
  };

  const mockPanel = {
    id: 'ai-command-panel',
    classList: { contains: () => false, toggle: () => {} },
    querySelector: (sel) => {
      if (sel === '.ai-nav-breadcrumb') return { textContent: '', title: '', addEventListener: () => {} };
      if (sel === '.ai-history-drawer') return { hidden: viewsHidden.history };
      if (sel === '.ai-model-drawer') return { hidden: viewsHidden.models };
      if (sel === '.ai-voice-modal') return { hidden: viewsHidden.voice };
      if (sel === '.ai-device-modal') return { hidden: viewsHidden.device };
      if (sel === '.ai-search-bar') return { hidden: true };
      if (sel === '.ai-scroll-navigator') return { hidden: true };
      return { addEventListener: () => {}, textContent: '', value: '', focus: () => {}, appendChild: () => {}, innerHTML: '', hidden: true };
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
  };

  const mockDoc = {
    getElementById: (id) => (id === 'ai-command-panel' ? mockPanel : null),
    createElement: () => ({
      className: '',
      innerHTML: '',
      appendChild: () => {},
      addEventListener: () => {},
      querySelector: () => null,
    }),
  };

  const controller = initAiCommandCenter({
    containerId: 'ai-command-panel',
    documentRef: mockDoc,
  });

  assert.ok(controller);
  assert.equal(typeof controller.switchView, 'function');
  assert.equal(typeof controller.toggleSearch, 'function');
  assert.equal(typeof controller.scrollToBottom, 'function');
  assert.equal(typeof controller.scrollToTop, 'function');
  assert.equal(typeof controller.getView, 'function');

  assert.equal(controller.getView(), 'chat');
  controller.switchView('history');
  assert.equal(controller.getView(), 'history');

  controller.switchView('models');
  assert.equal(controller.getView(), 'models');

  controller.switchView('voice');
  assert.equal(controller.getView(), 'voice');

  controller.switchView('device');
  assert.equal(controller.getView(), 'device');

  controller.switchView('chat');
  assert.equal(controller.getView(), 'chat');
});

test('initAiCommandCenter supports Auto-MoE and Council Swarm modes', () => {
  const modelBadge = { textContent: '', title: '' };
  const appendedNodes = [];

  const mockPanel = {
    id: 'ai-command-panel',
    classList: {
      contains: () => false,
      toggle: () => {},
      add: () => {},
      remove: () => {},
    },
    querySelector: (sel) => {
      if (sel === '.ai-active-model-badge') return modelBadge;
      if (sel === '.ai-panel-header') return { addEventListener: () => {} };
      if (sel === '.ai-chat-messages') return { appendChild: (node) => appendedNodes.push(node), children: [] };
      if (sel === '.ai-quick-prompts') return { innerHTML: '', appendChild: () => {} };
      if (sel === '.ai-chat-input') return { value: '', focus: () => {}, addEventListener: () => {} };
      if (sel === '.ai-send-btn') return { addEventListener: () => {} };
      return null;
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
  };

  const mockDoc = {
    getElementById: (id) => (id === 'ai-command-panel' ? mockPanel : null),
    createElement: (tag) => {
      const el = {
        tagName: tag.toUpperCase(),
        className: '',
        innerHTML: '',
        textContent: '',
        appendChild: (child) => el.children.push(child),
        children: [],
        addEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
      };
      return el;
    },
  };

  const controller = initAiCommandCenter({
    containerId: 'ai-command-panel',
    documentRef: mockDoc,
  });

  assert.ok(controller);
  assert.equal(controller.getModel(), 'auto');
  assert.equal(modelBadge.textContent, '🎯 Auto-MoE');

  controller.switchModel('ensemble');
  assert.equal(controller.getModel(), 'ensemble');
  assert.equal(modelBadge.textContent, '👥 Council');

  controller.switchModel('qwen/qwen2.5-coder-32b-instruct');
  assert.equal(controller.getModel(), 'qwen/qwen2.5-coder-32b-instruct');
  assert.equal(modelBadge.textContent, 'qwen2.5-coder-32b');

  controller.switchModel('auto');
  assert.equal(controller.getModel(), 'auto');
  assert.equal(modelBadge.textContent, '🎯 Auto-MoE');

  // Test appendMessage with council and routedModel
  const councilData = [
    { name: 'DeepSeek R1', role: 'Logic & Reasoning', model: 'deepseek-ai/deepseek-r1', content: 'Step 1: Analyzed constraints.' },
    { name: 'Qwen Coder', role: 'Code Synthesis', model: 'qwen/qwen2.5-coder-32b-instruct', content: 'const res = 42;' },
    { name: 'Nemotron 3.5', role: 'Tactical Execution', model: 'nvidia/nemotron-3.5-lightning-30b-a3b', content: 'Execution plan verified.' },
  ];

  const handle = controller.appendMessage('assistant', 'Deliberation consensus reached.', {
    council: councilData,
    routedModel: 'deepseek-ai/deepseek-r1',
    routedReason: 'Reasoning problem detected',
  });

  assert.ok(handle);
  assert.ok(handle.msgEl);
  assert.ok(handle.contentDiv);

  // Test appendVoiceExchange
  assert.equal(typeof controller.appendVoiceExchange, 'function');
  controller.appendVoiceExchange('Show flights over Tokyo', 'Tracking flights now.');
  assert.ok(appendedNodes.length > 0);
});

test('initAiCommandCenter handles open/close toggles, FAB, top toggle, and drawer back buttons', () => {
  const panelClasses = new Set(['panel-collapsible', 'collapsed']);
  let collapseClickCount = 0;

  const mockCollapseBtn = {
    textContent: '+',
    click: () => {
      collapseClickCount++;
      if (panelClasses.has('collapsed')) {
        panelClasses.delete('collapsed');
      } else {
        panelClasses.add('collapsed');
      }
    },
    setAttribute: () => {},
  };

  const makeMockElement = () => {
    const elementListeners = new Map();
    return {
      classList: {
        _classes: new Set(),
        contains(cls) { return this._classes.has(cls); },
        toggle(cls, force) {
          if (force === undefined) {
            if (this._classes.has(cls)) this._classes.delete(cls);
            else this._classes.add(cls);
          } else if (force) {
            this._classes.add(cls);
          } else {
            this._classes.delete(cls);
          }
        },
      },
      setAttribute: () => {},
      addEventListener(evt, fn) {
        if (!elementListeners.has(evt)) elementListeners.set(evt, []);
        elementListeners.get(evt).push(fn);
      },
      click() {
        for (const fn of elementListeners.get('click') || []) fn({ target: this, stopPropagation: () => {} });
      },
    };
  };

  const closeBtn = makeMockElement();
  const collapsedHint = makeMockElement();
  const drawerBackBtn = makeMockElement();
  const globalFab = makeMockElement();
  const topNavToggleBtn = makeMockElement();
  const header = makeMockElement();

  const mockPanel = {
    id: 'ai-command-panel',
    classList: {
      contains: (cls) => panelClasses.has(cls),
      toggle: (cls, force) => {
        if (force === undefined) {
          if (panelClasses.has(cls)) panelClasses.delete(cls);
          else panelClasses.add(cls);
        } else if (force) {
          panelClasses.add(cls);
        } else {
          panelClasses.delete(cls);
        }
      },
    },
    querySelector: (sel) => {
      if (sel === '.panel-collapse-btn') return mockCollapseBtn;
      if (sel === '.ai-panel-header') return header;
      if (sel === '.ai-close-btn') return closeBtn;
      if (sel === '.ai-collapsed-hint') return collapsedHint;
      if (sel === '.ai-active-model-badge') return { textContent: '', title: '' };
      if (sel === '.ai-chat-messages') return { appendChild: () => {}, children: [] };
      if (sel === '.ai-quick-prompts') return { innerHTML: '', appendChild: () => {} };
      if (sel === '.ai-chat-input') return { value: '', focus: () => {}, addEventListener: () => {} };
      if (sel === '.ai-send-btn') return { addEventListener: () => {} };
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === '.ai-drawer-back-btn') return [drawerBackBtn];
      return [];
    },
    addEventListener: () => {},
  };

  const mockDoc = {
    getElementById: (id) => {
      if (id === 'ai-command-panel') return mockPanel;
      if (id === 'ai-quick-toggle-fab') return globalFab;
      if (id === 'top-ai-toggle-btn') return topNavToggleBtn;
      return null;
    },
    createElement: () => ({
      className: '',
      innerHTML: '',
      appendChild: () => {},
      addEventListener: () => {},
      querySelector: () => null,
    }),
  };

  const controller = initAiCommandCenter({
    containerId: 'ai-command-panel',
    documentRef: mockDoc,
  });

  assert.ok(controller);
  assert.equal(panelClasses.has('collapsed'), true);

  // 1. toggle() opens the panel
  controller.toggle();
  assert.equal(panelClasses.has('collapsed'), false);
  assert.equal(mockCollapseBtn.textContent, '−');
  assert.equal(globalFab.classList.contains('active'), true);
  assert.equal(topNavToggleBtn.classList.contains('active'), true);

  // 2. toggle() closes the panel
  controller.toggle();
  assert.equal(panelClasses.has('collapsed'), true);
  assert.equal(mockCollapseBtn.textContent, '+');
  assert.equal(globalFab.classList.contains('active'), false);
  assert.equal(topNavToggleBtn.classList.contains('active'), false);

  // 3. toggle(true) force opens
  controller.toggle(true);
  assert.equal(panelClasses.has('collapsed'), false);

  // 4. closeBtn clicks closes panel
  closeBtn.click();
  assert.equal(panelClasses.has('collapsed'), true);

  // 5. FAB click toggles panel open
  globalFab.click();
  assert.equal(panelClasses.has('collapsed'), false);

  // 6. Top nav button click toggles panel closed
  topNavToggleBtn.click();
  assert.equal(panelClasses.has('collapsed'), true);

  // 7. Drawer back button returns to chat view
  controller.switchView('models');
  assert.equal(controller.getView(), 'models');
  drawerBackBtn.click();
  assert.equal(controller.getView(), 'chat');
});

test('playAudioCue procedurally generates cues without errors', () => {
  const oscCalls = [];
  const mockAudioContext = function () {
    return {
      currentTime: 0,
      destination: {},
      createOscillator: () => {
        const osc = {
          type: 'sine',
          frequency: {
            setValueAtTime: (val, t) => oscCalls.push({ action: 'freq', val, t }),
            exponentialRampToValueAtTime: (val, t) => oscCalls.push({ action: 'ramp', val, t }),
          },
          connect: () => {},
          start: () => {},
          stop: () => {},
        };
        return osc;
      },
      createGain: () => ({
        gain: {
          setValueAtTime: () => {},
          exponentialRampToValueAtTime: () => {},
        },
        connect: () => {},
      }),
    };
  };

  playAudioCue('wake', { audioContextRef: mockAudioContext });
  assert.ok(oscCalls.length > 0);

  oscCalls.length = 0;
  playAudioCue('alert', { audioContextRef: mockAudioContext });
  assert.ok(oscCalls.length > 0);

  oscCalls.length = 0;
  playAudioCue('recon', { audioContextRef: mockAudioContext });
  assert.ok(oscCalls.length > 0);

  oscCalls.length = 0;
  playAudioCue('data', { audioContextRef: mockAudioContext });
  assert.ok(oscCalls.length > 0);
});

test('initAiCommandCenter exposes tactical superpowers: wake-word, drone recon, cctv grid, geo plotter, and threat scanner', () => {
  const panelClasses = new Set(['panel-collapsible']);
  const listeners = new Map();
  const makeMockEl = () => ({
    classList: {
      contains: () => false,
      toggle: () => {},
      add: () => {},
      remove: () => {},
    },
    setAttribute: () => {},
    addEventListener: (evt, fn) => {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(fn);
    },
    click: () => {
      for (const fn of listeners.get('click') || []) fn({ stopPropagation: () => {} });
    },
  });

  const mockPanel = {
    id: 'ai-command-panel',
    classList: { contains: () => false, toggle: () => {} },
    querySelector: (sel) => {
      if (sel === '.ai-wakeword-toggle-btn') return makeMockEl();
      if (sel === '#ai-wakeword-modal-toggle') return makeMockEl();
      if (sel === '#ai-wakeword-status') return { textContent: '', classList: { toggle: () => {} } };
      if (sel === '.ai-chat-messages') return { appendChild: () => {}, children: [] };
      if (sel === '.ai-quick-prompts') return { innerHTML: '', appendChild: () => {} };
      if (sel === '.ai-chat-input') return { value: '', focus: () => {}, addEventListener: () => {} };
      return null;
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
  };

  const mockDoc = {
    getElementById: (id) => (id === 'ai-command-panel' ? mockPanel : null),
    createElement: () => ({
      className: '',
      innerHTML: '',
      appendChild: () => {},
      addEventListener: () => {},
      querySelector: () => null,
    }),
  };

  const controller = initAiCommandCenter({
    containerId: 'ai-command-panel',
    documentRef: mockDoc,
  });

  assert.ok(controller);
  assert.ok(controller.droneRecon);
  assert.ok(controller.cctvGrid);
  assert.ok(controller.geoPlotter);
  assert.ok(controller.threatScanner);
  assert.equal(typeof controller.toggleWakeWord, 'function');
  assert.equal(typeof controller.isWakeWordActive, 'function');
  assert.equal(typeof controller.playAudioCue, 'function');
});



