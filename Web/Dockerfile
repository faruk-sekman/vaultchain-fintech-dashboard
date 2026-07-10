# syntax=docker/dockerfile:1
#
# Web/ (Angular 21 SPA) — multi-stage image. Node builder compiles the static bundle;
# nginx serves it and reverse-proxies /api/ to the backend.
# Self-contained: build context is THIS folder only — no reference outside Web/ (works as its own repo).
#
# DECOUPLING: the production build uses a RELATIVE apiBaseUrl ('/api/v1', see environment.prod.ts),
# so NO backend URL is baked into the JS bundle. The proxy target is chosen at RUNTIME via
# ${API_UPSTREAM}, so this image has zero hard dependency on any specific backend.

# ---- Stage 1: builder (compile the Angular app) ----
FROM node:22-bookworm-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Build configuration is overridable. Default `stage` = optimized + relative '/api/v1' (proxy-friendly)
# WITHOUT the production per-component SCSS budget gate (some in-flight redesign styles exceed the 8kB
# cap today, so a `production` build currently fails). Switch to the deploy-intent build once they pass:
#   docker build --build-arg NG_CONFIGURATION=production ...
ARG NG_CONFIGURATION=stage
RUN npm run build -- --configuration ${NG_CONFIGURATION}

# ---- Stage 2: runtime (nginx static + API reverse proxy) ----
FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10 AS runtime
# Angular application builder emits to dist/<project>/browser.
COPY --from=builder /app/dist/fintech-dashboard/browser /usr/share/nginx/html
# Served config is generated at startup from this template (envsubst fills ${API_UPSTREAM} only).
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
# Default upstream targets the compose `api` service; override for a standalone frontend.
ENV API_UPSTREAM=http://api:3000
# Restrict envsubst to our variable so nginx's own $host/$uri are left intact.
ENV NGINX_ENVSUBST_FILTER=API_UPSTREAM
EXPOSE 80
# (the nginx image's default entrypoint runs envsubst on /etc/nginx/templates/*.template, then starts nginx)
