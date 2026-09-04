# External Resources Audit and Fallback Recommendations

This project loads some third-party resources at runtime. Below are the key external resources and recommended fallback/self-host strategies for offline or hardened deployments.

1) Google Fonts & Material icons
- Resources loaded from:
  - https://fonts.googleapis.com
  - https://fonts.gstatic.com
  - https://fonts.googleapis.com/icon?family=Material+Icons+Round
  - https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined
- Risk: external network dependency, privacy (third-party hosting), and availability in airgapped environments.
- Recommendation: Bundle required font files (woff2) under `public/fonts/` and update `index.html` to prefer local files. Provide a small CSS fallback (`fonts/local-fonts.css`) and a build step to download latest fonts for release builds.

2) Google-hosted Material Icons (round/symbols)
- Recommendation: Replace remote includes with local SVG sprite or Google icons subset exported to `public/icons/`. The project already uses `/logo.svg`; extend this pattern.

3) External analytics, tracking, or CDN (none present by default)
- Recommendation: Ensure any third-party scripts are opt-in. Document where analytics would be added and how to disable them.

4) Map tiles / photoreal 3D sources
- Google Maps & Cesium ion are optional "power-ups" requiring keys. The app supports keyless Esri and Re:Earth stacks as fallbacks.
- Recommendation: Document an official fallback policy in `DATA_SOURCES.md` (already present); add a post-install message and optional prefetch step for airgapped static tiles if desired.

Implementation checklist:
- Add `public/fonts/` and `public/icons/` and a small build helper (`scripts/fetch-fonts.mjs`) to fetch and cache fonts for releases.
- Update `index.html` to use local CSS `link` before remote fonts and keep remote links as optional fallbacks.
- Add documentation and a small CLI (node script) to vendor fonts for enterprise/offline packaging.

Security & Privacy notes:
- Browser-side keys (Google Maps) must be provider-restricted; surface warns and links to SECURITY.md already.
- Self-hosting fonts mitigates privacy leakage to Google and improves reproducible, airgapped builds.
