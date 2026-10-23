- Connect a local World Monitor backend with `WORLD_MONITOR_API_BASE` for
  country headlines, risk context and a news digest. An **Intelligence** button
  opens a Country briefing panel, and voice, the browser catalog and HTTP MCP
  gain `world_monitor_country_headlines`, `world_monitor_country_brief` and
  `world_monitor_feed_digest`. Unset, no route, panel or tool is added.
  Credentials stay server-side and go only to loopback or private addresses;
  results keep source times and report partial, stale or unavailable coverage
  rather than inventing a zero (hifiguy, #1334).
