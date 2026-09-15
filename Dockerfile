# God's Eye View has no separate compiled server: `npm run dev` (Vite dev
# server + the local Node provider middleware in server/providers/) IS how the
# app runs, per README.md / CONTRIBUTING.md. This image reproduces that.
FROM node:24.14.0-bookworm-slim

WORKDIR /app

# Puppeteer and Sharp are devDependencies used only by QA/tooling scripts
# (scripts/qa-*.mjs, tools/*.mjs) — not needed to run the app itself. Skip the
# Chromium download during install, same as CI (.github/workflows/ci.yml).
ENV PUPPETEER_SKIP_DOWNLOAD=1

# Install with the lockfile first so this layer is cached across source edits.
# `npm ci` (no --omit=dev) is required: vite and vite-plugin-cesium, which run
# the app, are devDependencies — there is no production-only install here.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Sanity-check the runtime/toolchain the same way CI does (node version, npm,
# installed deps). Does not require any API keys — the app starts keyless.
RUN npm run doctor -- --json

# Binding to 0.0.0.0 is required for the published port to reach the process
# inside the container; it also flips the app's own dev-server allowedHosts
# check to permissive (see server/standalone/vite.config.js / build/vite.js).
# That's the same trust boundary the project's own HOST=0.0.0.0 LAN-sharing
# option describes in .env.example/SECURITY.md — anyone who can reach this
# container's published port can spend any API keys it's configured with.
ENV HOST=0.0.0.0
ENV PORT=4173

EXPOSE 4173

CMD ["npm", "run", "dev"]
