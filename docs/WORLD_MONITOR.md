# Optional World Monitor intelligence

God's Eye View can read country headlines, country risk context and a news
digest from a [World Monitor](https://github.com/koala73/worldmonitor) backend
running on the same machine. Nothing changes until it is configured: without
`WORLD_MONITOR_API_BASE`, no panel mounts, no route is served, and voice and MCP
sessions carry no World Monitor tools.

The applications talk over HTTP. No World Monitor source or data is copied into
this repository. World Monitor is AGPL-licensed; keep its license and both
projects' source and data notices in any distribution. Publisher and data
provider terms still apply.

## Connect a local backend

Run World Monitor's self-hosted stack as its
[SELF_HOSTING.md](https://github.com/koala73/worldmonitor/blob/main/SELF_HOSTING.md)
describes. Its nginx front end listens on `WM_PORT` (3000 by default) and adds
the sidecar's local transport token itself. Set an operator key there with
`WORLDMONITOR_VALID_KEYS`, then give God's Eye View the same key in an ignored
`.env.local`:

```dotenv
WORLD_MONITOR_API_BASE=http://127.0.0.1:3000
WORLD_MONITOR_API_KEY_FILE=/absolute/path/to/operator-key.txt
```

`WORLD_MONITOR_API_KEY` takes the key directly instead of a file. To reach the
sidecar without nginx, also supply its transport token with
`WORLD_MONITOR_LOCAL_TOKEN` or `WORLD_MONITOR_LOCAL_TOKEN_FILE`. The operator key
and the transport token have different purposes; a hosted subscription key is
neither.

Restart `npm run dev` or rebuild after changing these values. Credentials, the
backend address and credential-file paths stay on this server; the browser only
learns whether World Monitor is enabled.

The base must resolve to a loopback or private address. Public, link-local,
CGNAT and metadata addresses are refused, DNS answers are pinned to the checked
address, and redirects are not followed, so credentials cannot be sent
elsewhere.

## What it adds

- **Intelligence button and Country briefing panel.** Enter a two-letter
  country code to load headlines and risk context. **Refresh news** asks World
  Monitor to acquire feeds first, for an empty or old cache.
- **Tools on voice, MCP and the browser catalog:**
  - `world_monitor_country_headlines`: cached country headlines with source dates.
  - `world_monitor_country_brief`: headlines plus composite instability, travel
    advisory and sanctions data, summarized without a model.
  - `world_monitor_feed_digest`: the World Monitor news digest.

Every answer separates retrieval time from source time and reports `complete`,
`partial`, `stale` or `unavailable` coverage. A missing risk score is reported as
unavailable, never as zero, and an empty or unavailable feed is not evidence
that nothing happened. Risk, advisories and sanctions depend on World Monitor's
own populated caches; a running backend does not establish that those data sets
exist or are current.

The `/api/worldmonitor` routes accept only direct same-host requests, like
`/mcp`: they refuse forwarding headers, cross-origin browsers and launcher
sharing. The stdio MCP entry (`npm run mcp`) is a separate process and offers the
World Monitor tools only when its own environment sets `WORLD_MONITOR_API_BASE`.
