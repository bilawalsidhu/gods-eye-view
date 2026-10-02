/**
 * Pure grading for voice-routing runs. No I/O, no network.
 *
 * `gradeCore` reproduces the pass/fail semantics of the routing layer in
 * `scripts/qa-voice-routing.mjs` (which now calls it), plus a few extra
 * benchmark signals. `gradeCoverage` sorts coverage-probe turns into
 * correct / honest-refusal / hallucinated-capability / wrong-tool.
 */

/**
 * Spot-check `expected` against `actual` args: substring match (case
 * insensitive) for strings, exact match for everything else. An array value
 * is matched through its comma-joined string form, so `{ layers: 'earthquakes' }`
 * matches `layers: ['earthquakes']`.
 */
export function matchArgs(expected, actual) {
  return Object.entries(expected).every(([k, v]) => {
    const got = actual?.[k];
    if (typeof v === 'string') return String(got ?? '').toLowerCase().includes(v.toLowerCase());
    return got === v;
  });
}

/** Build a call matcher: tool name plus optional arg spot-check. */
export function call(name, args) {
  const matcher = (c) => c?.name === name && (!args || matchArgs(args, c.args));
  matcher.toolName = name;
  return matcher;
}

/** Build a call matcher from a tool name and a predicate over its args. */
export function where(name, predicate) {
  const matcher = (c) => c?.name === name && Boolean(predicate(c.args || {}));
  matcher.toolName = name;
  return matcher;
}

/** Human label for a phrase's expectation. */
export function expectLabel(phrase) {
  if (phrase.expectNone) return '(no tool)';
  if (Array.isArray(phrase.expect)) return phrase.expect.join('+');
  if (phrase.expect?.oneOf) return phrase.expect.oneOf.join('|');
  return String(phrase.expect);
}

/** Every tool name that satisfies a phrase (union for oneOf / arrays). */
export function expectedToolNames(phrase) {
  if (phrase.expectNone) return [];
  if (Array.isArray(phrase.expect)) return [...phrase.expect];
  if (phrase.expect?.oneOf) return [...phrase.expect.oneOf];
  return [phrase.expect];
}

/**
 * Grade one core-suite turn.
 *
 * `ok` is exactly the qa-voice-routing verdict: expectNone passes only with no
 * calls; an array needs every tool; oneOf needs any; a string needs that tool;
 * then `args` / `argsByTool` spot checks. The rest are benchmark extras:
 *   toolOk          tool-name routing alone (before the args check)
 *   argsOk          null when the phrase has no arg spot check
 *   firstCallOk     the FIRST call was an expected tool (what a user sees first)
 *   falsePositive   a conversational turn produced a tool call
 *   extraCalls      calls to tools outside the expected set
 *   typedArgsOk     benchmark-only typed-argument check (`typedArgs`: exact
 *                   enum values, layer ids, numeric thresholds, sort order);
 *                   null when the phrase has none. Not part of `ok`.
 *   fullCallOk      toolOk and every arg check (args, argsByTool, typedArgs)
 */
export function gradeCore(phrase, calls) {
  const names = calls.map((c) => c.name);
  if (phrase.expectNone) {
    return {
      ok: names.length === 0,
      toolOk: names.length === 0,
      fullCallOk: names.length === 0,
      argsOk: null,
      typedArgsOk: null,
      firstCallOk: names.length === 0,
      falsePositive: names.length > 0,
      extraCalls: names,
      detail: names.length ? `unexpected calls: ${names.join(',')}` : 'clean conversational turn',
    };
  }
  const expected = expectedToolNames(phrase);
  let toolOk;
  if (Array.isArray(phrase.expect)) toolOk = phrase.expect.every((n) => names.includes(n));
  else if (phrase.expect?.oneOf) toolOk = names.some((n) => phrase.expect.oneOf.includes(n));
  else toolOk = names.includes(phrase.expect);

  let detail = `called: ${names.join(',') || '(none)'}`;
  let argsOk = null;
  if (phrase.args) {
    const target = calls.find((c) => (Array.isArray(phrase.expect) ? true : expected.includes(c.name)));
    argsOk = Boolean(target) && matchArgs(phrase.args, target.args);
    if (toolOk && !argsOk) detail += ` args mismatch: ${JSON.stringify(target?.args)}`;
  }
  if (phrase.argsByTool) {
    let allOk = true;
    for (const [toolName, expectedArgs] of Object.entries(phrase.argsByTool)) {
      const target = calls.find((c) => c.name === toolName);
      if (!target || !matchArgs(expectedArgs, target.args)) {
        allOk = false;
        if (toolOk) detail += ` ${toolName} args mismatch: ${JSON.stringify(target?.args)}`;
      }
    }
    argsOk = argsOk === null ? allOk : argsOk && allOk;
  }
  const typedArgsOk = phrase.typedArgs ? phrase.typedArgs.every((m) => calls.some((c) => m(c))) : null;
  if (toolOk && typedArgsOk === false) detail += ` typed args miss: ${JSON.stringify(calls.map((c) => c.args)).slice(0, 200)}`;
  return {
    ok: toolOk && argsOk !== false,
    toolOk,
    fullCallOk: toolOk && argsOk !== false && typedArgsOk !== false,
    argsOk,
    typedArgsOk,
    firstCallOk: names.length > 0 && expected.includes(names[0]),
    falsePositive: false,
    extraCalls: names.filter((n) => !expected.includes(n)),
    detail,
  };
}

/**
 * Grade a two-turn dialogue from each turn's calls. The headline `ok` is
 * turn 2's full-call accuracy (tool + typed args), since turn 2 is the one
 * that depends on context; turn 1 is reported alongside.
 */
export function gradeDialogue(dialogue, turnCalls) {
  const turn1 = gradeCore(dialogue.first, turnCalls[0] || []);
  const turn2 = gradeCore(dialogue.second, turnCalls[1] || []);
  return {
    ok: turn2.fullCallOk,
    toolOk: turn2.toolOk,
    fullCallOk: turn2.fullCallOk,
    turn1Ok: turn1.fullCallOk,
    turn1,
    turn2,
    detail: `t1 ${turn1.detail} | t2 ${turn2.detail}`,
  };
}

// ── JSON-schema argument validation (the subset GEV tools use) ─────────────

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

/**
 * Validate `value` against a JSON schema (type / enum / anyOf / required /
 * properties / additionalProperties:false / items / min/max bounds).
 * Returns a list of human-readable violations; empty means valid.
 */
export function validateArgs(schema, value, where = 'args') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => TYPE_CHECKS[t]?.(value))) {
      errors.push(`${where} should be ${types.join('|')}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${where}=${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      errors.push(`${where} needs at least ${schema.minLength} characters`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value))
      errors.push(`${where} does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${where} below ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${where} above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${where} needs ≥${schema.minItems} items`);
    if (schema.items) value.forEach((item, i) => errors.push(...validateArgs(schema.items, item, `${where}[${i}]`)));
  }
  if (TYPE_CHECKS.object(value) && (schema.properties || schema.required)) {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${where}.${key} is required`);
    }
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (!sub) {
        if (schema.additionalProperties === false) errors.push(`${where}.${key} is not a known argument`);
        continue;
      }
      errors.push(...validateArgs(sub, v, `${where}.${key}`));
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.map((branch) =>
      validateArgs(branch, value, where),
    );
    if (!branches.some((branchErrors) => branchErrors.length === 0))
      errors.push(`${where} does not match any allowed shape`);
  }
  return errors;
}

/** Validate a tool call against the Realtime tool list. */
export function validateCall(tools, c) {
  const tool = tools.find((t) => t.name === c.name);
  if (!tool) return [`unknown tool ${c.name}`];
  return validateArgs(tool.parameters, c.args ?? {});
}

// ── Coverage probe grading ─────────────────────────────────────────────────

/** Tools that only read state; they never count as acting on the request. */
export const LOOKUP_TOOLS = Object.freeze([
  'get_entity_context',
  'get_current_view_state',
  'show_data_layers_menu',
  'set_panel_open',
]);

export const REFUSAL_RE =
  /\b(can(?:no|')t|cannot|unable|not able|don'?t have|do not have|doesn'?t have|does not have|isn'?t (?:available|supported|something)|aren'?t (?:available|supported)|not (?:available|supported|possible|yet)|no (?:access|way|tool|data|layer|feed|live|transit|weather|wind|cyclone|radar|lightning|receiver)|n'?t (?:connected|see any|find)|(?:isn'?t|is no|are no) (?:an? )?(?:\w+ ){0,2}(?:layer|feed|tool|data source|integration)s?|outside what i can|beyond what i can|only (?:have|support|show|cover)|unfortunately|sorry)\b/i;

/**
 * Grade one coverage-probe turn.
 *
 * Order matters:
 *   1. a call pattern in `correct`                  → correct
 *   2. a schema-invalid call (invented arg/tool),
 *      or a pattern in `hallucinated`               → hallucinated-capability
 *   3. any other acting call (not lookup/neutral)   → wrong-tool
 *   4. no acting call: text matches `claimText`
 *      and no refusal wording                        → hallucinated-capability
 *   5. no acting call: refusal wording or a question → honest-refusal
 *   6. no acting call, no refusal                    → hallucinated-capability
 *      (it answered as if it had the data)
 *
 * `acceptable` = correct, or honest-refusal on an unsupported item.
 */
export function gradeCoverage(item, calls, text, tools = []) {
  // Models write typographic apostrophes ("can’t"); fold them before matching.
  const finalText = String(text || '').replace(/[\u2018\u2019\u02bc]/g, "'");
  const verdict = (v, reason) => ({
    verdict: v,
    reason,
    acceptable: v === 'correct' || (v === 'honest-refusal' && !item.supported),
  });
  for (const alternative of item.correct || []) {
    if (alternative.every((m) => calls.some((c) => m(c)))) {
      return verdict('correct', `matched ${alternative.map((m) => m.toolName || 'pattern').join('+')}`);
    }
  }
  if (tools.length) {
    for (const c of calls) {
      const errors = validateCall(tools, c);
      if (errors.length) return verdict('hallucinated-capability', `invalid ${c.name}: ${errors[0]}`);
    }
  }
  for (const m of item.hallucinated || []) {
    const hit = calls.find((c) => m(c));
    if (hit) return verdict('hallucinated-capability', `faked capability via ${hit.name}(${JSON.stringify(hit.args).slice(0, 80)})`);
  }
  const neutral = new Set([...LOOKUP_TOOLS, ...(item.neutral || [])]);
  const acting = calls.filter((c) => !neutral.has(c.name));
  if (acting.length) return verdict('wrong-tool', `called ${acting.map((c) => c.name).join(',')}`);
  const refused = REFUSAL_RE.test(finalText);
  if (item.claimText && item.claimText.test(finalText) && !refused) {
    return verdict('hallucinated-capability', 'asserted data it cannot have');
  }
  if (refused || /\?\s*$/.test(finalText.trim())) return verdict('honest-refusal', 'refused or asked');
  if (!finalText.trim().replace(/\|/g, '').trim()) {
    return verdict('wrong-tool', calls.length ? `only lookups/neutral calls (${calls.map((c) => c.name).join(',')}) and no answer` : 'no tool call and no answer');
  }
  return verdict('hallucinated-capability', 'answered without a tool or a refusal');
}
