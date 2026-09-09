# syntax=docker/dockerfile:1
#
# The dev server is the whole app: Vite serves the client AND runs the API
# proxies (ADS-B, AIS, Overpass, OpenAI Realtime, ...) as middleware, so there
# is nothing else to containerise. See compose.yaml for the usual entry point.
FROM node:24-slim

# Puppeteer is only used by the QA scripts; skip its ~150MB Chromium download.
ENV PUPPETEER_SKIP_DOWNLOAD=1
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
# compose runs the container as the host user so bind-mounted files stay
# yours, but node_modules is baked in as root. Vite only needs to write its
# dep-optimizer cache, so open up those two directories rather than chowning
# a few hundred MB to a UID we cannot know at build time.
RUN mkdir -p node_modules/.vite && chmod 777 node_modules node_modules/.vite

COPY . .

# Bind to all interfaces, otherwise the published port hits nothing. Vite also
# relaxes allowedHosts when HOST is 0.0.0.0, which is what lets the browser
# reach it as "localhost".
ENV HOST=0.0.0.0
ENV PORT=4173
EXPOSE 4173
CMD ["npm", "run", "dev"]
