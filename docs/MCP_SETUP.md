# MCP setup

Use God's Eye View from Claude and Codex: tools, links, and the live globe
inside the conversation. Agents: follow these steps in order and check each
one before going on.

## 1. Run the app

```sh
npm install
npm run build:panel   # the in-conversation globe; rerun after app changes
npm run dev           # http://localhost:4173, keep it running
```

The MCP server reads from this app.

## 2. Add the server to a client

The server is `server/mcp/stdio.js` in this checkout. Use absolute paths
(clients do not load your shell profile), with each argument as its own entry.

| Client | How |
| --- | --- |
| Claude Code | `claude mcp add gods-eye-view -- node /abs/path/gods-eye-view/server/mcp/stdio.js --api-base http://localhost:4173` |
| Codex CLI | `codex mcp add gods-eye-view -- node /abs/path/gods-eye-view/server/mcp/stdio.js --api-base http://localhost:4173` |
| Codex and ChatGPT desktop | Same `~/.codex/config.toml` as the CLI (block below), or Settings → MCP servers → Add server (STDIO). |
| Claude Desktop | Settings → Developer → Edit Config, then add the JSON below. |

```toml
[mcp_servers.gods-eye-view]
command = "node"
args = ["/abs/path/gods-eye-view/server/mcp/stdio.js", "--api-base", "http://localhost:4173"]
```

```json
{
  "mcpServers": {
    "gods-eye-view": {
      "command": "node",
      "args": ["/abs/path/gods-eye-view/server/mcp/stdio.js", "--api-base", "http://localhost:4173"]
    }
  }
}
```

**Windows with the checkout in WSL:** use `"command": "wsl.exe"` and put
`"-e"` and the absolute Linux path to `node` first in `args`, for example
`["-e", "/home/you/.local/share/mise/installs/node/24/bin/node", "/home/you/gods-eye-view/server/mcp/stdio.js", "--api-base", "http://localhost:4173"]`.

## 3. Restart and try it

Fully quit the client (on Windows, from the tray icon) and reopen it, then
start a new chat; clients keep the server they started with. Ask: *"Show San
Diego in God's Eye View with military flights on."*

- Claude Desktop (a chat, not the Code tab), Codex and ChatGPT desktop show
  the live globe; the first load takes 10–20 seconds.
- Claude Code and the Codex CLI answer with data and a link.

## Troubleshooting

- **The server does not appear:** run the command from step 2 in a terminal;
  it should print `God's Eye View MCP server reading http://localhost:4173`
  and wait. A path or `args` mistake fails here.
- **The panel says it could not load:** `npm run build:panel` was not run, or
  the dev server is down.
- **Logs:** the server writes each call, and why one failed, to stderr. Claude
  Desktop keeps it in its logs folder as `mcp-server-gods-eye-view.log`; in
  Codex, right-click the panel → DevTools for the panel's console.

See [tools and the MCP server](TOOLS.md) for what the tools do.
