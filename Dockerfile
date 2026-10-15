FROM oven/bun:1-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
# Migrations run at boot (idempotent), then the HTTP + WebSocket server.
CMD ["bun", "src/server.ts"]
