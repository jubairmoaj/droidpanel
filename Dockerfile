# Hosted mode (droidpanel --web): serves the UI only; browsers talk to their own phone over WebUSB.

# 1) Build the React UI into dist/
FROM node:22-alpine AS ui
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY ui ./ui
COPY shared ./shared
RUN npm run build

# 2) Runtime: plain Node, no dependencies
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY shared ./shared
COPY --from=ui /src/dist ./dist

# scrcpy-server is downloaded here on first start (checksum-verified) and kept across restarts.
ENV DROIDPANEL_HOME=/data NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4321/api/env >/dev/null || exit 1
CMD ["node", "bin/droidpanel.mjs", "--web", "--host", "0.0.0.0", "--port", "4321"]
