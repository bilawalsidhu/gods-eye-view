- Cross-site pages can no longer fill the terrain-height cache or spend the
  visitor's own `/api/terrain/heights` rate-limit quota through the visitor's
  browser. The route refuses a cross-site `Sec-Fetch-Site` or a foreign or
  opaque `Origin` before rate limiting, cache access or upstream work. Unlike
  the cost-bearing routes it still answers same-origin requests that arrive
  through a reverse proxy, so terrain keeps rendering behind nginx, Caddy or
  Cloudflare instead of falling back to the geoid (Sunil56224972, daikaginza,
  #975).
