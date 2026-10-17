# The runtime image is alpine + opencode + one self-contained executable. Nothing
# else: no bun, no glibc, no node_modules, no TypeScript sources.
#
# Two builder stages do the packaging work and are then thrown away. Splitting
# them lets the final stage copy plain files instead of inheriting either
# toolchain - bun is only needed to compile, and to install opencode.
FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src

# --compile embeds the bun runtime, so the result is one file that runs on its own.
RUN bun build src/server.ts --target=bun --compile --minify --outfile /out/proxy

# opencode-cli is the backend the proxy spawns (`opencode serve`) and is the bulk of
# the image. It is installed here only to lift its native binary out: on alpine the
# postinstall picks the musl build, which is what a musl runtime can execute. Its
# package manager also installs every sibling matching os/cpu, so drop those - the
# hard-linked launcher in @opencode/cli/bin keeps its inode alive on its own.
FROM oven/bun:1-alpine AS opencode
ENV BUN_INSTALL=/usr/local/bun
RUN bun install -g --trust @opencode/cli@2 \
 && rm -rf "$BUN_INSTALL/install/cache" "$BUN_INSTALL/install/global/node_modules/@opencode/cli-"* \
 && opencode --version

FROM alpine:3.20

# git is what opencode shells out to for repo and snapshot work. libstdc++ is a
# dynamic dependency of the bun-compiled binaries above.
RUN apk add --no-cache git libstdc++ \
 && adduser --disabled-password --uid 1001 --home /home/app app

WORKDIR /app

# Mount points for the documented volumes. Creating them here means a fresh named
# volume inherits this ownership instead of Docker's root-owned default. They are
# made before the copies, and ownership is set by COPY --chown, because a later
# chown over a large copied file would copy it up into an extra layer.
RUN mkdir -p /home/app/.local/share/opencode /app/oc-workspace /keys \
 && chown -R app:app /home/app/.local /app/oc-workspace /keys

COPY --chown=app:app --from=opencode /usr/local/bun/install/global/node_modules/@opencode/cli/bin/opencode.exe /usr/local/bin/opencode
COPY --chown=app:app --from=build /out/proxy /app/proxy
COPY --chown=app:app .opencode /app/oc-workspace/.opencode

# OC_BIN is an absolute path so the proxy never has to search PATH.
# OC_WORKDIR / KEYS_FILE are written at runtime, so they must stay writable.
ENV OC_BIN=/usr/local/bin/opencode \
    PROXY_PORT=8790 \
    HOME=/home/app \
    OC_WORKDIR=/app/oc-workspace \
    KEYS_FILE=/app/api-keys.json

USER app
EXPOSE 8790

# The opencode backend can take a while to come up on first request, hence the
# generous start period. busybox wget covers the probe; the image has no bun.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PROXY_PORT:-8790}/health" || exit 1

CMD ["/app/proxy"]
