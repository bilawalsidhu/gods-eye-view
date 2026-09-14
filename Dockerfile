# God's Eye View — local container image.
#
# IMPORTANT: this app's data backbone (OpenSky, CelesTrak, CCTV, adsb.lol,
# FIRMS, TomTom, Overpass, GBFS, terrain, adsbdb, key-setup …) is implemented
# as vite *dev-server* middlewares. Several of those plugins register ONLY via
# configureServer (never configurePreviewServer), so `vite build && vite
# preview` would silently ship a gutted app. The container therefore runs the
# dev server — same code path as `npm run dev`.
#
# Node 26 satisfies the package engines pin (>=26 <27).

FROM node:26-bookworm-slim

# Puppeteer is only used by the QA/screenshot harnesses, never to serve.
# Skip its Chromium download to keep the image lean.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    NODE_ENV=development

WORKDIR /app

# Install dependencies first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Application source (see .dockerignore for exclusions — no secrets baked).
COPY . .

# Bind all interfaces inside the container; vite.config.js treats
# HOST=0.0.0.0 as the containerized mode (allowedHosts: true).
ENV HOST=0.0.0.0 \
    PORT=4173

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "dev"]
