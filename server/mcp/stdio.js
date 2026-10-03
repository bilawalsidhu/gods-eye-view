/**
 * Local MCP server over stdio for agents such as Claude Code and Codex.
 *
 *   npm run mcp -- [--api-base http://localhost:4173]
 *
 * Reads newline-delimited JSON-RPC from stdin and writes responses to stdout.
 * Tools read data from a running God's Eye View server (`npm run dev` or
 * `npm run preview`) at the API base. Diagnostics go to stderr.
 */

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseErrorResponse } from '../../src/tools/mcp/index.js';
import { createLocalMcpServer } from './server.js';
import { DEFAULT_API_BASE } from './services.js';

/**
 * A one-line description of a request for the diagnostic log: its method,
 * and the tool or resource it names. Arguments and data are never logged.
 */
export function describeRequest(message) {
  const method = typeof message?.method === 'string' ? message.method : null;
  if (!method) return null;
  const subject =
    method === 'tools/call'
      ? message.params?.name
      : method === 'resources/read'
        ? message.params?.uri
        : null;
  return typeof subject === 'string' ? `${method} ${subject}` : method;
}

/** Serve newline-delimited JSON-RPC until `input` ends. */
export async function serveStdio(server, { input, output, log = () => {} }) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  for await (const line of lines) {
    if (!line.trim()) continue;
    const work = respond(server, line, log).then((response) => {
      if (response) output.write(`${JSON.stringify(response)}\n`);
    });
    pending.add(work);
    work.finally(() => pending.delete(work));
  }
  await Promise.all(pending);
}

async function respond(server, line, log) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return parseErrorResponse();
  }
  const described = describeRequest(message);
  if (described) log(described);
  const response = await server.handle(message);
  // A failed tool call answers the client, not the log; say why here too.
  if (response?.result?.isError)
    log(`   ${described} failed: ${response.result.content?.[0]?.text}`);
  return response;
}

/** Read `--api-base <url>` from command-line arguments. */
export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--api-base' && argv[index + 1])
      options.apiBase = argv[(index += 1)];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = parseArgs(process.argv.slice(2));
    console.error(
      `God's Eye View MCP server reading ${options.apiBase || DEFAULT_API_BASE}`,
    );
    await serveStdio(createLocalMcpServer(options), {
      input: process.stdin,
      output: process.stdout,
      log: (line) => console.error(`<- ${line}`),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
