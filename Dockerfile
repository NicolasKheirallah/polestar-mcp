# Build stage: compile TypeScript with dev dependencies present.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build

# Runtime: production deps + compiled output only.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=build /app/build ./build
RUN npm ci --omit=dev && npm cache clean --force
# Credentials are mounted/read at runtime, never baked in:
#   docker run -v ~/.config/polestar-mcp:/config -e POLESTAR_ENV_FILE=/config/.env.secrets ...
ENTRYPOINT ["node", "build/server.js"]
