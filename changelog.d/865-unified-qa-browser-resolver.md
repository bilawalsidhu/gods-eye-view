- Extract `scripts/qa-browser.mjs` to unify cross-platform browser resolution
  across QA test harnesses and gates, replacing duplicate Puppeteer path lookups
  with architecture-safe execution probing and priority order resolution (Abhilash
  Ghosh, #865).
