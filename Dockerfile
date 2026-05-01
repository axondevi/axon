FROM oven/bun:1.1-alpine AS base

# System deps for native modules (pg, ioredis keep-alive, etc.)
RUN apk add --no-cache \
    ca-certificates \
    tini \
    && adduser -D -u 10001 axon

WORKDIR /app

# ─── deps layer ────────────────────────────────────────
FROM base AS deps
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# ─── build layer ───────────────────────────────────────
FROM base AS build
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
# Bun executes TS directly at runtime. Typecheck is a CI gate (see
# .github/workflows/ci.yml) — we don't want a type-only error blocking
# a deploy. Flip this on if you want extra safety at deploy time.

# ─── runtime ───────────────────────────────────────────
FROM base AS runtime

COPY --from=deps   /app/node_modules ./node_modules
COPY --from=build  /app/src ./src
COPY --from=build  /app/registry ./registry
COPY --from=build  /app/drizzle ./drizzle
COPY --from=build  /app/package.json ./package.json
COPY --from=build  /app/tsconfig.json ./tsconfig.json
COPY --from=build  /app/drizzle.config.ts ./drizzle.config.ts
# Compiled NFT contract artifact — referenced by src/nft when minting.
# Without it the runtime can still boot, but mintAgentNft fails on first
# call. Copy conditionally; if you don't ship NFTs, the directory simply
# doesn't exist in build/ and this is a no-op.
COPY --from=build  /app/contracts ./contracts

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER axon

# `tini` reaps zombies and forwards signals cleanly — matters for graceful
# shutdown (server handles SIGTERM).
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "run", "src/index.ts"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health/ready || exit 1
