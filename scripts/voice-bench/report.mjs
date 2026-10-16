/**
 * Pure aggregation of benchmark rows into summary.json / summary.md.
 * Rows: `{ type:'run', ... }` run metadata and `{ type:'turn', ... }` turns.
 */

export function percentile(values, p) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[idx];
}

const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const sum = (xs) => xs.reduce((a, b) => a + (Number(b) || 0), 0);
const mean = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return v.length ? sum(v) / v.length : null;
};
const round = (x, d = 0) => (x === null || x === undefined ? null : Math.round(x * 10 ** d) / 10 ** d);

export const COVERAGE_VERDICTS = Object.freeze(['correct', 'honest-refusal', 'hallucinated-capability', 'wrong-tool']);

export function modelKey(row) {
  return `${row.provider}:${row.model}${row.variant ? `#${row.variant}` : ''}`;
}

/** Aggregate turn rows into one summary entry per provider×model(×variant). */
export function summarize(rows) {
  const runs = rows.filter((r) => r.type === 'run');
  const turns = rows.filter((r) => r.type === 'turn');
  const keys = [...new Set(turns.map(modelKey))];
  const models = keys.map((key) => {
    const mine = turns.filter((t) => modelKey(t) === key);
    const core = mine.filter((t) => t.suite === 'core');
    const cov = mine.filter((t) => t.suite === 'coverage');
    const dia = mine.filter((t) => t.suite === 'dialogue');
    const capAll = mine.filter((t) => t.suite === 'capability');
    // Latency percentiles stay on the core + coverage phrase sets so runs of
    // different builds remain comparable.
    const single = mine.filter((t) => t.suite === 'core' || t.suite === 'coverage');
    const covV2 = cov.filter((t) => t.gradeV2);
    const reps = [...new Set(core.map((t) => t.rep))].sort((a, b) => a - b);
    const withCall = single.filter((t) => t.tFirstCallMs !== null && t.tFirstCallMs !== undefined);
    const typed = core.filter((t) => t.grade?.typedArgsOk !== null && t.grade?.typedArgsOk !== undefined);
    const diaFailures = dia.filter((t) => !t.grade?.ok).map((t) => ({
      id: t.phraseId, rep: t.rep, expect: t.expect,
      turn1: (t.turn1?.calls || []).map((c) => `${c.name}(${JSON.stringify(c.args).slice(0, 80)})`).join(', ') || '(none)',
      turn2: (t.calls || []).map((c) => `${c.name}(${JSON.stringify(c.args).slice(0, 80)})`).join(', ') || '(none)',
    }));
    const coverageV2Counts = Object.fromEntries(COVERAGE_VERDICTS.map((v) => [v, covV2.filter((t) => t.gradeV2?.verdict === v).length]));
    const capFailures = {};
    for (const t of capAll.filter((x) => !x.grade?.fullCallOk)) {
      const k = t.phraseId;
      capFailures[k] = capFailures[k] || { id: k, expect: t.expect, fails: 0, of: capAll.filter((x) => x.phraseId === k).length, called: [] };
      capFailures[k].fails += 1;
      capFailures[k].called.push((t.calls || []).map((c) => `${c.name}(${JSON.stringify(c.args).slice(0, 70)})`).join(', ') || '(none)');
    }
    const coverageCounts = Object.fromEntries(COVERAGE_VERDICTS.map((v) => [v, cov.filter((t) => t.grade?.verdict === v).length]));
    const coreFailures = {};
    for (const t of core.filter((x) => !x.grade?.ok)) {
      const k = t.phrase;
      coreFailures[k] = coreFailures[k] || { phrase: k, expect: t.expect, fails: 0, of: core.filter((x) => x.phrase === k).length, called: [] };
      coreFailures[k].fails += 1;
      coreFailures[k].called.push((t.calls || []).map((c) => c.name).join(',') || '(none)');
    }
    const covByItem = {};
    for (const t of cov) {
      covByItem[t.phraseId] = covByItem[t.phraseId] || { id: t.phraseId, utterance: t.phrase, supported: t.supported, verdicts: [] };
      covByItem[t.phraseId].verdicts.push(t.grade?.verdict);
    }
    const run = runs.filter((r) => modelKey(r) === key).at(-1) || {};
    const local = mine.filter((t) => t.local);
    return {
      key,
      provider: mine[0].provider,
      model: mine[0].model,
      variant: mine[0].variant || null,
      settings: run.settings || null,
      machine: run.machine || null,
      warmup: run.warmup || null,
      turns: mine.length,
      core: {
        n: core.length,
        reps: reps.length,
        accuracyPct: pct(core.filter((t) => t.grade?.ok).length, core.length),
        toolAccuracyPct: pct(core.filter((t) => t.grade?.toolOk).length, core.length),
        fullCallAccuracyPct: pct(core.filter((t) => t.grade?.fullCallOk).length, core.length),
        typedArgsAccuracyPct: pct(typed.filter((t) => t.grade?.typedArgsOk).length, typed.length),
        typedArgsN: typed.length,
        argsAccuracyPct: pct(core.filter((t) => t.grade?.argsOk === true).length, core.filter((t) => t.grade?.argsOk !== null && t.grade?.argsOk !== undefined).length),
        firstCallAccuracyPct: pct(core.filter((t) => t.grade?.firstCallOk).length, core.length),
        falsePositives: core.filter((t) => t.grade?.falsePositive).length,
        negativeTurns: core.filter((t) => t.expectNone).length,
        perRepAccuracyPct: reps.map((rep) => {
          const r = core.filter((t) => t.rep === rep);
          return pct(r.filter((t) => t.grade?.ok).length, r.length);
        }),
        failures: Object.values(coreFailures).sort((a, b) => b.fails - a.fails),
      },
      coverage: {
        n: cov.length,
        counts: coverageCounts,
        acceptablePct: pct(cov.filter((t) => t.grade?.acceptable).length, cov.length),
        supportedCorrectPct: pct(cov.filter((t) => t.supported && t.grade?.verdict === 'correct').length, cov.filter((t) => t.supported).length),
        unsupportedHonestPct: pct(cov.filter((t) => !t.supported && t.grade?.acceptable).length, cov.filter((t) => !t.supported).length),
        items: Object.values(covByItem),
      },
      coverageV2: {
        n: covV2.length,
        counts: coverageV2Counts,
        acceptablePct: pct(covV2.filter((t) => t.gradeV2?.acceptable).length, covV2.length),
      },
      capability: {
        n: capAll.length,
        toolPct: pct(capAll.filter((t) => t.grade?.toolOk).length, capAll.length),
        fullPct: pct(capAll.filter((t) => t.grade?.fullCallOk).length, capAll.length),
        failures: Object.values(capFailures).sort((a, b) => b.fails - a.fails),
      },
      prompt: run.prompt || null,
      dialogue: {
        n: dia.length,
        turn2FullPct: pct(dia.filter((t) => t.grade?.fullCallOk).length, dia.length),
        turn2ToolPct: pct(dia.filter((t) => t.grade?.toolOk).length, dia.length),
        turn1FullPct: pct(dia.filter((t) => t.grade?.turn1Ok).length, dia.length),
        turn2ToolCallP50: percentile(dia.map((t) => t.tFirstCallMs), 50),
        failures: diaFailures,
      },
      latencyMs: {
        scope: 'single-turn phrases (core + coverage); send → event, text mode',
        firstTokenP50: percentile(single.map((t) => t.tFirstTokenMs), 50),
        firstTokenP90: percentile(single.map((t) => t.tFirstTokenMs), 90),
        toolCallP50: percentile(withCall.map((t) => t.tFirstCallMs), 50),
        toolCallP90: percentile(withCall.map((t) => t.tFirstCallMs), 90),
        turnDoneP50: percentile(single.map((t) => t.tDoneMs), 50),
        turnDoneP90: percentile(single.map((t) => t.tDoneMs), 90),
        setupP50: percentile(single.map((t) => t.setupMs), 50),
      },
      tokens: {
        input: sum(mine.map((t) => t.usage?.inputTokens)),
        cached: sum(mine.map((t) => t.usage?.cachedTokens)),
        output: sum(mine.map((t) => t.usage?.outputTokens)),
        reasoning: sum(mine.map((t) => t.usage?.reasoningTokens)),
        inputPerTurnMean: round(mean(mine.map((t) => t.usage?.inputTokens))),
        inputPerRequestMean: round(mean(single.filter((t) => t.responses > 0 && t.usage?.inputTokens).map((t) => t.usage.inputTokens / t.responses))),
      },
      costUsd: round(sum(mine.map((t) => t.costUsd)), 4),
      costPerTurnUsd: mine.length ? round(sum(mine.map((t) => t.costUsd)) / mine.length, 5) : null,
      errors: mine.filter((t) => t.errors?.length).length,
      timeouts: mine.filter((t) => t.timeout).length,
      local: local.length
        ? {
            prefillTokSMean: round(mean(local.map((t) => t.local.prefillTokS)), 1),
            prefillTokSP50: round(percentile(local.map((t) => t.local.prefillTokS), 50), 0),
            decodeTokSMean: round(mean(local.map((t) => t.local.decodeTokS)), 1),
            decodeTokSP50: round(percentile(local.map((t) => t.local.decodeTokS), 50), 1),
            decodeTokSP90: round(percentile(local.map((t) => t.local.decodeTokS), 90), 1),
          }
        : null,
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    cloudSpendUsd: round(sum(turns.filter((t) => t.cloud).map((t) => t.costUsd)), 4),
    models,
  };
}

const machineBrief = (machine) => {
  if (!machine) return '—';
  const load1 = String(machine.loadavg || '').split(' ')[0] || '?';
  const busy = (machine.busyProcesses || []).filter((p) => Number(p.match(/([\d.]+)%cpu/)?.[1]) >= 100)
    .map((p) => p.replace(/ Helper \(GPU\)/, ' GPU').replace(/Google Chrome for Testing/, 'Chrome-for-Testing'));
  return `load ${load1}${busy.length ? `; ${busy.join(', ')}` : ''}`;
};
const fmtCounts = (block) => (block?.n
  ? `${block.counts.correct} / ${block.counts['honest-refusal']} / ${block.counts['hallucinated-capability']} / ${block.counts['wrong-tool']} (n=${block.n})`
  : '—');
const fmtMs = (v) => (v === null || v === undefined ? '—' : v >= 10_000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);
const fmtPct = (v) => (v === null || v === undefined ? '—' : `${v}%`);

/** Render summary.md from a summarize() result plus free-form notes. */
export function renderMarkdown(summary, { title = 'GEV voice-routing benchmark', notes = [], payload = [] } = {}) {
  const out = [`# ${title}`, '', `Generated ${summary.generatedAt}. Cloud spend so far: **$${summary.cloudSpendUsd?.toFixed(2)}**.`, ''];
  out.push('> **What this measures.** Tool CHOICE for text turns sent over each provider\'s API with production\'s instructions and tools, with stubbed (always-successful) tool results — the same method as `qa-voice-routing.mjs` layer 1. It is **not** end-to-end spoken accuracy (no speech recognition, no audio, no screenshot/scene context) and **not** spoken latency: every latency below is "send text → event", before any audio would be synthesized or played.', '');
  out.push('## Routing accuracy', '');
  out.push('| model | core tool-name | core full-call (tool + all arg checks) | typed args (n) | harness verdict (legacy) | first call right | false +ve | per-rep harness verdict | dialogue turn-2 full-call | dialogue turn-1 | coverage v1 C / HR / HC / WT | coverage v1 acceptable | coverage v2 C / HR / HC / WT | coverage v2 acceptable | capability tool / full-call |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const m of summary.models) {
    const c = m.coverage.counts;
    out.push(`| ${m.key} | ${fmtPct(m.core.toolAccuracyPct)} | ${fmtPct(m.core.fullCallAccuracyPct)} | ${fmtPct(m.core.typedArgsAccuracyPct)} (${m.core.typedArgsN}) | ${fmtPct(m.core.accuracyPct)} (n=${m.core.n}) | ${fmtPct(m.core.firstCallAccuracyPct)} | ${m.core.falsePositives}/${m.core.negativeTurns} | ${m.core.perRepAccuracyPct.map(fmtPct).join(', ')} | ${fmtPct(m.dialogue.turn2FullPct)} (n=${m.dialogue.n}) | ${fmtPct(m.dialogue.turn1FullPct)} | ${c.correct} / ${c['honest-refusal']} / ${c['hallucinated-capability']} / ${c['wrong-tool']} (n=${m.coverage.n}) | ${fmtPct(m.coverage.acceptablePct)} | ${fmtCounts(m.coverageV2)} | ${fmtPct(m.coverageV2.acceptablePct)} | ${m.capability.n ? `${fmtPct(m.capability.toolPct)} / ${fmtPct(m.capability.fullPct)} (n=${m.capability.n})` : '—'} |`);
  }
  out.push('', 'Core tool-name = right tool(s) called. Full-call = right tool(s) AND every argument check (the legacy `args` spot checks plus the benchmark\'s typed checks: exact layer ids, enum values, numeric thresholds, sort direction). Legacy harness verdict = exactly what `qa-voice-routing.mjs` would report. Coverage: C = correct, HR = honest refusal, HC = hallucinated capability, WT = wrong tool; "acceptable" = correct, or an honest refusal where today\'s tools cannot do it.', '');
  out.push('## Latency and cost', '');
  out.push('| model | p50 send → first token (text) | p50 send → tool call (text) | p90 send → tool call (text) | p50 send → turn done (text) | dialogue turn-2 p50 → tool call | session setup p50 | input tok/turn | $ total | $/turn |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const m of summary.models) {
    out.push(`| ${m.key} | ${fmtMs(m.latencyMs.firstTokenP50)} | ${fmtMs(m.latencyMs.toolCallP50)} | ${fmtMs(m.latencyMs.toolCallP90)} | ${fmtMs(m.latencyMs.turnDoneP50)} | ${fmtMs(m.dialogue.turn2ToolCallP50)} | ${fmtMs(m.latencyMs.setupP50)} | ${m.tokens.inputPerTurnMean ?? '—'} | ${m.costUsd?.toFixed(3)} | ${m.costPerTurnUsd ?? '—'} |`);
  }
  out.push('', 'Latencies are over single-turn phrases (core + coverage). "Turn done" includes the continuation response after the stubbed tool result. Cloud session setup (WebSocket + session config) is excluded from every latency and shown separately.', '');
  const locals = summary.models.filter((m) => m.local);
  if (locals.length) {
    out.push('## Local runtime (cold vs warm)', '');
    out.push('| model | load (wall) | COLD: first request after load → tool call | cold prefill tok/s (full prompt) | prompt tokens | WARM p50 → tool call | WARM p90 → tool call | warm per-turn prefill tok/s p50 | decode tok/s p50 / p90 | machine at start |');
    out.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const m of locals) {
      const w = m.warmup || {};
      out.push(`| ${m.key} | ${fmtMs(w.loadWallMs ?? w.loadMs)} | ${fmtMs(w.coldToolCallMs ?? w.warmupTurnMs)}${w.coldToolCallMs == null ? ' (turn, no tool)' : ''} | ${w.prefillTokS ? Math.round(w.prefillTokS) : '—'} | ${w.promptTokens ?? '—'} | ${fmtMs(m.latencyMs.toolCallP50)} | ${fmtMs(m.latencyMs.toolCallP90)} | ${m.local.prefillTokSP50 ?? '—'} | ${m.local.decodeTokSP50 ?? '—'} / ${m.local.decodeTokSP90 ?? '—'} | ${machineBrief(m.machine)} |`);
    }
    out.push('', 'COLD = the first request after the model is loaded (pays the full ~11k-token prompt prefill). WARM = every later turn. "Warm per-turn prefill tok/s" is prompt tokens ÷ prompt-eval time as the runtime reports it: a value in the tens of thousands means the cached prompt prefix was reused and only the new user text was prefilled; a value near the cold rate means the WHOLE prompt was re-prefilled on every turn. A real voice session pays the cold cost once per model load. "Machine at start" = 1-minute load average and processes above 100% CPU when the run began (other GPU/CPU users on the machine inflate local timings).', '');
  }
  if (payload.length) {
    out.push('## Payload changes per provider', '');
    for (const p of payload) out.push(`- ${p}`);
    out.push('');
  }
  out.push('## Failures by model', '');
  for (const m of summary.models) {
    out.push(`### ${m.key}`, '');
    out.push(`Settings: \`${JSON.stringify(m.settings)}\``, '');
    if (m.errors || m.timeouts) out.push(`Errors: ${m.errors} turns, timeouts: ${m.timeouts}.`, '');
    if (m.core.failures.length) {
      out.push('Core misses (legacy verdict):', '');
      for (const f of m.core.failures) out.push(`- "${f.phrase}" (expect ${f.expect}) — failed ${f.fails}/${f.of}; called: ${f.called.join(' ; ')}`);
      out.push('');
    }
    if (m.capability.failures.length) {
      out.push('Capability misses (full call):', '');
      for (const f of m.capability.failures) out.push(`- "${f.id}" (expect ${f.expect}) — failed ${f.fails}/${f.of}; called: ${f.called.join(' ; ').slice(0, 400)}`);
      out.push('');
    }
    if (m.dialogue.failures.length) {
      out.push('Dialogue misses (turn 2):', '');
      for (const f of m.dialogue.failures) out.push(`- ${f.id} rep ${f.rep} (expect ${f.expect}) — t1: ${f.turn1} ⇒ t2: ${f.turn2}`);
      out.push('');
    }
    const badCov = m.coverage.items.filter((i) => i.verdicts.some((v) => v === 'hallucinated-capability' || v === 'wrong-tool' || (i.supported && v !== 'correct')));
    if (badCov.length) {
      out.push('Coverage misses:', '');
      for (const i of badCov) out.push(`- "${i.utterance}" (${i.supported ? 'supported' : 'unsupported'}) — ${i.verdicts.join(', ')}`);
      out.push('');
    }
  }
  if (notes.length) {
    out.push('## Notes', '');
    for (const n of notes) out.push(`- ${n}`);
    out.push('');
  }
  return out.join('\n');
}

/**
 * Before → after table for two summarize() results (matched by model key).
 * Coverage "before" is the v1 rubric (what the old tools could do); "after"
 * shows both v1 (same yardstick) and v2 (the current tool surface).
 */
export function renderComparison(before, after, { beforeLabel = 'before', afterLabel = 'after' } = {}) {
  const out = ['## Before → after', '', `Before = ${beforeLabel}; after = ${afterLabel}. Core accuracy = tool + all argument checks (full call). Coverage OK % = correct, or an honest refusal where the tools of that build cannot do it. HC = hallucinated-capability count. p50 = send → tool call (text). Prompt tokens = mean input tokens per model request (cloud: as billed, before cache discounts; local: the cold full-prompt count).`, ''];
  out.push('| model | core full-call | coverage OK % (v1 → v1 / v2) | HC (v1 → v1 / v2) | dialogue turn-2 | capability full-call (after) | p50 → tool call | prompt tokens |');
  out.push('|---|---|---|---|---|---|---|---|');
  const hc = (block) => (block?.n ? block.counts['hallucinated-capability'] : null);
  const promptTok = (m) => (m?.warmup?.promptTokens ?? m?.tokens?.inputPerRequestMean ?? null);
  for (const a of after.models) {
    const b = before.models.find((x) => x.key === a.key);
    const arrow = (x, y, f) => `${f(x)} → ${f(y)}`;
    const pctF = (v) => (v === null || v === undefined ? '—' : `${v}%`);
    const msF = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)}ms`);
    const num = (v) => (v === null || v === undefined ? '—' : String(v));
    out.push(`| ${a.key} | ${arrow(b?.core.fullCallAccuracyPct, a.core.fullCallAccuracyPct, pctF)} | ${pctF(b?.coverage.acceptablePct)} → ${pctF(a.coverage.acceptablePct)} / ${pctF(a.coverageV2.acceptablePct)} | ${num(hc(b?.coverage))} → ${num(hc(a.coverage))} / ${num(hc(a.coverageV2))} | ${arrow(b?.dialogue.turn2FullPct, a.dialogue.turn2FullPct, pctF)} | ${pctF(a.capability.fullPct)} | ${arrow(b?.latencyMs.toolCallP50, a.latencyMs.toolCallP50, msF)} | ${arrow(promptTok(b), promptTok(a), num)} |`);
  }
  out.push('');
  return out.join('\n');
}
