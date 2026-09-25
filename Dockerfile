# God's Eye View — hosted deployment.
#
# The runtime is `vite preview`, not a static file server: the live-data
# providers in server/providers/ are Vite middleware that register
# `configurePreviewServer`, so serving dist/ without them would leave every
# /api/* route dead (no aircraft, ships, satellites, CCTV, traffic or voice).
# That also means Vite itself is a runtime dependency, so devDependencies stay
# installed and NODE_ENV is only set in the final stage.

FROM node:24-bookworm-slim AS build
WORKDIR /app

# Puppeteer is only used by scripts/qa-*.mjs; its Chromium download would add
# hundreds of megabytes to a build that never launches a browser.
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
 && rm -rf node_modules/puppeteer node_modules/@puppeteer \
           node_modules/sharp node_modules/@img \
           node_modules/.cache

FROM node:24-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

COPY --from=build --chown=node:node /app /app

# The providers keep on-disk caches (Overpass, military installations) inside
# the checkout, so the runtime user owns it.
USER node

EXPOSE 8080

# Health is answered ahead of the access gate; see deploy/access-gate.js.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
