# openai-compat-proxy

An OpenAI-compatible API backed by the genuine `opencode` binary, so OpenCode's
free models keep working (the free tier rejects non-OpenCode TLS clients).
The container image ships that CLI, so one `docker compose up` is all it takes.

It is a thin text adapter — streaming chat, one choice per request, no tool
calling and no images. Check [compatibility](docs/compatibility.md) before
pointing a tool at it that expects more.

## Quickstart

Requires Docker with the Compose plugin. No API keys, no login, no build on your
machine.

```bash
git clone https://github.com/midhunvnadh/opencode-zen-free-proxy.git
cd opencode-zen-free-proxy
docker compose up -d --build
docker compose logs proxy     # the last line is your API key
```

The log ends with a line like:

```
proxy-1  |   default         oc-06ea5944be17b901a01a0c5e7a5de755a05dbf66
```

Point any OpenAI-compatible client at it:

- **Base URL**: `http://localhost:8790/v1` (Anthropic clients: `http://localhost:8790`)
- **API key**: the `oc-…` above — any value is accepted

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8790/v1", api_key="oc-…")
print(client.chat.completions.create(
    model="big-pickle", messages=[{"role": "user", "content": "hello"}]
).choices[0].message.content)
```

Check it end to end without a client:

```bash
curl -s http://localhost:8790/health
curl -s http://localhost:8790/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"hello"}]}'
```

`big-pickle` is an example — the free models change over time, so read
`curl -s http://localhost:8790/v1/models` and use an id from that list.

Fetch the API key again whenever you need it:

```bash
docker compose exec proxy cat /keys/api-keys.json
```

## Day to day

| Command | Does |
| --- | --- |
| `docker compose logs -f proxy` | follow the log |
| `docker compose up -d` | re-create the container after changing env vars |
| `docker compose down` | stop, keep the API keys |
| `docker compose down -v` | stop and delete the API keys too |
| `docker compose up -d --build` | rebuild after changing `src/` |

Only the API keys live in a volume, so the key you pasted into your client
survives restarts and rebuilds.

If the container keeps restarting, `docker compose logs proxy` says why: the
proxy exits when `opencode serve` fails to start. Once it is up, `/health`
reports the backend URL and the model count.

## Documentation

The quickstart above is all you need to run the proxy. Every page below opens
with what it assumes — read one when you need it, not in order.

| Document | Covers |
| --- | --- |
| [docs/compatibility.md](docs/compatibility.md) | **read first** — which clients work, and what the API does not support |
| [docs/usage.md](docs/usage.md) | calling the proxy: base URLs, clients, models, endpoints, sessions |
| [docs/deployment.md](docs/deployment.md) | running the container: compose, ports, mounts, restarts, troubleshooting |
| [docs/configuration.md](docs/configuration.md) | env vars and where to set them |
| [docs/development.md](docs/development.md) | running without Docker, tests, logs |
| [docs/architecture.md](docs/architecture.md) | source layout, request path, errors |
| [docs/image.md](docs/image.md) | what is in the image, image size, bumping opencode |
| [docs/platforms.md](docs/platforms.md) | supported CPUs, publishing a multi-arch tag |