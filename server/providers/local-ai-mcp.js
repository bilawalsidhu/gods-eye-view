import { localEndpoint } from '../../src/voice/localConfig.js';

// Focused Streamable HTTP client: only the owner's configured search tool is exposed.
export async function searchMcp({
  url,
  tool,
  query,
  signal,
  fetchImpl = fetch,
}) {
  url = localEndpoint(url);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  let nextId = 0;
  async function rpc(method, params, notification = false) {
    const id = notification ? undefined : ++nextId;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      signal,
      redirect: 'error',
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (!response.ok) throw new Error(`Search MCP: HTTP ${response.status}`);
    const session = response.headers.get('mcp-session-id');
    if (session) headers['Mcp-Session-Id'] = session;
    if (notification) {
      await response.body?.cancel();
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const sse = response.headers
      .get('content-type')
      ?.includes('text/event-stream');
    let buffer = '',
      bytes = 0;
    const accept = (message) => {
      if (message.id !== id) return undefined;
      if (message.error) throw new Error('Search MCP rejected the request');
      if (!Object.hasOwn(message, 'result'))
        throw new Error('Invalid Search MCP response');
      return message.result;
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        bytes += value?.byteLength || 0;
        if (bytes > 256 * 1024)
          throw new Error('Search MCP response too large');
        buffer += done
          ? decoder.decode()
          : decoder.decode(value, { stream: true });
        if (sse) {
          let boundary;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            const data = frame
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (!data) continue;
            const result = accept(JSON.parse(data));
            if (result !== undefined) return result;
          }
        }
        if (done) break;
      }
      if (!sse) {
        const result = accept(JSON.parse(buffer));
        if (result !== undefined) return result;
      }
      throw new Error('Search MCP returned no matching result');
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  try {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'gods-eye-view-local', version: '1.0.0' },
    });
    if (
      !['2025-03-26', '2025-06-18', '2025-11-25'].includes(init.protocolVersion)
    )
      throw new Error('Unsupported Search MCP protocol');
    headers['MCP-Protocol-Version'] = init.protocolVersion;
    await rpc('notifications/initialized', {}, true);
    const result = await rpc('tools/call', {
      name: tool,
      arguments: { query },
    });
    if (result.isError) throw new Error('Search MCP tool failed');
    return {
      content: (result.content || [])
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n')
        .slice(0, 12000),
    };
  } finally {
    if (headers['Mcp-Session-Id']) {
      await fetchImpl(url, {
        method: 'DELETE',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(2000),
      })
        .then((response) => response.body?.cancel())
        .catch(() => {});
    }
  }
}
