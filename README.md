# openai-compat-proxy

OpenAI-compatible API backed by the genuine `opencode` binary, so OpenCode's
free models keep working (the free tier rejects non-OpenCode TLS clients).

## Run

```bash
npm install
npm start          # http://localhost:8790 by default
npm run typecheck
```

Node 24 runs the TypeScript sources directly (type stripping), so there is no
build step.

## Env

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `PROXY_PORT` | `8790` | Listen port |
| `OC_BIN` | auto | Path to `opencode` binary |
| `OC_WORKDIR` | `./oc-workspace` | Agent working dir |
| `OC_SERVER` | – | Reuse an existing `opencode serve` URL |
| `OC_USERNAME` / `OC_PASSWORD` | `opencode` / – | Basic auth for `OC_SERVER` |
| `OC_TIMEOUT` | `600` | Per-request timeout (seconds) |
| `KEYS_FILE` | `./api-keys.json` | API keys file (auto-generated) |

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
