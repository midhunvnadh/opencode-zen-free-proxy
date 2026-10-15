# Deployment

## Before you start

- Docker with the Compose plugin. That is the entire requirement — no API keys,
  no login, no build on your machine.
- A host that can run Linux containers: Linux natively, macOS or Windows through
  Docker Desktop or WSL2. CPU support is in
  [platforms.md](platforms.md).
- Port 8790 free on the host. Only one proxy can listen on it, so a local
  `bun start` and this container cannot both run.
- Read this only if the quickstart's `compose.yaml` is not what you want. The
  defaults already cover the usual setup.
- Heads up: `docker compose down -v` deletes the API keys volume. Every client
  you configured needs a new key pasted afterwards.

Tunables are in [configuration.md](configuration.md); what the image contains is
in [image.md](image.md).

## Compose

```bash
docker compose up -d --build
```

Compose is the easy path — plain Docker works too:

```bash
docker build -t oc-proxy .
docker run --rm -p 8790:8790 -v oc-keys:/keys -e KEYS_FILE=/keys/api-keys.json oc-proxy
```

The two are equivalent apart from the volume name: both keep the generated keys
in `/keys`.

## Ports

`compose.yaml` maps `${PORT:-8790}` to the container's 8790. `PORT=9000 docker
compose up -d` changes the port on your machine only; the container always
listens on 8790.

## Mounts

| Mount | Why |
| ----- | --- |
| `/keys` | generated `api-keys.json`; without a mount a new key is created on every start and printed to the logs |

Optional mounts, if you want them: `-v ./oc-workspace:/app/oc-workspace` for
files an agent writes, and
`-v oc-opencode:/home/app/.local/share/opencode` for opencode's logs. Neither is
needed for the proxy to work.

The container runs as an unprivileged `app` user (uid 1001). Bind mounts from
the host must be writable by that uid; the named volumes above already are.

## What survives a restart

Only the API keys are kept in a volume, so the key you pasted into your client
survives restarts and rebuilds. Nothing else needs to persist: multi-turn
conversations live in the proxy's memory and your client resends the transcript,
so a recreated container simply starts a fresh session and keeps answering.

`/app/oc-workspace` is scratch — bind-mount your own directory there if you want
to see files an agent writes.

## Day to day

```bash
docker compose logs -f proxy   # follow the log
docker compose up -d           # re-create the container after changing env vars
docker compose down            # stop, keep the API keys
docker compose down -v         # stop and delete the API keys too
docker compose up -d --build   # rebuild after changing src/
```

## Troubleshooting

If the container keeps restarting, `docker compose logs proxy` says why: the
proxy exits when `opencode serve` fails to start. Once it is up, `/health`
reports the backend URL and the model count.