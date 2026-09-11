# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim

WORKDIR /app

# Vite and ws provide the live API server. Keep these development dependencies.
# Puppeteer is a test tool; the app does not need a browser inside the image.
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    HOST=0.0.0.0 \
    PORT=4173 \
    GEV_KEY_SETUP_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts
COPY public ./public
COPY config ./config
COPY index.html style.css vite.config.js LICENSE DATA_SOURCES.md ./

RUN mkdir -p .gev-cache .gev-logs node_modules/.vite node_modules/.vite-temp \
    && chown -R node:node .gev-cache .gev-logs node_modules/.vite node_modules/.vite-temp

USER node
EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/', {signal: AbortSignal.timeout(4000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Compile the browser modules at startup so each user's public map keys come
# from the container environment. A static build would freeze these keys.
CMD ["node", "node_modules/vite/bin/vite.js", "--host", "0.0.0.0", "--port", "4173", "--strictPort"]
