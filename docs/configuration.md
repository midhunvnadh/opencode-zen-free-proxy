# Configuration

## Before you start

- Something to configure: a container started from `compose.yaml`, or a local
  `bun start`. Variables set here apply at boot, so change them and re-create
  the container (`docker compose up -d`) — `--build` is only for source changes.
- Keep the current values before editing. Nothing warns you about a mistake: an
  unrecognised variable is silently ignored and its default stays in effect.
- These are read by the proxy itself, not the image, so a value survives every
  rebuild.

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

`OC_SERVER` points the proxy at a backend you run yourself instead of letting it
spawn `opencode serve`; `OC_USERNAME` / `OC_PASSWORD` are that backend's basic
auth, which the proxy generates at random when it spawns the backend itself.

## Where to set them

Put these in `compose.yaml` under `environment:` to change them. Nothing is
baked into the image, so a rebuild never loses a setting:

```yaml
services:
  proxy:
    environment:
      OC_TIMEOUT: "900"
```

Changing them only needs `docker compose up -d`, not `--build`. Locally, export
them in the shell before `bun start`.

The image sets its own defaults — `OC_BIN`, `PROXY_PORT`, `HOME`, `OC_WORKDIR`
and `KEYS_FILE` — and Compose overrides `KEYS_FILE` to put the keys in the
volume. Port mapping is in [deployment.md](deployment.md).