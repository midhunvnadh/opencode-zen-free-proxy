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
```

Bun runs the TypeScript sources directly, so there is no build step and no Node
install. An `opencode` binary on `PATH` is used as the backend, otherwise set
`OC_BIN`.

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

`Dockerfile` builds the sources on `oven/bun:1-slim` and bundles `opencode-cli`,
the backend the proxy spawns. `bun.lock` pins the dependency versions the image
installs. Compose is the easy path; plain Docker works too:

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

### Adding opencode-cli

1. `ENV BUN_INSTALL=/usr/local/bun` — keeps the global install out of `/root`,
   so the unprivileged `app` user can execute it.
2. `bun install -g --trust @opencode/cli@2` — pulls the CLI plus the native
   binary for the build platform; `--trust` allows its postinstall script. Bump
   the version here; the image is ~1 GB because that install carries one binary
   per platform.
3. `ENV OC_BIN=/usr/local/bin/opencode` — the proxy spawns this path directly
   instead of searching `PATH`.
4. `git` is installed because opencode shells out to it for repo and snapshot
   work.

Verify with `docker run --rm oc-proxy opencode --version`.