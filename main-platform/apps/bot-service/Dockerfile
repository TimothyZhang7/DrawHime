FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared-contracts/package.json packages/shared-contracts/
COPY packages/core-utils/package.json packages/core-utils/
COPY apps/SERVICE/package.json apps/SERVICE/
RUN pnpm install --frozen-lockfile --filter @aiimage/SERVICE...

FROM base AS build
COPY --from=deps /app/node_modules node_modules
COPY . .
RUN pnpm run build:SERVICE_SHORT

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/apps/SERVICE/dist dist
COPY --from=build /app/node_modules/.pnpm node_modules/.pnpm
COPY --from=deps /app/apps/SERVICE/node_modules node_modules
EXPOSE PORT
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "require('http').get('http://localhost:PORT/health',r=>{process.exit(r.statusCode===200?0:1)})"
CMD ["node", "dist/main.js"]
