/**
 * Model Context Protocol server for a tool catalog: JSON-RPC 2.0 handling of
 * initialize, ping, tools/list and tools/call, and resources/list and
 * resources/read for the resources an application supplies, such as MCP Apps
 * views (`ui://` resources) that tools name in `_meta.ui.resourceUri`. Transports (HTTP, stdio) pass
 * parsed messages in and send the returned responses out.
 */

import { ToolError } from '../catalog.js';

/** Protocol revisions this server implements, newest first. */
export const MCP_PROTOCOL_VERSIONS = Object.freeze([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
]);

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const RESOURCE_NOT_FOUND = -32002;

/**
 * Describe catalog tools as MCP tool definitions.
 *
 * `descriptions` may override a tool's `title` and `description` by name.
 * `decorate(definition, tool)` may return extra fields to merge into each
 * definition, such as application metadata.
 */
export function toMcpTools(catalog, { descriptions = {}, decorate } = {}) {
  return catalog.list().map((tool) => {
    const override = descriptions[tool.name] || {};
    const title = override.title ?? tool.title;
    const definition = {
      name: tool.name,
      title,
      description: override.description ?? tool.description,
      inputSchema: tool.inputSchema,
      annotations: { title, ...tool.annotations },
      ...(tool.ui
        ? {
            _meta: {
              ui: { ...tool.ui },
              // The flat key is the earlier form of the same field, which
              // some hosts still read; the MCP Apps SDK sends both.
              ...(tool.ui.resourceUri
                ? { 'ui/resourceUri': tool.ui.resourceUri }
                : {}),
            },
          }
        : {}),
    };
    return decorate
      ? { ...definition, ...decorate(definition, tool) }
      : definition;
  });
}

/**
 * Create a protocol handler. `handle(message, { signal })` resolves to the
 * JSON-RPC response, or null for notifications.
 */
export function createMcpServer({
  catalog,
  name,
  version,
  instructions,
  descriptions,
  decorate,
  resources = [],
}) {
  const tools = () => toMcpTools(catalog, { descriptions, decorate });
  const resourceByUri = new Map(
    resources.map((resource) => [resource.uri, resource]),
  );
  const methods = {
    initialize(params) {
      const requested = params?.protocolVersion;
      return {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : MCP_PROTOCOL_VERSIONS[0],
        capabilities: {
          tools: { listChanged: false },
          ...(resources.length ? { resources: { listChanged: false } } : {}),
        },
        serverInfo: { name, version },
        ...(instructions ? { instructions } : {}),
      };
    },
    ping: () => ({}),
    'tools/list': () => ({ tools: tools() }),
    'resources/list': () => ({
      resources: resources.map(({ text, ...entry }) => entry),
    }),
    'resources/read'(params) {
      const resource = resourceByUri.get(params?.uri);
      if (!resource)
        throw rpcError(RESOURCE_NOT_FOUND, `Unknown resource: ${params?.uri}`);
      const { uri, mimeType, text, _meta } = resource;
      return {
        contents: [{ uri, mimeType, text, ...(_meta ? { _meta } : {}) }],
      };
    },
    async 'tools/call'(params, { signal }) {
      if (typeof params?.name !== 'string')
        throw rpcError(INVALID_PARAMS, 'tools/call needs a tool name');
      if (!catalog.get(params.name))
        throw rpcError(INVALID_PARAMS, `Unknown tool: ${params.name}`);
      try {
        const result = await catalog.call(params.name, params.arguments ?? {}, {
          signal,
        });
        // Only an app reads a tool the model cannot call, and apps read
        // structuredContent.
        const appOnly =
          catalog.get(params.name).ui?.visibility?.includes('model') === false;
        return {
          // The data is repeated as JSON text for clients that do not read
          // structuredContent.
          content: [
            { type: 'text', text: result.summary },
            ...(appOnly
              ? []
              : [{ type: 'text', text: JSON.stringify(result.data) }]),
            ...(result.images || []).map((item) => ({
              type: 'image',
              data: item.data,
              mimeType: item.mimeType,
            })),
          ],
          structuredContent: result.data,
          isError: false,
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        // Expected failures are reported to the model so it can adjust; other
        // errors are not described, so internal details never leave the server.
        const known = error instanceof ToolError;
        return {
          content: [
            {
              type: 'text',
              text: known ? error.message : 'The tool failed; try again later',
            },
          ],
          structuredContent: {
            error: known ? error.code : 'unavailable',
            ...(known && error.retryAfterSeconds != null
              ? { retry_after_seconds: error.retryAfterSeconds }
              : {}),
          },
          isError: true,
        };
      }
    },
  };

  return Object.freeze({
    async handle(message, { signal } = {}) {
      if (!isObject(message) || message.jsonrpc !== '2.0')
        return failure(
          message?.id ?? null,
          INVALID_REQUEST,
          'Invalid JSON-RPC message',
        );
      const isRequest = message.id !== undefined;
      if (typeof message.method !== 'string')
        // Responses from the client are accepted and ignored: this server
        // sends no requests of its own.
        return isRequest &&
          message.result === undefined &&
          message.error === undefined
          ? failure(message.id, INVALID_REQUEST, 'Missing method')
          : null;
      if (!isRequest) return null;
      const method = Object.hasOwn(methods, message.method)
        ? methods[message.method]
        : null;
      if (!method)
        return failure(
          message.id,
          METHOD_NOT_FOUND,
          `Unknown method: ${message.method}`,
        );
      if (message.params !== undefined && !isObject(message.params))
        return failure(message.id, INVALID_PARAMS, 'params must be an object');
      try {
        const result = await method(message.params, { signal });
        return { jsonrpc: '2.0', id: message.id, result };
      } catch (error) {
        if (error?.rpcCode)
          return failure(message.id, error.rpcCode, error.message);
        return failure(message.id, INTERNAL_ERROR, 'Internal error');
      }
    },
  });
}

/** A JSON-RPC parse-error response, for transports that cannot parse input. */
export function parseErrorResponse() {
  return failure(null, PARSE_ERROR, 'Parse error');
}

function failure(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcError(code, message) {
  return Object.assign(new Error(message), { rpcCode: code });
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
