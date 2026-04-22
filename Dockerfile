FROM oven/bun:1.3-alpine AS base

# System deps for native modules (pg, ioredis keep-alive, etc.)
RUN apk add --no-cache \
    ca-certificates \
    tini \
    && adduser -D -u 10001 axon

WORKDIR /app

# ─── deps layer ────────────────────────────────────────
FROM base AS deps
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

# ─── build layer ───────────────────────────────────────
FROM base AS build
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile
COPY . .
# TypeScript is checked in CI; here we keep sources and let Bun run them.
RUN bun run typecheck

# ─── runtime ───────────────────────────────────────────
FROM base AS runtime

COPY --from=deps   /app/node_modules ./node_modules
COPY --from=build  /app/src ./src
COPY --from=build  /app/registry ./registry
COPY --from=build  /app/drizzle ./drizzle
COPY --from=build  /app/package.json ./package.json
COPY --from=build  /app/tsconfig.json ./tsconfig.json
COPY --from=build  /app/drizzle.config.ts ./drizzle.config.ts

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER axon

# `tini` reaps zombies and forwards signals cleanly — matters for graceful
# shutdown (server handles SIGTERM).
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "run", "src/index.ts"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1
