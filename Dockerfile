# syntax=docker/dockerfile:1
#
# The dev server is the whole app: Vite serves the client AND runs the API
# proxies (ADS-B, AIS, Overpass, OpenAI Realtime, ...) as middleware, so there
# is nothing else to containerise. See compose.yaml for the usual entry point.
# Same Node as CI (package.json engines, .github/workflows), pinned by digest.
FROM node:24.14.0-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

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
