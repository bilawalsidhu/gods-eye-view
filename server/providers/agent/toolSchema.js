/**
 * Reshapes the Realtime tool definitions for the chat-completions surface and
 * validates what a model sends back before it reaches the browser.
 *
 * Validation is not defensive decoration. Hosted models rarely violate these
 * schemas; local models routinely do, and Ollama's OpenAI-compatible endpoint
 * does not accept `tool_choice`, so a malformed call cannot be prevented, only
 * caught and handed back. Correcting it here keeps the retry off the browser
 * round trip and out of the visible transcript.
 *
 * The supported JSON Schema subset is exactly what the GEV action schemas use:
 * type, properties, required, additionalProperties, enum, items, minimum,
 * maximum, minItems, maxItems and maxLength. Anything broader would be
 * untested surface area.
 */

/**
 * Convert Realtime-shaped tool definitions to chat-completions shape.
 *
 * Realtime puts name/description/parameters at the top level; chat completions
 * nests them under `function`. Nothing else differs, so the action schemas are
 * reused verbatim rather than restated.
 *
 * @param {Array<{type?:string,name:string,description?:string,parameters?:object}>} realtimeTools
 * @returns {Array<{type:'function', function:{name:string,description:string,parameters:object}}>}
 */
function toChatCompletionTools(realtimeTools) {
  if (!Array.isArray(realtimeTools)) return [];
  return realtimeTools
    .filter((tool) => tool && typeof tool.name === 'string' && tool.name)
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description:
          typeof tool.description === 'string' ? tool.description : '',
        parameters:
          tool.parameters && typeof tool.parameters === 'object'
            ? tool.parameters
            : { type: 'object', properties: {} },
      },
    }));
}

/**
 * Index tool definitions by name for schema lookup during dispatch.
 *
 * @param {Array<{name?: string}>} realtimeTools
 * @returns {Map<string, object>}
 */
function indexToolsByName(realtimeTools) {
  const index = new Map();
  for (const tool of Array.isArray(realtimeTools) ? realtimeTools : []) {
    if (tool && typeof tool.name === 'string' && tool.name)
      index.set(tool.name, tool);
  }
  return index;
}

/** JSON Schema `type` to a predicate over runtime values. */
const TYPE_CHECKS = Object.freeze({
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => typeof value === 'number' && Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  object: (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  null: (value) => value === null,
});

/** Render a path for error messages. */
function joinPath(path, segment) {
  if (!path) return String(segment);
  return typeof segment === 'number'
    ? `${path}[${segment}]`
    : `${path}.${segment}`;
}

/** Human-readable runtime type for error text. */
function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Validate a value against the supported subset.
 *
 * @param {object} schema
 * @param {unknown} value
 * @param {string} path
 * @param {Array<{path:string,message:string}>} errors Accumulator.
 */
function validateValue(schema, value, path, errors) {
  if (!schema || typeof schema !== 'object') return;

  if (typeof schema.type === 'string') {
    const check = TYPE_CHECKS[schema.type];
    if (check && !check(value)) {
      errors.push({
        path,
        message: `expected ${schema.type}, received ${describeType(value)}`,
      });
      return;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push({ path, message: `must be one of: ${schema.enum.join(', ')}` });
    return;
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push({ path, message: `must be <= ${schema.maximum}` });
    }
  }

  if (
    typeof value === 'string' &&
    typeof schema.maxLength === 'number' &&
    value.length > schema.maxLength
  ) {
    errors.push({
      path,
      message: `must be at most ${schema.maxLength} characters`,
    });
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push({
        path,
        message: `must have at least ${schema.minItems} items`,
      });
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push({
        path,
        message: `must have at most ${schema.maxItems} items`,
      });
    }
    if (schema.items) {
      value.forEach((entry, index) =>
        validateValue(schema.items, entry, joinPath(path, index), errors),
      );
    }
  }

  if (
    TYPE_CHECKS.object(value) &&
    schema.properties &&
    typeof schema.properties === 'object'
  ) {
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) {
        errors.push({ path: joinPath(path, key), message: 'is required' });
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) {
          errors.push({
            path: joinPath(path, key),
            message: 'is not a recognized parameter',
          });
        }
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key) && value[key] !== undefined) {
        validateValue(childSchema, value[key], joinPath(path, key), errors);
      }
    }
  }
}

/**
 * Validate tool-call arguments against that tool's schema.
 *
 * @param {object|undefined} schema The tool's `parameters` schema.
 * @param {unknown} args
 * @returns {{valid: boolean, errors: Array<{path:string,message:string}>}}
 */
function validateToolArguments(schema, args) {
  const errors = [];
  if (!schema || typeof schema !== 'object') return { valid: true, errors };
  validateValue(schema, args, '', errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Strip a Markdown code fence from an argument payload.
 *
 * Local models frequently wrap JSON in a ```json fence despite the tool-call
 * contract. Recovering here turns a hard failure into a successful call.
 */
function stripCodeFence(text) {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return fenced ? fenced[1] : text;
}

/**
 * Parse the `arguments` string from a tool call.
 *
 * Tolerates the two malformations that actually occur: an empty string for a
 * no-argument tool, and a fenced JSON block.
 *
 * @param {string|object|undefined} raw
 * @returns {{ok: true, args: object} | {ok: false, error: string}}
 */
function parseToolArguments(raw) {
  if (raw === undefined || raw === null || raw === '')
    return { ok: true, args: {} };
  if (typeof raw === 'object') {
    return Array.isArray(raw)
      ? {
          ok: false,
          error: 'arguments must be a JSON object, received an array',
        }
      : { ok: true, args: raw };
  }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      error: `arguments must be a JSON object string, received ${describeType(raw)}`,
    };
  }
  const text = stripCodeFence(raw).trim();
  if (!text) return { ok: true, args: {} };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `arguments were not valid JSON: ${error.message}`,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `arguments must be a JSON object, received ${describeType(parsed)}`,
    };
  }
  return { ok: true, args: parsed };
}

/**
 * Compact validation failures into a correction the model can act on.
 *
 * Kept terse and imperative: this text is resent as a tool result and counts
 * against the context budget on every retry.
 *
 * @param {Array<{path:string,message:string}>} errors
 * @param {{maxErrors?: number}} [options]
 * @returns {string}
 */
function describeValidationErrors(errors, { maxErrors = 6 } = {}) {
  const list = Array.isArray(errors) ? errors : [];
  if (!list.length) return '';
  const shown = list
    .slice(0, maxErrors)
    .map(({ path, message }) => (path ? `${path} ${message}` : message))
    .join('; ');
  const omitted = list.length - maxErrors;
  return omitted > 0 ? `${shown}; and ${omitted} more` : shown;
}

/**
 * Prepare one model tool call for dispatch.
 *
 * Returns either arguments ready for the action runner, or the exact text to
 * hand back as the tool result so the model can correct itself.
 *
 * @param {{name?: string, arguments?: string}} call The call's `function` field.
 * @param {Map<string, object>} toolIndex
 * @returns {{ok: true, name: string, args: object} | {ok: false, error: string}}
 */
function prepareToolCall(call, toolIndex) {
  const name = typeof call?.name === 'string' ? call.name.trim() : '';
  if (!name)
    return { ok: false, error: 'Tool call is missing a function name.' };

  const definition = toolIndex instanceof Map ? toolIndex.get(name) : null;
  if (!definition) {
    return {
      ok: false,
      error: `Unknown tool "${name}". Choose one of the provided tools.`,
    };
  }

  const parsed = parseToolArguments(call.arguments);
  if (!parsed.ok)
    return {
      ok: false,
      error: `Invalid arguments for ${name}: ${parsed.error}`,
    };

  const { valid, errors } = validateToolArguments(
    definition.parameters,
    parsed.args,
  );
  if (!valid) {
    return {
      ok: false,
      error: `Invalid arguments for ${name}: ${describeValidationErrors(errors)}`,
    };
  }

  return { ok: true, name, args: parsed.args };
}

export {
  describeValidationErrors,
  indexToolsByName,
  parseToolArguments,
  prepareToolCall,
  toChatCompletionTools,
  validateToolArguments,
};
