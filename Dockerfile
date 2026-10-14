# Bun runs the TypeScript sources directly, so dependencies are the only thing
# that needs to be staged separately from the app.
FROM oven/bun:1-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-slim

# opencode-cli is the backend the proxy spawns (`opencode serve`). It ships a
# native binary per platform as optional dependencies, and its postinstall must
# be allowed to run, hence --trust. BUN_INSTALL keeps the global install out of
# /root so the unprivileged runtime user can execute it.
ENV BUN_INSTALL=/usr/local/bun
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
RUN bun install -g --trust @opencode/cli@2 && rm -rf "$BUN_INSTALL/install/cache"

# OC_BIN is an absolute path so the proxy never has to search PATH.
# OC_WORKDIR / KEYS_FILE are written at runtime, so they must stay writable.
ENV OC_BIN=/usr/local/bin/opencode \
    PROXY_PORT=8790 \
    HOME=/home/app \
    OC_WORKDIR=/app/oc-workspace \
    KEYS_FILE=/app/api-keys.json

RUN useradd --create-home --home-dir /home/app --shell /usr/sbin/nologin app

# /app itself is created by root, and the runtime user writes api-keys.json and
# oc-workspace into it.
WORKDIR /app
RUN chown app:app /app
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json bun.lock tsconfig.json ./
COPY --chown=app:app src ./src

# Mount points for the documented volumes. Creating them here means a fresh
# named volume inherits this ownership instead of Docker's root-owned default.
RUN mkdir -p /home/app/.local/share/opencode /app/oc-workspace /keys \
 && chown -R app:app /home/app/.local /app/oc-workspace /keys

USER app
EXPOSE 8790

# The opencode backend can take a while to come up on first request, hence the
# generous start period.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PROXY_PORT||8790)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["bun", "run", "src/server.ts"]