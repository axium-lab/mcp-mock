FROM oven/bun:1

WORKDIR /app

# Install dependencies first to leverage Docker layer caching. Only Express is
# needed at runtime; the official SDKs and the schemas are for the tests.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

ENV MCP_MOCK_PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["bun", "-e", "const res = await fetch(`http://localhost:${process.env.MCP_MOCK_PORT ?? 3000}/health`); if (!res.ok) process.exit(1);"]

USER bun
CMD ["bun", "src/index.ts"]
