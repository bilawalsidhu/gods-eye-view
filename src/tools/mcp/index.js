/** Model Context Protocol adapter for a tool catalog. See docs/TOOLS.md. */

export {
  createMcpServer,
  toMcpTools,
  parseErrorResponse,
  MCP_PROTOCOL_VERSIONS,
} from './protocol.js';
export { createMcpHttpHandler } from './http.js';
