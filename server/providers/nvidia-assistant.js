import { readRequestBody } from './common/request.js';
import {
  JARVIS_TOOL_SCHEMAS,
  executeTool,
  readMemory,
} from './jarvis-tools.js';

const NVIDIA_DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_DEFAULT_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';

/** Models with built-in reasoning / thinking trace capabilities */
const REASONING_MODELS = new Set([
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'openai/gpt-oss-20b',
  'poolside/laguna-xs-2.1',
  'deepseek-ai/deepseek-r1',
  'deepseek-ai/deepseek-v3',
  'qwen/qwen2.5-72b-instruct',
  'qwen/qwen2.5-coder-32b-instruct',
  'moonshotai/kimi-k3',
]);

/**
 * Get the pool of configured NVIDIA API keys for load balancing & failover.
 */
export function getApiKeyPool() {
  const pool = [];
  if (process.env.NVIDIA_API_KEYS) {
    pool.push(
      ...process.env.NVIDIA_API_KEYS.split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    );
  }
  if (process.env.NVIDIA_API_KEY) {
    const keys = process.env.NVIDIA_API_KEY.split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    for (const key of keys) {
      if (!pool.includes(key)) {
        pool.push(key);
      }
    }
  }
  return pool;
}

let currentKeyIndex = 0;
export function getNextApiKey(requestedKey = null) {
  if (requestedKey) return requestedKey;
  const pool = getApiKeyPool();
  if (pool.length === 0) return null;
  const key = pool[currentKeyIndex % pool.length];
  currentKeyIndex = (currentKeyIndex + 1) % pool.length;
  return key;
}

/** Max tool-call iterations to prevent infinite loops */
const MAX_TOOL_ITERATIONS = 8;

/** Specialized Persona modifiers */
export const PERSONA_PROMPTS = {
  jarvis: `Persona Directive: You are JARVIS — Tony Stark's sophisticated, polite, and unflappable AI companion. Address the user with tactical confidence and supreme intelligence.`,
  coder: `Persona Directive: You are a Principal Software Architect. You write robust, modular, optimized code, hunt down bugs, and explain architectural trade-offs with absolute precision.`,
  tutor: `Persona Directive: You are an Academic Professor & Socratic Tutor. You simplify hard concepts using first-principles analogies, step-by-step proofs, and interactive quizzes.`,
  osint: `Persona Directive: You are a Senior Geospatial & OSINT Intelligence Analyst. You triangulate data, analyze coordinates and satellite imagery, and deliver tactical intelligence dossiers.`,
  concise: `Persona Directive: You are a Rapid Tactical Node. Deliver direct, high-density facts, bullet points, and code with zero conversational fluff.`,
};

/** System prompts specialized for each Command Center mode */
const SYSTEM_PROMPTS = {
  general: `You are JARVIS — an advanced universal AI assistant inside God's Eye View (GEV), a 3D geospatial intelligence platform with direct host computer control.
You are brilliant, concise, tactical, and capable. You can answer any question, analyze situations, generate creative content, provide insights, and assist with any cognitive or computer task.
You have access to powerful tools: real system command execution, hardware telemetry, process management, app launching, desktop screenshots, clipboard control, file operations anywhere on this computer, web scraping, calculation, and persistent memory.
When a user asks you to DO something (run code, execute a command, open an app, check system stats, take a screenshot, calculate, fetch data, remember something), USE the appropriate tool immediately. Don't just explain — EXECUTE.
Format responses cleanly using Markdown. Be direct, helpful, and thorough without fluff.
You are the user's personal AI assistant — like Jarvis from Iron Man. Act accordingly.`,

  computer: `You are JARVIS in FULL COMPUTER CONTROL & AUTOMATION MODE — Tony Stark's ultimate AI assistant with real, direct control over this host computer.
You have real, direct system control capabilities over this operating system:
- system_command: Run any terminal, shell, or PowerShell command directly on this computer (git, npm, python, scripts, utilities, system checks).
- system_info: Inspect real hardware telemetry: CPU model, cores, load, RAM total/used/free, platform, OS version, disk drives with free/used GB, uptime, battery status.
- list_processes / kill_process: Monitor active processes, inspect memory/CPU usage, and terminate running tasks.
- list_windows / focus_window / close_window: Inspect open desktop application windows, switch/focus windows to the foreground, or close them gracefully.
- send_keys: Send keyboard keystrokes and shortcut combinations to active windows (e.g. {ENTER}, ^c, ^v, %{TAB}).
- schedule_task / list_scheduled_tasks / cancel_scheduled_task: Set delayed timers or recurring background tasks and alarms that execute commands, tools, or notifications.
- diagnose_system: Complete health diagnostic check assessing CPU, RAM, disk space, and top memory-heavy processes with recommendations.
- clean_temp_files: Clean execution sandbox cache to reclaim disk space.
- ping_host: Probe network latency and reachability to any host.
- open_app_or_file: Launch any application (Notepad, Calculator, VS Code, Chrome, Spotify, Explorer) or open any file or URL with default system handlers.
- take_screenshot: Capture real-time full-screen desktop screenshots (saved and accessible via local URL).
- get_clipboard / set_clipboard: Read and write the Windows clipboard.
- read_system_file / write_system_file / list_system_directory / search_system_files: Read, write, explore, and search files anywhere on this computer.
- control_media_volume: Adjust volume (mute/unmute, volume up/down) or media playback (play/pause, next, prev).
- system_notify: Pop native Windows toast notifications.

Directives:
1. When the user asks you to perform a task on the computer (e.g. open an app, focus a window, schedule an alarm, check health, run a command, search for a file, take a screenshot), DO NOT just explain how to do it — EXECUTE the tool immediately!
2. For multi-step tasks, plan the sequence, execute each step using tool calls, verify the outputs, handle errors autonomously, and report the definitive result.
3. Address the user with tactical confidence and supreme intelligence like Tony Stark's JARVIS.`,

  study: `You are JARVIS in STUDY MODE — an elite academic tutor and study partner.
Your mission: help the user master any topic thoroughly.
Techniques:
- First-principles breakdown with intuitive analogies
- Socratic questioning to test understanding
- Generate flashcards, quizzes, and self-test prompts
- Step-by-step solutions for math, science, engineering
- Use code execution to demonstrate concepts with real calculations
Always structure explanations with clear headings, key takeaways, and memorable summaries.
Use the calculate tool for math problems. Use execute_code for demonstrations.`,

  code: `You are JARVIS in CODE MODE — an autonomous principal software engineer and systems architect.
Your core superpower is AUTONOMOUS EXECUTION, ITERATION, AND DEBUGGING LOOPS.
You don't just write code — you EXECUTE it, DEBUG it, FIND ERRORS, FIX BUGS, and ITERATE until 100% verified.
Workflow:
1. Understand the requirement thoroughly.
2. Write clean, modular, production-ready code with built-in test cases or assertions.
3. Immediately call the execute_code or debug_code tool to run it in the sandbox.
4. If the execution returns exitCode != 0 or an error in stderr/errorAnalysis:
   - Identify the exact line, exception type, and root cause.
   - Modify the code to fix the bug.
   - Call execute_code or debug_code again with the fixed version.
   - Continue this loop of execution → error analysis → bug fix → verification until exit code is 0 and tests pass!
5. Present the user with:
   - Summary of the debugging loop (e.g. Iteration 1: Bug found → Iteration 2: Fix applied → Verified).
   - Final clean code and actual execution output.
   - Complexity analysis and edge case explanations.
Supported languages: JavaScript, Python, TypeScript, Bash, PowerShell.
Never give up on an error: debug and fix it autonomously in the loop!`,

  auto: `You are JARVIS in AUTOMATION MODE — a workflow automation specialist and autonomous task runner.
You break down complex tasks into executable steps, run them, handle errors, and iterate until the goal is achieved.
Capabilities:
- Chain multiple tool calls to accomplish complex goals
- Execute code, scrape websites, process data, save results
- Run iterative self-correcting loops when a step fails
- Save intermediate results and final reports to workspace files
Always think step-by-step. Execute each step. Report progress. Handle errors gracefully in a loop.
When given a complex task, plan it out first, then execute each step sequentially.`,

  tasks: `You are JARVIS in TASK MODE — a strategic productivity and mission planning assistant.
Help break down complex goals into concrete, prioritized action items.
Format with priorities [HIGH, MED, LOW], estimated durations, and checklists.
Use the remember tool to persist task lists and the recall tool to retrieve them.
When a user creates tasks, store them in memory so they persist across sessions.`,

  research: `You are JARVIS in RESEARCH MODE — an intelligence researcher and OSINT specialist.
Use your tools aggressively:
- scrape_url to fetch live web content
- execute_code to process and analyze data
- write_file to save research reports
- remember to store key findings
Synthesize information, cross-reference facts, provide context, cite sources.
Focus on accuracy, neutrality, and actionable insights.
Always try to fetch real data rather than relying on training knowledge.`,

  memory: `You are JARVIS in MEMORY MODE — managing your persistent knowledge base.
You can remember, recall, and forget information across all conversations.
Use the remember, recall, and forget tools to manage stored knowledge.
Show the user what you remember. Help them organize their stored information.
Proactively use memory in other modes to personalize responses.`,
};

/**
 * Fetch DuckDuckGo instant answers for web search enrichment.
 */
export async function searchDuckDuckGo(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'GodsEyeView/1.0' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      abstract: data.AbstractText || '',
      source: data.AbstractSource || '',
      url: data.AbstractURL || '',
      heading: data.Heading || '',
      relatedTopics: (data.RelatedTopics || [])
        .slice(0, 5)
        .map((t) => t.Text || '')
        .filter(Boolean),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch Wikipedia summary for a topic.
 */
export async function fetchWikipediaSummary(topic) {
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'GodsEyeView/1.0' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      title: data.title,
      description: data.description,
      extract: data.extract,
      url: data.content_urls?.desktop?.page,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch live weather from free Open-Meteo API.
 */
export async function fetchOpenMeteoWeather(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.current_weather || null;
  } catch {
    return null;
  }
}

/**
 * Handler for /api/nvidia/research: search web, Wikipedia, weather.
 */
export async function handleNvidiaResearch(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    const rawBody = await readRequestBody(req, 64 * 1024);
    const { query, type = 'all', lat, lon } = JSON.parse(rawBody || '{}');

    if (!query && (lat === undefined || lon === undefined)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Missing query or coordinates' }));
      return;
    }

    const results = {};

    if (query && (type === 'all' || type === 'web')) {
      results.web = await searchDuckDuckGo(query);
    }
    if (query && (type === 'all' || type === 'wiki')) {
      results.wikipedia = await fetchWikipediaSummary(query);
    }
    if (
      lat !== undefined &&
      lon !== undefined &&
      (type === 'all' || type === 'weather')
    ) {
      results.weather = await fetchOpenMeteoWeather(lat, lon);
    }

    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, query, results }));
  } catch (error) {
    res.statusCode = 500;
    res.end(
      JSON.stringify({ error: error.message || 'Research request failed' }),
    );
  }
}

/**
 * Build the full message payload for the NVIDIA API call.
 */
function buildPayload({
  messages,
  mode,
  model,
  images,
  systemPrompt,
  stream,
  temperature = null,
}) {
  const formattedMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map((m, idx) => {
      if (
        idx === messages.length - 1 &&
        m.role === 'user' &&
        images.length > 0
      ) {
        return {
          role: 'user',
          content: [
            { type: 'text', text: m.content || 'Analyze this image.' },
            ...images.map((img) => ({
              type: 'image_url',
              image_url: { url: img },
            })),
          ],
        };
      }
      return m;
    }),
  ];

  // Determine if this mode should have tool access
  const toolModes = new Set([
    'general',
    'code',
    'auto',
    'research',
    'tasks',
    'memory',
    'study',
    'computer',
  ]);
  const useTools = toolModes.has(mode);
  const supportsTools = typeof model === 'string';

  const finalTemp =
    typeof temperature === 'number' && !Number.isNaN(temperature)
      ? Math.max(0.05, Math.min(1.5, temperature))
      : mode === 'code'
        ? 0.15
        : mode === 'study'
          ? 0.4
          : 0.65;

  return {
    model,
    messages: formattedMessages,
    temperature: finalTemp,
    max_tokens:
      mode === 'code' || mode === 'auto' || mode === 'computer' ? 4096 : 1024,
    stream: Boolean(stream),
    ...(useTools && supportsTools
      ? { tools: JARVIS_TOOL_SCHEMAS, tool_choice: 'auto' }
      : {}),
  };
}

/**
 * Execute tool calls from the AI response and return results.
 * Supports iterative tool-calling loops for debugging/automation.
 */
async function executeToolCalls(toolCalls, emitToolEvent) {
  const results = [];
  for (const call of toolCalls) {
    const toolName = call.function?.name;
    let args = {};
    try {
      args = JSON.parse(call.function?.arguments || '{}');
    } catch {
      args = {};
    }

    if (emitToolEvent)
      emitToolEvent({ tool: toolName, status: 'running', args });

    const result = await executeTool(toolName, args);

    if (emitToolEvent)
      emitToolEvent({ tool: toolName, status: 'done', result });

    results.push({
      tool_call_id: call.id,
      role: 'tool',
      content: JSON.stringify(result),
    });
  }
  return results;
}

/**
 * Intelligent Model Router (Auto-MoE):
 * Automatically analyzes the user's prompt, domain, and language to route to the optimal free model.
 */
export function routeModelForPrompt({
  prompt = '',
  mode = 'general',
  hasImages = false,
} = {}) {
  const p = (prompt || '').toLowerCase();

  // -1. Image Generation Intent
  const imageGenPatterns = [
    /\b(generate (an? )?image|create (an? )?image|draw|paint|sketch|artwork|picture of|render a scene|generate artwork)\b/i,
    /\b(stable diffusion|flux|photorealistic image|illustration of)\b/i,
  ];
  if (imageGenPatterns.some((rgx) => rgx.test(p))) {
    return {
      model: 'stabilityai/stable-diffusion-3-medium',
      reason: 'Generative AI image synthesis & visual rendering',
      category: 'genai',
      badge: '🎨 SD3 GenAI',
      isImageGen: true,
    };
  }

  // 0. Multi-Modal Vision / Images
  if (hasImages || /\b(analyze (this|the) (image|screenshot|photo)|what is in this (image|photo)|describe this image)\b/i.test(p)) {
    return {
      model: 'meta/llama-3.2-11b-vision-instruct',
      reason: 'Multi-modal vision intelligence and image comprehension',
      category: 'vision',
      badge: '👁️ Llama Vision (11B)',
    };
  }

  // 1. Code Generation, Execution, Debugging, Scripting & Engineering
  const codePatterns = [
    /\b(function|def|class|const|let|var|import|export|return|async|await|try|catch)\b/,
    /\b(python|javascript|typescript|c\+\+|rust|golang|java|bash|powershell|sql|html|css|json|yaml)\b/,
    /\b(bug|fix|error|exception|traceback|syntax|segfault|debug|refactor|compile|regex|script)\b/,
    /```/,
    /\b(write a script|build an app|write code|unit test|algorithm|api endpoint|function to)\b/,
  ];
  if (mode === 'code' || codePatterns.some((rgx) => rgx.test(p))) {
    return {
      model: 'openai/gpt-oss-20b',
      reason:
        'High-precision code synthesis, debugging & algorithmic implementation',
      category: 'code',
      badge: '💻 GPT-OSS (20B)',
    };
  }

  // 1.5 Ultra-Scale Frontier Reasoning (Nemotron 550B / DeepSeek R1)
  const ultraReasoningPatterns = [
    /\b(nemotron[- ]?550b|ultra[- ]?550b|deepseek[- ]?r1|deep reasoning model)\b/i,
  ];
  if (ultraReasoningPatterns.some((rgx) => rgx.test(p))) {
    return {
      model: 'nvidia/nemotron-3-ultra-550b-a55b',
      reason: 'Ultra-scale 550B deep reasoning and complex hypothesis analysis',
      category: 'reasoning',
      badge: '🧠 Nemotron 550B',
    };
  }

  // 2. Deep Mathematical Proofs, Formal Logic, Step-by-Step Deductions
  const reasoningPatterns = [
    /\b(prove|proof|theorem|axiom|deduce|deduction|syllogism|paradox|riddle)\b/,
    /\b(step[- ]by[- ]step logic|chain of thought|first principles|why does|solve the puzzle)\b/,
    /\b(calculate the probability|combinatorics|calculus|integral|derivative|algebraic)\b/,
  ];
  if (reasoningPatterns.some((rgx) => rgx.test(p))) {
    return {
      model: 'openai/gpt-oss-20b',
      reason:
        'Deep step-by-step reasoning, mathematical deduction & chain-of-thought',
      category: 'reasoning',
      badge: '🧠 GPT-OSS (20B)',
    };
  }

  // 3. Non-Latin scripts & Multilingual Translation (Hindi, Japanese, Chinese, Arabic, Russian, etc.)
  const isNonLatin =
    /[\u0900-\u097F\u3040-\u30FF\u4E00-\u9FFF\u0600-\u06FF\u0400-\u04FF]/.test(
      prompt,
    );
  const translatePatterns =
    /\b(translate|translation|अनुवाद|traduci|traduis|übersetze|hindi|japanese|chinese|arabic|russian|spanish|french|german)\b/i;
  if (isNonLatin || translatePatterns.test(p)) {
    return {
      model: 'mistralai/mistral-nemotron',
      reason:
        'Multilingual specialization across global languages & high-fidelity translation',
      category: 'multilingual',
      badge: '🌐 Mistral-Nemotron',
    };
  }

  // 4. Globe, Tactical Maps, Geolocation, Fast Tool Operations
  if (
    mode === 'globe' ||
    /\b(globe|map|satellite|flight|ads-b|cctv|coordinate|latitude|longitude|zoom|tilt|pan to)\b/.test(
      p,
    )
  ) {
    return {
      model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
      reason: 'Low-latency tactical reasoning & globe tool-calling execution',
      category: 'tactical',
      badge: '⚡ Nemotron 3.5',
    };
  }

  // 5. Long Context Document Analysis, Detailed Reports, Lengthy Text
  if (
    prompt.length > 800 ||
    /\b(summarize this document|detailed report|write an essay|comprehensive documentation)\b/.test(
      p,
    )
  ) {
    return {
      model: 'mistralai/mistral-nemotron',
      reason: 'Structured contextual comprehension and structured analysis',
      category: 'analysis',
      badge: '🔮 Mistral-Nemotron',
    };
  }

  // 6. Computer & Host OS Automation, Tool Calling, System Tasks
  const computerPatterns = [
    /\b(open|launch|start|kill|terminate|process|processes|taskmgr)\b/,
    /\b(powershell|terminal|cmd|command line|shell|bash|git|npm)\b/,
    /\b(screenshot|screen capture|clipboard|volume|mute|unmute)\b/,
    /\b(ram|cpu|disk|hardware|system info|specs|specs of this pc)\b/,
    /\b(file explorer|notepad|calculator|calc|chrome|vs ?code)\b/,
  ];
  if (mode === 'computer' || computerPatterns.some((rgx) => rgx.test(p))) {
    return {
      model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
      reason: 'Low-latency tool execution & computer control automation',
      category: 'computer',
      badge: '⚡ Nemotron Computer Control',
    };
  }

  // 7. General Universal Assistant (Default)
  return {
    model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    reason:
      'Ultra-fast hybrid Mamba-Transformer reasoning & tactical knowledge',
    category: 'general',
    badge: '⚡ Nemotron 3.5',
  };
}

/**
 * JARVIS Council of Models (Multi-Model Swarm / Ensemble):
 * Multiple specialized models deliberate simultaneously in parallel and synthesize their consensus.
 */
export async function handleCouncilEnsemble({
  messages,
  mode,
  systemPrompt,
  images = [],
  apiKey,
  baseUrl,
  temperature = null,
  stream = false,
  res,
}) {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const userPrompt =
    typeof lastUserMsg?.content === 'string'
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg?.content)
        ? lastUserMsg.content.find((c) => c.type === 'text')?.text || ''
        : '';

  const councilModels = [
    {
      id: 'openai/gpt-oss-20b',
      name: 'GPT-OSS 20B',
      role: '🧠 Logic & Reasoning Specialist',
    },
    {
      id: 'mistralai/mistral-nemotron',
      name: 'Mistral-Nemotron',
      role: '🔮 Domain & Synthesis Specialist',
    },
    {
      id: 'nvidia/nemotron-3.5-lightning-30b-a3b',
      name: 'Nemotron 3.5',
      role: '⚡ Tactical Execution Specialist',
    },
  ];

  // Run council models simultaneously in parallel
  const councilPromises = councilModels.map(async (member) => {
    try {
      const payload = {
        model: member.id,
        messages: [
          {
            role: 'system',
            content: `${systemPrompt}\n\nCouncil Member Directive: You are acting as the ${member.role}. Provide your best, most precise evaluation and solution for the user request.`,
          },
          ...messages,
        ],
        temperature: 0.6,
        max_tokens: 1024,
        stream: false,
      };
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok)
        return { ...member, content: '(Model response unavailable)' };
      const data = await response.json();
      return {
        ...member,
        content: data?.choices?.[0]?.message?.content || '(No output provided)',
        reasoning: data?.choices?.[0]?.message?.reasoning_content || null,
      };
    } catch (err) {
      return { ...member, content: `(Execution note: ${err.message})` };
    }
  });

  const councilResults = await Promise.all(councilPromises);

  const deliberationSummary = councilResults
    .map((m) => `### [Council Member: ${m.name} — ${m.role}]\n${m.content}`)
    .join('\n\n---\n\n');

  const synthesizerMessages = [
    {
      role: 'system',
      content: `${systemPrompt}\n\nYou are the Presiding Executive Coordinator of the JARVIS Council of Models.\nThree specialized AI models have analyzed this exact mission simultaneously in parallel.\n\nHere are their respective perspectives and outputs:\n\n${deliberationSummary}\n\nYOUR TASK AS EXECUTIVE COORDINATOR:\nSynthesize a single, authoritative, harmonious master response. Integrate their best points, verify code and logic, resolve any contradictions, and present the final master answer with supreme clarity and elegance.`,
    },
    ...messages,
  ];

  const synthModel = 'nvidia/nemotron-3.5-lightning-30b-a3b';

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Cache-Control', 'no-cache, no-transform');

    // First send the council deliberation metadata
    res.write(
      `data: ${JSON.stringify({
        meta: {
          collaborationMode: 'council',
          council: councilResults.map((r) => ({
            name: r.name,
            role: r.role,
            model: r.id,
            content: r.content,
            reasoning: r.reasoning,
          })),
        },
      })}\n\n`,
    );

    try {
      const synthResponse = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: synthModel,
          messages: synthesizerMessages,
          temperature: typeof temperature === 'number' ? temperature : 0.6,
          max_tokens: 2048,
          stream: true,
        }),
      });

      if (!synthResponse.ok) {
        const fallbackText =
          councilResults.find((r) => r.content && !r.content.startsWith('('))
            ?.content || 'Council deliberation concluded.';
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: fallbackText } }] })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const reader = synthResponse.body.getReader();
      const decoder = new TextDecoder('utf-8');
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      res.write(
        `data: ${JSON.stringify({ error: `Council synthesis failed: ${err.message}` })}\n\n`,
      );
      res.end();
    }
    return;
  }

  // Non-streaming
  try {
    const synthResponse = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: synthModel,
        messages: synthesizerMessages,
        temperature: typeof temperature === 'number' ? temperature : 0.6,
        max_tokens: 2048,
        stream: false,
      }),
    });

    let masterContent = '';
    if (synthResponse.ok) {
      const synthData = await synthResponse.json();
      masterContent = synthData?.choices?.[0]?.message?.content || '';
    }
    if (!masterContent) {
      masterContent =
        councilResults[0]?.content || 'Council deliberation completed.';
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        ok: true,
        collaborationMode: 'council',
        model: 'ensemble',
        council: councilResults.map((r) => ({
          name: r.name,
          role: r.role,
          model: r.id,
          content: r.content,
          reasoning: r.reasoning,
        })),
        message: {
          role: 'assistant',
          content: masterContent,
        },
      }),
    );
  } catch (err) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 500;
    res.end(
      JSON.stringify({ error: `Council execution error: ${err.message}` }),
    );
  }
}

/**
 * Handler for /api/nvidia/assistant: universal AI conversation endpoint.
 * Now supports intelligent auto-routing (Auto-MoE) & Multi-Model Council Swarm.
 */
export async function handleNvidiaAssistant(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const rawBody = await readRequestBody(req, 1024 * 1024);
  let body = {};
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  const apiKey = getNextApiKey(body.apiKey);
  if (!apiKey) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 503;
    res.end(JSON.stringify({ error: 'NVIDIA_API_KEY is not configured' }));
    return;
  }

  const {
    messages = [],
    mode = 'general',
    model = 'auto',
    stream = false,
    images = [],
    webSearch = false,
    context = null,
    persona = 'jarvis',
    temperature = null,
  } = body;

  const baseUrl = process.env.NVIDIA_BASE_URL || NVIDIA_DEFAULT_BASE_URL;

  // Build system prompt with persona directive
  let systemPrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.general;
  if (persona && PERSONA_PROMPTS[persona]) {
    systemPrompt = `${PERSONA_PROMPTS[persona]}\n\n${systemPrompt}`;
  }
  if (context) {
    systemPrompt += `\n\nCurrent Globe Geospatial Context:\n${JSON.stringify(context, null, 2)}`;
  }

  // Inject persistent memory context for personalization
  try {
    const mem = await readMemory();
    const memKeys = Object.keys(mem);
    if (memKeys.length > 0) {
      const memSummary = memKeys
        .slice(0, 20)
        .map((k) => `${k}: ${JSON.stringify(mem[k].value)}`)
        .join('\n');
      systemPrompt += `\n\nYour Persistent Memory (use to personalize responses):\n${memSummary}`;
    }
  } catch {
    /* memory injection is optional */
  }

  // Web search context injection
  if (webSearch && messages.length > 0) {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg && typeof lastUserMsg.content === 'string') {
      const ddg = await searchDuckDuckGo(lastUserMsg.content);
      const wiki = await fetchWikipediaSummary(lastUserMsg.content);
      if (ddg?.abstract || wiki?.extract) {
        systemPrompt += `\n\nLive Web & Reference Knowledge:\n${ddg?.abstract ? `Web: ${ddg.abstract} (${ddg.source || 'DuckDuckGo'})\n` : ''}${wiki?.extract ? `Wikipedia (${wiki.title}): ${wiki.extract}\n` : ''}`;
      }
    }
  }

  // 1. Council / Multi-Model Swarm Mode Check
  if (model === 'ensemble' || model === 'council') {
    await handleCouncilEnsemble({
      messages,
      mode,
      systemPrompt,
      images,
      apiKey,
      baseUrl,
      temperature,
      stream,
      res,
    });
    return;
  }

  // 2. Intelligent Auto-Routing (Auto-MoE Router)
  let effectiveModel = model;
  let routedMeta = null;
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const userPromptText =
    typeof lastUserMsg?.content === 'string'
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg?.content)
        ? lastUserMsg.content.find((c) => c.type === 'text')?.text || ''
        : '';

  if (model === 'auto' || model === 'router' || !model) {
    routedMeta = routeModelForPrompt({
      prompt: userPromptText,
      mode,
      hasImages: images.length > 0,
    });
    effectiveModel = routedMeta.model;
  }

  // Check if this request needs tool execution loop
  const toolCapableModes = new Set([
    'computer',
    'code',
    'auto',
    'general',
    'research',
    'tasks',
  ]);
  const wantsTools =
    toolCapableModes.has(mode) ||
    /\b(open|run|kill|process|screenshot|system|terminal|powershell|calc|file|clipboard|volume)\b/i.test(
      userPromptText,
    );

  // If tools are wanted, always run the iterative tool execution loop first
  if (wantsTools) {
    try {
      let currentMessages = [...messages];
      let allToolResults = [];
      let finalContent = '';
      let finalReasoning = null;
      let iteration = 0;

      while (iteration < MAX_TOOL_ITERATIONS) {
        iteration++;

        const payload = buildPayload({
          messages: currentMessages,
          mode,
          model: effectiveModel,
          images: iteration === 1 ? images : [],
          systemPrompt,
          stream: false,
          temperature,
        });

        let currentKey = apiKey;
        let response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${currentKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          currentKey = getNextApiKey() || currentKey;
          const fallbackPayload = {
            ...payload,
            model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
          };
          delete fallbackPayload.chat_template_kwargs;

          response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${currentKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(fallbackPayload),
          });
        }

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          if (stream) {
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.write(
              `data: ${JSON.stringify({ error: `NVIDIA API error (${response.status}): ${errText}` })}\n\n`,
            );
            res.end();
          } else {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.statusCode = response.status || 502;
            res.end(
              JSON.stringify({
                error: `NVIDIA NIM API error (${response.status}): ${errText}`,
              }),
            );
          }
          return;
        }

        const data = await response.json();
        const choice = data?.choices?.[0];
        const message = choice?.message || {};
        const toolCalls = message.tool_calls || [];
        finalReasoning = message.reasoning_content || finalReasoning;

        if (toolCalls.length > 0) {
          const toolResults = await executeToolCalls(toolCalls);
          allToolResults.push(
            ...toolCalls.map((tc, i) => ({
              name: tc.function?.name,
              args: (() => {
                try {
                  return JSON.parse(tc.function?.arguments || '{}');
                } catch {
                  return {};
                }
              })(),
              result: JSON.parse(toolResults[i].content),
              iteration,
            })),
          );

          currentMessages = [
            ...currentMessages,
            {
              role: 'assistant',
              content: message.content || null,
              tool_calls: toolCalls,
            },
            ...toolResults,
          ];

          if (message.content) finalContent += message.content + '\n';
          continue;
        }

        finalContent += message.content || '';
        break;
      }

      const cleanContent =
        finalContent.trim() ||
        (allToolResults.length > 0
          ? 'Action completed successfully.'
          : 'Task completed.');

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Cache-Control', 'no-cache, no-transform');

        if (routedMeta) {
          res.write(
            `data: ${JSON.stringify({ meta: { routedModel: effectiveModel, routedMeta } })}\n\n`,
          );
        }

        // Stream text in responsive bursts
        const words = cleanContent.split(' ');
        for (let i = 0; i < words.length; i += 3) {
          const slice =
            words.slice(i, i + 3).join(' ') + (i + 3 < words.length ? ' ' : '');
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: slice } }] })}\n\n`,
          );
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          ok: true,
          model: effectiveModel,
          routedMeta,
          mode,
          iterations: iteration,
          message: {
            role: 'assistant',
            content: cleanContent,
            reasoning: finalReasoning,
          },
          toolExecutions: allToolResults,
        }),
      );
      return;
    } catch (err) {
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
  }

  // Pure SSE Streaming mode (when no tool calls needed)
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Cache-Control', 'no-cache, no-transform');

    try {
      if (routedMeta) {
        res.write(
          `data: ${JSON.stringify({ meta: { routedModel: effectiveModel, routedMeta } })}\n\n`,
        );
      }

      const payload = buildPayload({
        messages,
        mode,
        model: effectiveModel,
        images,
        systemPrompt,
        stream: true,
        temperature,
      });
      delete payload.tools;
      delete payload.tool_choice;

      let currentKey = apiKey;
      let response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${currentKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        currentKey = getNextApiKey() || currentKey;
        const fallbackPayload = {
          ...payload,
          model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
        };
        delete fallbackPayload.tools;
        delete fallbackPayload.tool_choice;
        delete fallbackPayload.chat_template_kwargs;

        response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${currentKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(fallbackPayload),
        });
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        res.write(
          `data: ${JSON.stringify({ error: `NVIDIA API error (${response.status}): ${errText}` })}\n\n`,
        );
        res.end();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
    return;
  }

  // Non-streaming mode with iterative tool execution loop
  try {
    let currentMessages = [...messages];
    let allToolResults = [];
    let finalContent = '';
    let finalReasoning = null;
    let iteration = 0;

    while (iteration < MAX_TOOL_ITERATIONS) {
      iteration++;

      const payload = buildPayload({
        messages: currentMessages,
        mode,
        model: effectiveModel,
        images: iteration === 1 ? images : [],
        systemPrompt,
        stream: false,
        temperature,
      });

      let currentKey = apiKey;
      let response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${currentKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      // Automatic failover on error (e.g. 401/404/410/422/429/500/503)
      if (!response.ok) {
        currentKey = getNextApiKey() || currentKey;
        const fallbackPayload = {
          ...payload,
          model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
        };
        delete fallbackPayload.chat_template_kwargs;

        response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${currentKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(fallbackPayload),
        });
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.statusCode = response.status || 502;
        res.end(
          JSON.stringify({
            error: `NVIDIA NIM API error (${response.status}): ${errText}`,
          }),
        );
        return;
      }

      const data = await response.json();
      const choice = data?.choices?.[0];
      const message = choice?.message || {};
      const toolCalls = message.tool_calls || [];
      finalReasoning = message.reasoning_content || finalReasoning;

      if (toolCalls.length > 0) {
        const toolResults = await executeToolCalls(toolCalls);
        allToolResults.push(
          ...toolCalls.map((tc, i) => ({
            name: tc.function?.name,
            args: (() => {
              try {
                return JSON.parse(tc.function?.arguments || '{}');
              } catch {
                return {};
              }
            })(),
            result: JSON.parse(toolResults[i].content),
            iteration,
          })),
        );

        currentMessages = [
          ...currentMessages,
          {
            role: 'assistant',
            content: message.content || null,
            tool_calls: toolCalls,
          },
          ...toolResults,
        ];

        if (message.content) finalContent += message.content + '\n';
        continue;
      }

      finalContent += message.content || '';
      break;
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        ok: true,
        model: effectiveModel,
        routedMeta,
        mode,
        iterations: iteration,
        message: {
          role: 'assistant',
          content: finalContent.trim() || 'Task completed.',
          reasoning: finalReasoning,
        },
        toolExecutions: allToolResults,
      }),
    );
  } catch (error) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 500;
    res.end(
      JSON.stringify({ error: error.message || 'Internal server error' }),
    );
  }
}
