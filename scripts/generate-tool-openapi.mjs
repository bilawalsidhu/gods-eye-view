#!/usr/bin/env node
/**
 * scripts/generate-tool-openapi.mjs — emit one OpenAPI 3.0.3 document per
 * plugin in server/tools/registry.js to docs/plugins/<plugin>/openapi.json.
 *
 *   node scripts/generate-tool-openapi.mjs --server https://<preview>.vercel.run
 *   node scripts/generate-tool-openapi.mjs --check      (exit 1 if files drift)
 *
 * The documents are what an OnDemand dashboard "REST API" agent is fed
 * (docs/registration/ONDEMAND_REGISTRATION_PACK.md). They only ever describe
 * the same-origin `/api/tools/*` routes — no upstream URL, no key.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { listPlugins } from '../server/tools/registry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const server = argValue('--server') || 'https://ondemand-spatial.example.invalid';
const check = args.includes('--check');

const RULE_TYPES = {
  string: { type: 'string' },
  number: { type: 'number' },
  integer: { type: 'integer' },
  boolean: { type: 'boolean' },
  enum: { type: 'string' },
  'iso-date': { type: 'string', format: 'date-time' },
  csv: { type: 'string' },
};

function parameterFor(name, rule) {
  const schema = { ...(RULE_TYPES[rule.type] || { type: 'string' }) };
  if (rule.values) schema.enum = [...rule.values];
  if (rule.min !== undefined) schema.minimum = rule.min;
  if (rule.max !== undefined) schema.maximum = rule.max;
  if (rule.default !== undefined) schema.default = rule.default;
  if (rule.maxLength !== undefined) schema.maxLength = rule.maxLength;
  return {
    name,
    in: 'query',
    required: Boolean(rule.required),
    description: rule.description || '',
    schema,
  };
}

export function buildOpenApi(plugin, { serverUrl = server } = {}) {
  const paths = {};
  for (const tool of plugin.tools) {
    paths[`/api/tools/${tool.name}`] = {
      get: {
        operationId: tool.name,
        summary: tool.summary || tool.name,
        description: tool.description || tool.summary || tool.name,
        parameters: Object.entries(tool.params || {}).map(([k, r]) =>
          parameterFor(k, r),
        ),
        responses: {
          200: {
            description: 'Tool result envelope',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ToolResult' },
              },
            },
          },
          400: {
            description: 'Validation error (unknown/missing/invalid parameter)',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ToolError' },
              },
            },
          },
          502: {
            description: 'Upstream failure with a structured reason',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ToolError' },
              },
            },
          },
          503: {
            description: 'Provider unavailable (missing key / no data) with a structured reason',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ToolError' },
              },
            },
          },
        },
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: plugin.name,
      version: '1.0.0',
      description: plugin.description,
      'x-ondemand-spatial': {
        pluginId: plugin.id,
        category: plugin.category,
        conversationStarters: plugin.conversationStarters || [],
        auth: 'none — same-origin proxy; upstream credentials stay server-side',
        generatedBy: 'scripts/generate-tool-openapi.mjs',
      },
    },
    servers: [{ url: serverUrl, description: 'OnDemand Spatial deployment (preview or production)' }],
    paths,
    components: {
      schemas: {
        Provider: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['live', 'stale', 'degraded', 'unavailable'] },
            source: { type: 'string' },
            fetchedAt: { type: 'string', nullable: true },
            ageSec: { type: 'integer', nullable: true },
            error: { type: 'string', nullable: true },
            count: { type: 'integer', nullable: true },
          },
        },
        ToolResult: {
          type: 'object',
          required: ['ok', 'tool', 'data'],
          properties: {
            ok: { type: 'boolean', enum: [true] },
            tool: { type: 'string' },
            params: { type: 'object', additionalProperties: true },
            data: { type: 'object', additionalProperties: true },
            provider: { $ref: '#/components/schemas/Provider' },
            provenance: { type: 'object', additionalProperties: true },
            generatedAtUtc: { type: 'string', format: 'date-time' },
          },
        },
        ToolError: {
          type: 'object',
          required: ['ok', 'error'],
          properties: {
            ok: { type: 'boolean', enum: [false] },
            tool: { type: 'string' },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                param: { type: 'string' },
              },
            },
            provider: { $ref: '#/components/schemas/Provider' },
          },
        },
      },
    },
  };
}

let drift = 0;
for (const plugin of listPlugins()) {
  if (!plugin.tools.length) continue;
  const dir = path.join(root, 'docs', 'plugins', plugin.id);
  const file = path.join(dir, 'openapi.json');
  const next = JSON.stringify(buildOpenApi(plugin), null, 2) + '\n';
  if (check) {
    const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (prev !== next) {
      drift += 1;
      console.error(`[openapi] drift: ${path.relative(root, file)}`);
    }
    continue;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, next);
  console.log(`[openapi] wrote ${path.relative(root, file)} (${plugin.tools.length} operations, server ${server})`);
}
if (check && drift) process.exit(1);
