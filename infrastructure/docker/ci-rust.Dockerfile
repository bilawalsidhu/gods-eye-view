# Pre-warmed Rust+WASM CI image for the gods-eye-view GitForge pipeline.
#
# The build job (vite build + bundle budgets) needs Node AND the Rust
# wasm toolchain: the FIRMS heat renderer lives in rust/firms-renderer and
# `npm run build:wasm` regenerates public/wasm/firms-renderer before vite
# copies public/ into dist (without it the app keeps the entity fallback).
# Mirrors the doctrine proven in dsc's ci-rust.Dockerfile: bare images
# re-download crates/tools per run and crates.io transfers from this
# network stall mid-run, so everything is baked here and
# CARGO_NET_OFFLINE=true makes a missing crate fail in seconds instead of
# hanging.
#
# The wasm-pack tool cache (wasm-bindgen-cli, wasm-opt) is warmed by
# running one real `wasm-pack build` against the committed
# rust/firms-renderer at image build; the job's later build hits the cache
# offline. The target/ tree from that warm build is NOT shipped (fresh
# workspace per run; only the caches matter).
#
# Rebuild whenever rust/firms-renderer/Cargo.lock changes:
#
#   tmp=$(mktemp -d)
#   mkdir -p "$tmp"/rust/firms-renderer/src
#   cp rust/firms-renderer/Cargo.toml rust/firms-renderer/Cargo.lock "$tmp"/rust/firms-renderer/
#   cp rust/firms-renderer/src/*.rs "$tmp"/rust/firms-renderer/src/
#   cp package.json package-lock.json "$tmp"/
#   docker build -f infrastructure/docker/ci-rust.Dockerfile -t gev-ci-rust:1 "$tmp"
#
# Size guard: keep under ~2.5GB (NAS vfs driver; 60s sandbox-acquisition
# cap). dsc-ci-rust:1 creates in ~10s at 1.6GB.
FROM rust:1-slim-bookworm

ENV CARGO_TERM_COLOR=always \
    CARGO_NET_OFFLINE=true \
    XDG_CACHE_HOME=/opt/xdg-cache \
    PATH=/opt/node24/bin:${PATH} \
    npm_config_cache=/opt/npm-cache \
    npm_config_prefer_offline=true \
    npm_config_audit=false \
    npm_config_fund=false \
    PUPPETEER_SKIP_DOWNLOAD=true \
    CI=true

# git: wasm-pack/cargo read VCS info; xz-utils + curl: Node tarball.
# wasm-pack is installed with CARGO_NET_OFFLINE explicitly disabled — the
# image ENV sets it true for JOB time, and the registry cache is empty at
# this point (offline + empty cache = "could not find wasm-pack").
RUN apt-get update \
    && apt-get install -y --no-install-recommends git xz-utils curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && rustup target add wasm32-unknown-unknown \
    && CARGO_NET_OFFLINE=false cargo install wasm-pack --locked \
    && mkdir -p /opt/xdg-cache /opt/npm-cache /opt/node24 \
    && chown -R 1000:1000 /opt/xdg-cache /opt/npm-cache /usr/local/cargo

# Network is allowed exactly here: Node runtime, the wasm tool cache
# (real wasm-pack build against the committed crate), and the npm cache.
# nodejs.org names x86_64 "x64", not dpkg's "amd64" — map the arch.
RUN case "$(dpkg --print-architecture)" in \
      amd64) NODE_ARCH=x64 ;; \
      arm64) NODE_ARCH=arm64 ;; \
      *) NODE_ARCH="$(dpkg --print-architecture)" ;; \
    esac \
    && curl -fsSL "https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-${NODE_ARCH}.tar.xz" \
       | tar -xJ --strip-components=1 -C /opt/node24

WORKDIR /warm
COPY rust ./rust
COPY package.json package-lock.json ./
RUN npm ci \
    && CARGO_NET_OFFLINE=false npm run build:wasm \
    && rm -rf /warm
WORKDIR /
