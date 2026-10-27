# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- all deps (build)
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update -qq && apt-get install -y -qq openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# npm ci: exactly the lockfile, or fail (npm install could silently drift).
RUN npm ci --legacy-peer-deps --no-audit --no-fund

# ---------------------------------------------------------------- build
FROM node:20-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update -qq && apt-get install -y -qq openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_LIVEKIT_URL=ws://localhost:7880
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ENV NEXT_PUBLIC_LIVEKIT_URL=$NEXT_PUBLIC_LIVEKIT_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_TELEMETRY_DISABLED=1
# Prisma needs a syntactically valid URL at generate time; the runtime env
# supplies the real one. Deliberately a non-routable dummy so no credential is
# baked into this image layer (see docs/VERIFY.md).
ENV DATABASE_URL="postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder"
RUN npx prisma generate
RUN npm run build

# ---------------------------------------------------------------- runtime deps only
# The standalone server traces what the app needs; the entrypoint additionally
# runs `prisma migrate deploy` and scripts/admin.mjs (Prisma client, bcryptjs).
# Production dependencies only: no TypeScript, Tailwind, tsx or @types in the image.
FROM node:20-bookworm-slim AS prod-deps
WORKDIR /app
RUN apt-get update -qq && apt-get install -y -qq openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --legacy-peer-deps --no-audit --no-fund \
  && DATABASE_URL="postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder" npx prisma generate \
  && npm cache clean --force

# ---------------------------------------------------------------- runtime
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends openssl ca-certificates wget && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/package.json ./package.json
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY cluster.js ./cluster.js
COPY docker-entrypoint.sh /docker-entrypoint.sh
# /app/secrets: mount point for the admin bootstrap password file (see
# scripts/create-admin.sh); container-only permissions.
RUN chmod +x /docker-entrypoint.sh && mkdir -p /app/secrets && chmod 700 /app/secrets && chown -R nextjs:nodejs /app

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Explicit CMD: without it the base image's CMD is inherited and the entrypoint
# (which forwards "$@") can never start the app.
CMD ["node", "cluster.js"]

ENTRYPOINT ["/docker-entrypoint.sh"]
