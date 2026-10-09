# One image with the server and the built web app. Built and run by deploy/docker-compose.yml.

FROM node:24-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Dependencies first, so that code changes do not reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/server/prisma apps/server/prisma
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @dnd-map/web build && pnpm --filter @dnd-map/server build

# The web app is served as static files; its sources and tooling are not needed at run time.
RUN rm -rf apps/web/node_modules apps/web/src e2e node_modules/.cache


FROM node:24-bookworm-slim AS runtime
# Prisma's query engine needs OpenSSL.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data/uploads && chown node:node /data/uploads

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_DIST_DIR=/app/apps/web/dist \
    UPLOADS_DIR=/data/uploads \
    TRUST_PROXY=true
VOLUME ["/data/uploads"]
EXPOSE 3000
USER node

# Migrations are applied before the server starts; `migrate deploy` is safe to run on every start.
CMD ["sh", "-c", "apps/server/node_modules/.bin/prisma migrate deploy --schema apps/server/prisma/schema.prisma && exec node apps/server/dist/index.js"]
