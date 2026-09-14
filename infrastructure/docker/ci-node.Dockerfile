# Pre-warmed Node CI image for the local GitForge pipeline (gods-eye-view).
#
# Mirrors the doctrine proven in dsc's ci-node.Dockerfile: job-level `env:`
# in .gitforge.yml is parsed by gitforge-ci but never forwarded to job
# containers (the runner builds its ExecutableJob with an empty env map), so
# every variable a job needs is baked in here. The run workspace is fresh
# per pipeline run, so the npm cache lives in the image, not the workspace —
# `npm ci` in job steps runs cache-first (npm_config_prefer_offline) and
# completes without the network for the committed package-lock.json.
#
# The suite runs under EVERY calibrated Node major (package.json engines:
# 24.14.x–<25 or 26.x–<27; scripts/run-unit-tests.mjs refuses uncalibrated
# runtimes when GEV_REQUIRE_ALLOCATION_GATE=1), so the image carries BOTH
# runtimes: the base node:24 plus the Node 26 tarball unpacked to
# /opt/node26. The .gitforce.yml node-26 job prepends it to PATH in the
# step (env: is dead, so a job-level PATH override is not possible).
#
# PUPPETEER_SKIP_DOWNLOAD: no pipeline job drives a browser, and baking
# puppeteer's browser cache is a footgun — a partial download during the
# image build left /root/.cache/puppeteer with a chrome folder and no
# executable, and every job-time `npm ci` then failed in postinstall
# ("exists but the executable is missing"). Skip it and `npm ci` is both
# hermetic and smaller.
#
# Rebuild whenever package-lock.json changes:
#
#   tmp=$(mktemp -d)
#   cp package.json package-lock.json "$tmp"/
#   docker build -f infrastructure/docker/ci-node.Dockerfile -t gev-ci-node:1 "$tmp"
#
# Size guard: the NAS daemon uses the vfs storage driver (every `docker
# create` copies the image's full layer stack) and the runner has a
# hard 60-second sandbox-acquisition cap — keep under ~2.5GB and slim
# variants only.
FROM node:24-slim

# git: some test/tooling paths shell out to it (cheap insurance against a
# sandbox job failing on a missing VCS client). libatomic1: the Node 26
# binary needs it and the slim base omits it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates xz-utils curl libatomic1 \
    && rm -rf /var/lib/apt/lists/*

ENV npm_config_cache=/opt/npm-cache \
    npm_config_prefer_offline=true \
    npm_config_audit=false \
    npm_config_fund=false \
    PUPPETEER_SKIP_DOWNLOAD=true \
    CI=true

# The npm cache and the Node 26 tree are chowned to the runner UID (1000);
# runs execute as root or uid 1000 — both work.
RUN mkdir -p /opt/npm-cache /opt/node26 \
    && chown -R 1000:1000 /opt/npm-cache

# Network is allowed exactly here: bake the Node 26 runtime and the
# lockfile's package cache. nodejs.org names x86_64 "x64", not dpkg's
# "amd64" — map the arch.
RUN case "$(dpkg --print-architecture)" in \
      amd64) NODE_ARCH=x64 ;; \
      arm64) NODE_ARCH=arm64 ;; \
      *) NODE_ARCH="$(dpkg --print-architecture)" ;; \
    esac \
    && curl -fsSL "https://nodejs.org/dist/v26.8.2/node-v26.8.2-linux-${NODE_ARCH}.tar.xz" \
       | tar -xJ --strip-components=1 -C /opt/node26

WORKDIR /lockfile
COPY package.json package-lock.json ./
RUN npm ci
WORKDIR /
