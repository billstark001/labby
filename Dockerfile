# Build stage
FROM node:22-bookworm-slim AS base

RUN corepack enable pnpm

# Rust toolchain is required by packages/core build-rust.mjs
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"
RUN rustup target add wasm32-unknown-unknown
RUN cargo install wasm-pack --locked
RUN cargo install wasm-bindgen-cli --locked

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
FROM node:22-bookworm-slim AS runner

RUN corepack enable pnpm
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace config and production package manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/server/package.json ./packages/server/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts
COPY --from=core-builder /app/packages/core/dist ./packages/core/dist
COPY --from=core-builder /app/packages/core/native/dist ./packages/core/native/dist
COPY --from=server-builder /app/packages/server/dist ./packages/server/dist
COPY --from=web-builder /app/packages/web/dist ./packages/web/dist

# Create data directory
RUN mkdir -p /data

ENV PORT=4410
ENV DB_PATH=/data/labby.db
ENV WEB_DIST_DIR=/app/packages/web/dist
ENV NODE_ENV=production

EXPOSE 4410

CMD ["node", "packages/server/dist/index.js"]
