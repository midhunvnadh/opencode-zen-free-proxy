# openai-compat-proxy

An OpenAI-compatible API backed by the genuine `opencode` binary, so OpenCode's
free models keep working (the free tier rejects non-OpenCode TLS clients).
The container image ships that CLI, so one `docker compose up` is all it takes.

## Getting started

Requires Docker with the Compose plugin. No API keys, no login, no build on your
machine.

```bash
git clone https://github.com/midhunvnadh/opencode-zen-free-proxy.git
cd opencode-zen-free-proxy
docker compose up -d --build
docker compose logs            # prints the generated API key and the models
```

The log ends with a line like:

```
proxy-1  |   default         oc-06ea5944be17b901a01a0c5e7a5de755a05dbf66
```

That is your API key. Grab it whenever you need it:

```bash
docker compose exec proxy cat /keys/api-keys.json
```

Check the service is up and list the models you can use:

```bash
curl -s http://localhost:8790/health
curl -s http://localhost:8790/v1/models | head -c 300
```

Ask a model something:

```bash
curl -s http://localhost:8790/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"hello"}]}'
```

### Use it from a client

Base URL `http://localhost:8790/v1` for OpenAI clients, `http://localhost:8790`
for Anthropic ones. Paste the logged key as the API key.

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8790/v1", api_key="oc-…")
print(client.chat.completions.create(
    model="big-pickle", messages=[{"role": "user", "content": "hello"}]
).choices[0].message.content)
```

```ts
import OpenAI from "openai"

const client = new OpenAI({ baseURL: "http://localhost:8790/v1", apiKey: "oc-…" })
const res = await client.chat.completions.create({
  model: "big-pickle",
  messages: [{ role: "user", content: "hello" }],
})
```

Use one of the model ids from `/v1/models` — the models change over time, so
read the list rather than copying the examples above.

### Day to day

```bash
docker compose logs -f proxy   # follow the log
docker compose up -d           # re-create the container after changing env vars
docker compose down            # stop, keep the API keys
docker compose down -v         # stop and delete the API keys too
docker compose up -d --build   # rebuild after changing src/
```

Only the API keys are kept in a volume, so the key you pasted into your client
survives restarts and rebuilds. Nothing else needs to persist: multi-turn
conversations live in the proxy's memory and your client resends the transcript,
so a recreated container simply starts a fresh session and keeps answering.
`/app/oc-workspace` is scratch — bind-mount your own directory there if you want
to see files an agent writes.

To run on another port, set `PORT=9000 docker compose up -d` — it changes the
port on your machine only; the container always listens on 8790.

If the container keeps restarting, `docker compose logs proxy` says why: the
proxy exits when `opencode serve` fails to start. Once it is up, `/health`
reports the backend URL and the model count.

## Run without Docker

```bash
bun install
bun start          # http://localhost:8790 by default
bun run typecheck
bun run build      # one-file bundle -> dist/server.js (Docker adds --compile)
```

Bun runs the TypeScript sources directly, so there is no build step and no Node
install. An `opencode` binary on `PATH` is used as the backend, otherwise set
`OC_BIN`.

## Source layout

| File | Role |
| ---- | ---- |
| `src/server.ts` | entry point: `Bun.serve`, signals, boot |
| `src/app.ts` | routes, request logging, error handling |
| `src/middleware.ts` | body parsing, dialect selection, model resolution |
| `src/dialects.ts` | `openai` / `anthropic`: the things that differ |
| `src/stream.ts` | frame buffer, the two SSE sinks, the streaming relay |
| `src/protocols.ts` | both wire formats: prompts in, answers and errors out |
| `src/opencode.ts` | the backend: spawn, requests, models, sessions, events |
| `src/lib.ts` | primitives: errors, ids, time, stream pump, binary lookup |
| `src/config.ts` | environment |

Imports only ever point down the table; nothing reaches back up for something it
did not need. The two completion routes are a single handler behind a `Dialect`,
so a third provider is one entry in `dialects.ts` rather than a new route.

`hono/logger` prints a line per request:

```
<-- POST /v1/messages
--> POST /v1/messages 200 2s
```

On a streaming request the second line fires when the stream is committed, so its
duration is time-to-first-token rather than the length of the whole answer.

## Env

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `PROXY_PORT` | `8790` | Listen port |
| `OC_BIN` | auto | Path to `opencode` binary |
| `OC_WORKDIR` | `./oc-workspace` | Agent working dir |
| `OC_SERVER` | – | Reuse an existing `opencode serve` URL instead of spawning one |
| `OC_USERNAME` / `OC_PASSWORD` | `opencode` / – | Basic auth for `OC_SERVER` |
| `OC_TIMEOUT` | `600` | Per-request timeout (seconds) |
| `KEYS_FILE` | `./api-keys.json` | API keys file (auto-generated) |

Put these in `compose.yaml` under `environment:` to change them. Nothing is
baked into the image, so a rebuild never loses a setting.

## Endpoints

| Method | Path | Format |
| ------ | ---- | ------ |
| `GET` | `/v1/models` | OpenAI model list |
| `GET` | `/v1/models/:model` | single model |
| `POST` | `/v1/chat/completions` | OpenAI chat (stream supported) |
| `POST` | `/v1/messages` | Anthropic messages (stream supported) |
| `GET` | `/health` | status |

Auth is optional: any `Authorization: Bearer …` / `x-api-key` is accepted and
`OPENCODE_API_KEY` is no longer needed. Add `x-oc-session: <name>` (or an OpenAI
`user` field / Anthropic `metadata.user_id`) for multi-turn conversations.

## Container images

The image is alpine plus two files: the `opencode-cli` binary the proxy spawns,
and the proxy itself compiled into a single self-contained executable. Two
builder stages do the packaging and are then discarded, so the runtime carries no
bun, no glibc and no `node_modules`. `bun.lock` pins the dependency versions the
image installs. Compose is the easy path; plain Docker works too:

```bash
docker build -t oc-proxy .
docker run --rm -p 8790:8790 -v oc-keys:/keys -e KEYS_FILE=/keys/api-keys.json oc-proxy
```

| Mount | Why |
| ----- | --- |
| `/keys` | generated `api-keys.json`; without a mount a new key is created on every start and printed to the logs |

Optional mounts, if you want them: `-v ./oc-workspace:/app/oc-workspace` for
files an agent writes, and
`-v oc-opencode:/home/app/.local/share/opencode` for opencode's logs. Neither is
needed for the proxy to work.

The container runs as an unprivileged `app` user (uid 1001). Bind mounts from
the host must be writable by that uid; the named volumes above already are.

### Size

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

### Platforms

linux/amd64 and linux/arm64, both musl. Both are built and tested. That pair is a
ceiling rather than a choice: `oven/bun:1-alpine` publishes only those two, and
`@opencode/cli` ships binaries only for linux `x64` and `arm64` (`x64-baseline`
covers CPUs without AVX2, and the postinstall picks it automatically). Anything
else fails at the first `FROM`:

```
no match for platform in manifest: not found
```

`compose.yaml` builds for whatever architecture it runs on. To publish one
multi-arch tag, build each platform and merge the manifests with buildx:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t youruser/oc-proxy .
```

### Why the image is small

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

Bumping opencode is the version in the builder stage:

```dockerfile
RUN bun install -g --trust @opencode/cli@2 \
 && rm -rf "$BUN_INSTALL/install/cache" "$BUN_INSTALL/install/global/node_modules/@opencode/cli-"* \
 && opencode --version
```

Verify with `docker run --rm oc-proxy opencode --version`.