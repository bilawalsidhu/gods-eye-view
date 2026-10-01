# Runs the whole app (static build + API provider middleware) as one Node
# process via `vite preview` — see server/standalone/vite.config.js for why
# there's no separate Express server. devDependencies (vite, vite-plugin-cesium)
# are required at RUNTIME, not just build time, so they are not pruned.
#
# The build context is an allowlist (.dockerignore): only the sources the
# build and runtime read are sent, so local state (Terraform state/tfvars,
# .env files, caches, agent worktrees) can never land in an image layer.
FROM node:24-alpine

WORKDIR /app

# Run as the image's unprivileged `node` user. The app writes only its caches
# and logs under the source root, so those are pre-created and owned by it.
RUN mkdir -p /app/.gev-cache /app/.gev-logs && chown -R node:node /app
USER node

COPY --chown=node:node package.json package-lock.json ./
# Puppeteer is a dev tool for local QA scripts; the server never launches a
# browser, so skip its ~170 MB Chromium download at install time.
ENV PUPPETEER_SKIP_DOWNLOAD=1
RUN npm ci

COPY --chown=node:node . .

# Browser keys are baked into the bundle at build time (Vite `define`). They
# are client-exposed by design; pass only restricted keys via the
# `--build-arg` flag of `az acr build` (see infra/terraform/terraform.tfvars.example).
# Server-side keys are NEVER build args: they come from Key Vault at runtime.
# Unset ARGs are empty; set ones are visible to the RUN below as env vars.
ARG GOOGLE_MAPS_API_KEY
ARG CESIUM_ION_TOKEN
RUN npm run build

ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "run", "start"]
