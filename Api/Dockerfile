# syntax=docker/dockerfile:1
#
# Api/ (NestJS 11 on Fastify + Prisma 7 + PostgreSQL) — multi-stage image.
# Builder compiles with full deps + `prisma generate`; runtime is slim, non-root, prod-deps only.
# Self-contained: build context is THIS folder only — no reference outside Api/ (works as its own repo).
# Migrations/seed NEVER run here — see the gated `db-setup` service in docker-compose.yml.

# ---- Stage 1: builder (full deps, generate client, compile) ----
FROM node:22-bookworm-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 AS builder
WORKDIR /app
# OpenSSL: required by the Prisma engine. ca-certificates: TLS to the DB/registry.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Install deps first (better layer caching). prisma/ is needed by the postinstall `prisma generate`.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
# Compile the app (nest build -> dist/main.js).
COPY . .
RUN npm run build

# ---- Stage 2: runtime (slim, non-root, production deps only) ----
FROM node:22-bookworm-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Clean production dependencies (no postinstall — the generated client is copied from the builder).
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# Generated Prisma client (built by `prisma generate` in the builder; same base => engine-compatible).
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist ./dist
RUN chown -R node:node /app
# Drop privileges (the node image ships a non-root `node` user).
USER node
EXPOSE 3000
# Liveness probe hits the DB-free health route, so it reflects process health, not DB state.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/main.js"]
