# ─── Stage 1: Install dependencies ────────────────────────────────────────────
FROM oven/bun:1 AS deps
WORKDIR /app

# better-sqlite3 needs native build tools for node-gyp
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
# Workspace members must be present so `@gezy/sdk` (workspace:*) resolves.
COPY packages ./packages
RUN bun install --frozen-lockfile

# ─── Stage 2: Build frontend ─────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY . .
RUN bun run build

# ─── Stage 3: Production image ───────────────────────────────────────────────
FROM oven/bun:1 AS production
WORKDIR /app

LABEL org.opencontainers.image.title="Gezy" \
      org.opencontainers.image.description="Self-hosted AI agents with persistent memory, real identity, and collaboration" \
      org.opencontainers.image.url="https://github.com/MarlBurroW/gezy" \
      org.opencontainers.image.source="https://github.com/MarlBurroW/gezy" \
      org.opencontainers.image.licenses="MIT"

# Install production dependencies (better-sqlite3 needs build tools for node-gyp)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
# The server imports `@gezy/sdk` (workspace pkg shipping TS source)
# at runtime, so the workspace members must be present for the production install
# AND must persist in the final image (Bun runs the SDK's src directly).
COPY packages ./packages
# Remove husky prepare script (not needed in production, bun ignores HUSKY=0)
RUN sed -i '/"prepare":/d' package.json && \
    bun install --frozen-lockfile --production && \
    apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Install gosu (entrypoint privilege dropping) + npm (plugin install
# at runtime — `installFromNpm` in services/plugins.ts spawns `npm
# install` to resolve a plugin's tarball + deps; the oven/bun:1 base
# image doesn't ship Node/npm so without this the marketplace install
# flow fails with `Executable not found in $PATH: "npm"`) + tmux (the
# admin web terminal backs sessions with tmux when available so they
# survive a server restart with their running processes — see
# services/terminal-sessions.ts; without tmux only scrollback is restored).
RUN apt-get update && apt-get install -y --no-install-recommends gosu npm tmux && rm -rf /var/lib/apt/lists/*

# Install Chromium for Playwright (the browse_url / screenshot_url tools and the
# browser_* session tools in src/server/tools/ drive a headless Chromium via
# playwright-extra → playwright; without the browser they fail at runtime with
# "Executable doesn't exist ... run `playwright install`").
#
# Run the project-local playwright CLI (resolved from the node_modules installed
# just above) rather than a pinned `playwright@x.y.z` — the browser build must
# match the installed library version, and the lockfile range can resolve upward.
#
# Install to a global path that the dropped-privilege runtime user (gezy,
# UID 1001) can read — the entrypoint execs the server via `gosu gezy`, so a
# browser installed under root's $HOME (~/.cache/ms-playwright) would be invisible.
# `--with-deps` pulls the OS shared libraries Chromium needs via apt; we install
# only chromium (not firefox/webkit) to keep the image lean, then chmod the
# browsers dir so the runtime user can read + execute it.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN bun x playwright install --with-deps chromium && \
    chmod -R a+rX /ms-playwright && \
    rm -rf /var/lib/apt/lists/*

# Copy built frontend
COPY --from=build /app/dist ./dist

# Copy server source + shared types + config files
COPY --from=build /app/src/server ./src/server
COPY --from=build /app/src/shared ./src/shared
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
# .env.example is the config catalog surfaced via list_platform_config_options
COPY --from=build /app/.env.example ./.env.example

# Create non-root user for security
RUN groupadd --gid 1001 gezy && \
    useradd --uid 1001 --gid gezy --shell /bin/sh --create-home gezy

# Create data directory with correct ownership
RUN mkdir -p /app/data && chown -R gezy:gezy /app/data

# Environment
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV GEZY_DATA_DIR=/app/data

# Git sha baked by CI — images have no .git, the edge update channel uses
# this to compare the running code against origin/main.
ARG GIT_SHA=""
ENV GEZY_GIT_SHA=$GIT_SHA

EXPOSE 3000

VOLUME ["/app/data"]

# Copy entrypoint script (handles permission fixing + privilege dropping)
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["bun", "src/server/index.ts"]
