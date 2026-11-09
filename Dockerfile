# Build stage: compile TypeScript with dev dependencies present. The manifests
# are copied first so a source-only change reuses the npm layer.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# Runtime: production dependencies and the compiled output only.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
LABEL org.opencontainers.image.title="polestar-mcp" \
      org.opencontainers.image.description="Read-only MCP server for the Polestar Data Portal M2M API" \
      org.opencontainers.image.source="https://github.com/nicolaskheirallah/polestar-mcp" \
      org.opencontainers.image.licenses="MIT"
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/build ./build
# The stdio server holds no files under /app and needs no root. The healthcheck
# asks the entrypoint for its version, which exercises the build without a
# credential and exits before any transport is opened.
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "build/server.js", "--version"]
# Credentials are mounted or passed at runtime, never baked in:
#   docker run -i --rm -v ~/.config/polestar-mcp:/config -e POLESTAR_ENV_FILE=/config/.env.secrets polestar-mcp
ENTRYPOINT ["node", "build/server.js"]
