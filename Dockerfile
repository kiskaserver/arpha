# syntax=docker/dockerfile:1

# ---- build: install the workspace, build the PWA and the server bundle ----
FROM node:26-slim AS build
ENV CI=true HUSKY=0
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Node ≥ 25 no longer bundles corepack: install the exact pnpm from "packageManager".
RUN npm install -g --no-fund --no-audit "$(node -p "require('./package.json').packageManager")"
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @arpha/web build && pnpm --filter @arpha/server build
# Self-contained production install of the server (no workspace links, no dev deps).
RUN pnpm --filter @arpha/server deploy --prod /out/server

# ---- runtime: only what the server needs ----
FROM node:26-slim AS runtime
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data WEB_DIST=/app/web
WORKDIR /app
COPY --from=build --chown=node:node /out/server ./server
COPY --from=build --chown=node:node /src/apps/web/dist ./web
COPY --from=build --chown=node:node /src/data/gazetteer.json ./data/gazetteer.json
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "server/dist/main.mjs"]
