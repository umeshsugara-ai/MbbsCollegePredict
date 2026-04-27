# Single-stage runtime — `tsx` executes TypeScript directly so no separate
# compile step is needed. Image is intentionally small: only what's required
# to boot the Express server and read the CSVs/prompts.json/HTML at runtime.

FROM node:20-alpine

WORKDIR /app

# Install deps first so Docker can cache this layer when only source changes.
# We need devDependencies (tsx, cross-env) to run the start script.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy the rest of the application. .dockerignore excludes .env, .env.local,
# .git, node_modules, .claude, .playwright-mcp, test screenshots, and the
# unused `data/neet/raw|per_round|derived|feedback` subfolders.
COPY . .

# The server listens on $PORT (default 3000). docker-compose maps host:3000
# to container:3000.
ENV PORT=3000
EXPOSE 3000

# Healthcheck so docker compose / orchestrators can detect a wedged process
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health > /dev/null || exit 1

# Production start. NODE_ENV is set inside the start script via cross-env;
# any env vars passed via docker-compose `environment:` or `env_file:` win
# over what dotenv would load (dotenv won't override an already-set var).
CMD ["npm", "run", "start"]
