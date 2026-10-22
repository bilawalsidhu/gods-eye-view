- Extract `scripts/qa-browser.mjs` to unify cross-platform browser resolution
  across QA test harnesses and gates, replacing duplicate Puppeteer path lookups
  with architecture-safe execution probing and priority order resolution:
  `PUPPETEER_EXECUTABLE_PATH`, then Puppeteer's pinned Chrome for Testing, then
  system Chrome, Chromium or Edge (Abhilash Ghosh, #865).
