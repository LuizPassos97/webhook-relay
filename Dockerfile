# syntax=docker/dockerfile:1

# Two runtime images share every layer except the start command and health check:
#   docker build --target api -t webhook-relay-api .
#   docker build --target worker -t webhook-relay-worker .

# Pinned by digest for reproducible builds; Dependabot proposes updates.
ARG NODE_IMAGE=node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

# Compiles TypeScript with the full dependency set.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN npm run build

# Installs only runtime dependencies, so compilers and test tools never reach the image.
FROM ${NODE_IMAGE} AS runtime-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/LuizPassos97/webhook-relay" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=runtime-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The migration runner looks for SQL files next to its compiled module.
COPY packages/db/migrations ./dist/packages/db/migrations
COPY package.json ./
# The unprivileged user that ships with the Node.js image.
USER node
STOPSIGNAL SIGTERM

FROM runtime AS worker
LABEL org.opencontainers.image.title="webhook-relay-worker" \
      org.opencontainers.image.description="Webhook Relay delivery worker"
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.WORKER_PORT ?? 3001) + '/health/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/apps/worker/src/main.js"]

# Last stage, so a plain `docker build .` produces the API image.
FROM runtime AS api
LABEL org.opencontainers.image.title="webhook-relay-api" \
      org.opencontainers.image.description="Webhook Relay HTTP API"
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT ?? 3000) + '/health/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/apps/api/src/main.js"]
