# The image

## Before you start

- Docker. The first build downloads Bun and opencode, so it is not quick.
- Read this if you are changing the Dockerfile or want to know what you are
  pulling. To *run* the image as published, the [quickstart](../README.md) is
  enough.
- Builds are native to the machine you run them on. For anything else, see
  [platforms.md](platforms.md).

## What is in it

The image is alpine plus two files: the `opencode-cli` binary the proxy spawns,
and the proxy itself compiled into a single self-contained executable. Two
builder stages do the packaging and are then discarded, so the runtime carries
no bun, no glibc and no `node_modules`.

```
oven/bun:1-alpine  (build)    -> src/ + node_modules --compile--> /out/proxy
oven/bun:1-alpine  (opencode) -> @opencode/cli install     --> bin/opencode
alpine:3.20        (runtime) -> /usr/local/bin/opencode + /app/proxy + git
```

`bun.lock` pins the dependency versions the image installs. To run what is built
here, see [deployment.md](deployment.md).

## Size

Measured on linux/arm64:

| Layer | Debian image | This one |
| ----- | ------------ | -------- |
| base | `oven/bun:1-slim`, 278 MB | `alpine:3.20`, 9.5 MB |
| bun runtime | 88 MB | – (embedded in the proxy) |
| `opencode-cli` | 418 MB | 206 MB |
| git | 109 MB | 17.5 MB (with `libstdc++`) |
| proxy | 4 MB (`node_modules` + `src`) | 83 MB (one executable) |
| **image** | **1.04 GB** | **465 MB** |

The proxy executable is larger than the sources it replaces because `--compile`
embeds the bun runtime in it — the separate 88 MB install is gone either way.
The opencode binary itself (~206 MB) is the floor unless you stop shipping it.

### Why it is small

`opencode-cli` is the bulk of it, and its install is the part worth knowing
about:

- The runtime is alpine, so the `opencode` binary is the musl build, and the
  builder stage exists only to lift that one file out of the install.
- `@opencode/cli`'s postinstall hard-links the platform's native binary into
  `@opencode/cli/bin`, but the package manager also installs every sibling
  package matching `os`/`cpu` — on linux/arm64 that is a second ~200 MB musl
  build that a glibc image could never run. They are dropped after the install;
  the hard link keeps the real binary's inode alive on its own.
- The proxy is built with `bun build --compile`, so the final image needs no bun
  install and no `node_modules`.

## Bumping opencode

The version is the one in the builder stage:

```dockerfile
RUN bun install -g --trust @opencode/cli@2 \
 && rm -rf "$BUN_INSTALL/install/cache" "$BUN_INSTALL/install/global/node_modules/@opencode/cli-"* \
 && opencode --version
```

Verify with `docker run --rm oc-proxy opencode --version`.