# God's Eye View
# Issue #48: pre-built Docker image for easier local/self-hosted deployment.
#
#
# Node 24.14.x is required by package.json.

FROM node:24.14.0-bookworm-slim

WORKDIR /app

# Install dependencies first so Docker can reuse this layer when source files change.
COPY package.json package-lock.json ./
RUN npm ci

# Copy application source. .
COPY . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173

EXPOSE 4173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
