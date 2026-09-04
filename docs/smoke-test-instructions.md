# Smoke Test Instructions

This smoke test starts the Vite dev server, opens the app in a headless browser (Puppeteer), checks that critical UI elements render, and verifies there are no runtime errors.

Run locally:

1. Install dev dependencies:
   npm install

2. Launch the smoke test:
   npm run smoke:test

Notes:
- The script expects the dev server to announce a local URL line (Vite default). If Vite runs on a different port, adjust scripts/test-smoke.mjs to detect the correct URL.
- The test asserts the presence of these selectors: `#cesiumContainer`, `#loading-screen`, `#data-panel`, `#key-setup`. Adjust if your environment hides key-setup in production builds.
- The smoke test is intended for development CI where headless browsers are available.
