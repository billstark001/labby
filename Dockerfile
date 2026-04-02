# Build stage
FROM node:22-alpine AS base

RUN corepack enable pnpm

WORKDIR /app

# Copy workspace config and package manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# ---- Build core ----
FROM base AS core-builder
COPY packages/core ./packages/core
RUN pnpm --filter @labby/core build

# ---- Build server ----
FROM core-builder AS server-builder
COPY packages/server ./packages/server
RUN pnpm --filter @labby/server build

# ---- Build web (optional, included if you want to serve the SPA from the server) ----
FROM core-builder AS web-builder
COPY packages/web ./packages/web
ARG VITE_DB_CONFIG=api
ENV VITE_DB_CONFIG=${VITE_DB_CONFIG}
RUN pnpm --filter @labby/web build

# ---- Production image ----
FROM node:22-alpine AS runner

RUN corepack enable pnpm

WORKDIR /app

# Copy workspace config and production package manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/server/package.json ./packages/server/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts
COPY --from=core-builder /app/packages/core/dist ./packages/core/dist
COPY --from=server-builder /app/packages/server/dist ./packages/server/dist
COPY --from=web-builder /app/packages/web/dist ./packages/web/dist

# Create data directory
RUN mkdir -p /data

ENV PORT=4410
ENV DB_PATH=/data/labby.db
ENV NODE_ENV=production

EXPOSE 4410

CMD ["node", "packages/server/dist/index.js"]
