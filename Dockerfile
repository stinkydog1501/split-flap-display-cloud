# --- build stage ---------------------------------------------------------
# Installs ONLY production deps into a clean node_modules tree that we copy
# into the runtime stage. Keeps the final image free of npm/yarn and dev
# packages, and gives us reproducible installs via `npm ci`.

FROM node:20-slim AS build
WORKDIR /app

# Install deps with the lockfile if present (npm ci is strict).
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# --- runtime stage -------------------------------------------------------
# node:20-slim has glibc and the basics. We add dumb-init for proper signal
# handling so SIGTERM propagates to the Node process (not PID 1).

FROM node:20-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    LOG_LEVEL=info

# Install dumb-init for clean signal forwarding.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Bring in production node_modules from the build stage.
COPY --from=build /app/node_modules ./node_modules

# Bring in the application source.
COPY package.json ./
COPY src ./src
COPY public ./public

# Run as the unprivileged `node` user that the base image ships.
USER node

EXPOSE 3000

# Liveness probe — the same path the docker-compose healthcheck hits.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+process.env.PORT+'/api/me',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]