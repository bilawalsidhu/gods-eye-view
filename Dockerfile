# Hosted profile image: builds the app, then runs server/production.js.
# Secrets come from the platform's secret store at runtime, never the image.
FROM node:24-slim AS build
WORKDIR /app
# Browser-visible keys are compiled into the bundle (optional; the globe
# works keyless with Esri imagery). Hosts like Render pass env vars as args.
ARG GOOGLE_MAPS_API_KEY=""
ARG CESIUM_ION_TOKEN=""
ENV GOOGLE_MAPS_API_KEY=$GOOGLE_MAPS_API_KEY CESIUM_ION_TOKEN=$CESIUM_ION_TOKEN
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 GEV_TRUST_PROXY=1 GEV_AUTH_MODE=tokens
WORKDIR /app
# Everything the server imports at runtime (dev dependencies already pruned).
COPY --from=build /app ./
# History (SQLite) and provider caches are written here by the node user.
RUN mkdir -p /app/.gev-data /app/.gev-cache && chown -R node:node /app/.gev-data /app/.gev-cache
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/production.js"]
