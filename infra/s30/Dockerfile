FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS builder
WORKDIR /workspace
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run build

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS app
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /workspace/node_modules ./node_modules
COPY --from=builder --chown=node:node /workspace/apps ./apps
COPY --from=builder --chown=node:node /workspace/dist ./dist
COPY --from=builder --chown=node:node /workspace/scripts/s30-entrypoint.sh ./scripts/s30-entrypoint.sh
USER node
ENTRYPOINT ["sh", "/app/scripts/s30-entrypoint.sh"]
CMD ["node", "dist/apps/api/src/main.js"]

FROM nginx:1.28-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236 AS web
COPY --from=builder /workspace/dist/apps/web/operator /usr/share/nginx/html/operator
COPY infra/s30/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
