/**
 * Tool definitions and their composition into a callable catalog.
 *
 * A tool declares what it does, its arguments, and which services it reads.
 * It knows nothing about the surface that exposes it (MCP, voice) or the
 * transport its services use. Applications compose the tools they want with
 * the services they supply, plus optional interceptors that wrap every call.
 */

import { assertSupportedSchema, validateValue } from './schema.js';

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const KINDS = new Set(['query', 'action']);
/** Who may call a tool, as MCP Apps names them: the model, the app's panel. */
const VISIBILITY = new Set(['model', 'app']);

/** Error codes a tool may report. Each is safe to show to a model or person. */
export const TOOL_ERROR_CODES = Object.freeze([
  'invalid_arguments',
  'unavailable',
  'unsupported',
  'malformed',
  'retry_later',
]);

/** An expected failure with a stable code and a message written for the caller. */
export class ToolError extends Error {
  constructor(code, message, { retryAfterSeconds = null } = {}) {
    if (!TOOL_ERROR_CODES.includes(code))
      throw new TypeError(`Unknown tool error code: ${code}`);
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Live sources report failures with these codes (src/sources/live/contract.js).
const SOURCE_ERROR_CODES = {
  limited: 'retry_later',
  denied: 'unavailable',
  unavailable: 'unavailable',
  malformed: 'malformed',
  unsupported: 'unsupported',
};

/** Translate a source failure into a tool error; other errors pass through. */
export function fromSourceError(error) {
  const code =
    error?.name === 'LiveSourceError' &&
    Object.hasOwn(SOURCE_ERROR_CODES, error.code)
      ? SOURCE_ERROR_CODES[error.code]
      : null;
  if (!code) return error;
  const retryAfterSeconds =
    code === 'retry_later' && Number.isFinite(error.retryAfterMs)
      ? Math.ceil(error.retryAfterMs / 1000)
      : null;
  return new ToolError(code, error.message, { retryAfterSeconds });
}

/**
 * Validate and freeze a tool definition.
 *
 * `run(args, { services, signal, tools })` resolves to `{ summary, data }`: a
 * short sentence for people and a structured object for programs. It may add
 * `images`, each `{ mimeType, data }` with base64 data. `tools` reaches other
 * tools through the same catalog: `tools.has(name)` and
 * `tools.call(name, args)`.
 */
export function defineTool({
  name,
  kind = 'query',
  title,
  description,
  inputSchema,
  annotations = {},
  requires = [],
  ui = null,
  run,
}) {
  if (!TOOL_NAME.test(String(name)))
    throw new TypeError(`Invalid tool name: ${name}`);
  if (!KINDS.has(kind)) throw new TypeError(`Invalid tool kind: ${kind}`);
  if (typeof title !== 'string' || !title)
    throw new TypeError(`${name} needs a title`);
  if (typeof description !== 'string' || !description)
    throw new TypeError(`${name} needs a description`);
  assertSupportedSchema(inputSchema, `${name}.inputSchema`);
  if (inputSchema.type !== 'object')
    throw new TypeError(`${name}.inputSchema must describe an object`);
  if (
    !Array.isArray(requires) ||
    requires.some((key) => typeof key !== 'string')
  )
    throw new TypeError(`${name}.requires must list service names`);
  if (typeof run !== 'function') throw new TypeError(`${name} needs run()`);
  if (ui !== null) {
    if (
      ui?.resourceUri !== undefined &&
      !(
        typeof ui.resourceUri === 'string' && ui.resourceUri.startsWith('ui://')
      )
    )
      throw new TypeError(`${name}.ui.resourceUri must be a ui:// URI`);
    if (
      ui?.visibility !== undefined &&
      !(
        Array.isArray(ui.visibility) &&
        ui.visibility.length > 0 &&
        ui.visibility.every((who) => VISIBILITY.has(who))
      )
    )
      throw new TypeError(`${name}.ui.visibility must list model and/or app`);
    if (ui?.resourceUri === undefined && ui?.visibility === undefined)
      throw new TypeError(`${name}.ui needs a resourceUri or a visibility`);
  }
  return Object.freeze({
    name,
    kind,
    title,
    description,
    inputSchema: structuredClone(inputSchema),
    annotations: Object.freeze({
      readOnlyHint: kind === 'query',
      ...annotations,
    }),
    requires: Object.freeze([...requires]),
    ui: ui
      ? Object.freeze({
          ...(ui.resourceUri ? { resourceUri: ui.resourceUri } : {}),
          ...(ui.visibility
            ? { visibility: Object.freeze([...ui.visibility]) }
            : {}),
        })
      : null,
    run,
  });
}

/**
 * Compose tools with the services an application supplies.
 *
 * - Duplicate names fail unless the later tool is listed in `replace`.
 * - Tools whose required services are missing are left out.
 * - Interceptors wrap every call in order, outermost first, as
 *   `(call, next) => next(call)` where `call` is `{ tool, args, signal }`,
 *   plus `parent`, the calling tool's name, when one tool calls another.
 */
export function composeCatalog({
  tools,
  replace = [],
  services = {},
  interceptors = [],
}) {
  const byName = new Map();
  const replaceable = new Set(replace);
  for (const tool of tools) {
    if (byName.has(tool.name) && !replaceable.has(tool.name))
      throw new TypeError(`Duplicate tool name: ${tool.name}`);
    byName.set(tool.name, tool);
  }
  for (const name of replaceable) {
    if (!byName.has(name))
      throw new TypeError(`Cannot replace unknown tool: ${name}`);
  }
  const available = [...byName.values()].filter((tool) =>
    tool.requires.every((key) => services[key] != null),
  );
  const index = new Map(available.map((tool) => [tool.name, tool]));

  const invoke = (name, args, signal, parent) => {
    const tool = index.get(name);
    if (!tool)
      return Promise.reject(
        new ToolError('unsupported', `No tool named ${name} is available`),
      );
    return chain({ tool, args, signal, ...(parent ? { parent } : {}) });
  };
  const execute = async ({ tool, args, signal }) => {
    const problems = validateValue(tool.inputSchema, args);
    if (problems.length)
      throw new ToolError('invalid_arguments', problems.join('; '));
    let result;
    try {
      result = await tool.run(args, {
        services,
        signal,
        tools: {
          has: (name) => index.has(name),
          call: (name, nested = {}) => invoke(name, nested, signal, tool.name),
        },
      });
    } catch (error) {
      throw fromSourceError(error);
    }
    if (!result || typeof result.summary !== 'string' || !result.data)
      throw new TypeError(`${tool.name} returned no summary or data`);
    if (
      result.images !== undefined &&
      (!Array.isArray(result.images) ||
        !result.images.every(
          (item) =>
            typeof item?.mimeType === 'string' &&
            typeof item?.data === 'string',
        ))
    )
      throw new TypeError(`${tool.name} returned malformed images`);
    return result;
  };
  const chain = interceptors.reduceRight(
    (next, interceptor) => (call) => interceptor(call, next),
    execute,
  );

  return Object.freeze({
    /** Available tool definitions, in composition order. */
    list: () => [...available],
    /** The available tool with this name, or undefined. */
    get: (name) => index.get(name),
    /** Validate arguments and run a tool through the interceptors. */
    async call(name, args = {}, { signal } = {}) {
      return invoke(name, args, signal);
    },
  });
}
