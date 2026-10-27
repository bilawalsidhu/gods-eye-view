# syntax=docker/dockerfile:1
#
# The dev server is the whole app: Vite serves the client AND runs the API
# proxies (ADS-B, AIS, Overpass, OpenAI Realtime, ...) as middleware, so there
# is nothing else to containerise. See compose.yaml for the usual entry point.
# Same Node as CI (package.json engines, .github/workflows), pinned by digest.

# Two targets. `dev` (below) is what compose.yaml builds: git for the test
# suite, and the checkout bind-mounted over /app. `runtime` (last in this file)
# is the hardened image that releases publish; it is also the default target.
FROM node:24.14.0-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS dev

# Puppeteer is only used by the QA scripts; skip its ~150MB Chromium download.
ENV PUPPETEER_SKIP_DOWNLOAD=1

# `npm test` builds fixtures with `git init`, so the suite cannot run in a
# container without it (71 failures on node:24-slim, all ENOENT on git).
RUN apt-get update   && apt-get install -y --no-install-recommends git   && rm -rf /var/lib/apt/lists/*
# The repo is bind-mounted, so inside the container it can show an owner other
# than the user the container runs as - always, on Docker Desktop. git then
# refuses it as "dubious ownership", which fails the tests that shell out to
# git. It is the user's own checkout, so trust that one path.
RUN git config --system --add safe.directory /app

# Never run as root. The image's own user is `node` (1000); compose overrides
# it with the host user so bind-mounted files stay yours.
WORKDIR /app
RUN chown node:node /app
USER node

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci
# node_modules belongs to `node`, but compose may run as another UID. Vite only
# needs to write its dep-optimizer cache, so open up those two directories
# rather than chowning a few hundred MB to a UID we cannot know at build time.
RUN mkdir -p node_modules/.vite && chmod 777 node_modules node_modules/.vite

COPY --chown=node:node . .

# Bind to all interfaces, otherwise the published port hits nothing. This does
# not widen the Host allowlist: IP addresses and localhost are accepted, other
# names only via GEV_ALLOWED_HOSTS (see build/allowedHosts.js).
ENV HOST=0.0.0.0
ENV PORT=4173
EXPOSE 4173
# node:slim has no curl, so probe with Node's built-in fetch. 127.0.0.1 is
# always on the Host allowlist, and the generous start period covers Vite's
# first-run dependency optimisation.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(Number.parseInt(process.env.PORT,10)||4173)+'/').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# The launcher is `npm run dev` plus one step: it trusts the container's
# gateway address for Provider Settings, because that is where Docker delivers
# the host's own browser from (never 127.0.0.1). See scripts/docker-start.mjs.
CMD ["node", "scripts/docker-start.mjs"]

# ---------------------------------------------------------------------------
# Hardened image, published to GHCR. Everything under /app belongs to root and
# the runtime user (1000) cannot change it; that user owns only the few paths
# the app writes (see /data below). Run it with the flags in the README
# (read-only root, no capabilities, --init); nothing here depends on them, they
# are defence in depth.

FROM node:24.14.0-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS deps
ENV PUPPETEER_SKIP_DOWNLOAD=1
WORKDIR /app
COPY package.json package-lock.json ./
# Built here, per architecture, so esbuild and sharp are this platform's own.
# The dev server needs the devDependencies (vite), so nothing is omitted.
RUN npm ci && npm cache clean --force && rm -rf /root/.npm

FROM node:24.14.0-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS runtime
WORKDIR /app
# Code and dependencies: root-owned, world-readable, not group/world-writable.
COPY --from=deps --chmod=u=rwX,go=rX /app/node_modules ./node_modules
COPY --chmod=u=rwX,go=rX . .
# The launcher is `node` and Vite is a library; nothing at runtime calls npm,
# npx or corepack, and there is no git, apt or package cache in this image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /root/.npm /var/lib/apt/lists/* /usr/bin/apt /usr/bin/apt-* \
 # Writable: Vite's dependency cache and its config temp dir (mount tmpfs
 # on these when the root filesystem is read-only), and /data.
 && mkdir -p node_modules/.vite node_modules/.vite-temp /data \
 && chown 1000:1000 node_modules/.vite node_modules/.vite-temp /data

# Everything the app keeps lives in /data: the .env that Provider Settings
# saves, .gev-cache and .gev-logs. Mount one volume here. The saved .env is
# replaced by temp-file-and-rename, which is why it cannot sit in /app.
ENV GEV_DATA_DIR=/data
VOLUME ["/data"]

ENV PUPPETEER_SKIP_DOWNLOAD=1
ENV HOST=0.0.0.0
ENV PORT=4173
USER 1000:1000
EXPOSE 4173
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(Number.parseInt(process.env.PORT,10)||4173)+'/').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "scripts/docker-start.mjs"]
