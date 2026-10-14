# Development

## Before you start

- Optional. None of this is needed to *use* the proxy — the container is the
  supported path. Come here to change the code.
- Bun 1.2 or newer (`bun --version`). The sources are TypeScript and run
  directly; the tests run on plain Node under vitest.
- An `opencode` binary on `PATH`, or `OC_BIN` pointing at one. The proxy spawns
  it as its backend, so without it the server exits at boot.
- Port 8790 free. If the container from the quickstart is still running, stop it
  with `docker compose down` or set `PORT` — they will fight over the port.

How the code fits together is in [architecture.md](architecture.md).

## Run without Docker

```bash
bun install
bun start          # http://localhost:8790 by default
bun run dev        # same, restarting on change
bun run typecheck
bun run build      # one-file bundle -> dist/server.js (Docker adds --compile)
bun run test
bun run check      # typecheck + test, the same gate CI runs
```

Bun runs the TypeScript sources directly, so there is no build step and no Node
install. An `opencode` binary on `PATH` is used as the backend, otherwise set
`OC_BIN`. Variables in [configuration.md](configuration.md) apply here too.

## Tests

Vitest, on plain Node: nothing in the test path touches Bun's runtime API, and
the suites replace `opencode.ts` with a fake backend. `bun run test` runs them
once; `bunx vitest` watches.

| File | Covers |
| ---- | ------ |
| `test/lib.test.ts` | error normalisation, ids, basic auth, the stream pump |
| `test/protocols.test.ts` | prompt flattening, answer extraction, both response and error shapes |
| `test/api.test.ts` | every route end to end against a fake backend, streaming included |

`test/api.test.ts` drives the real `app.ts`, middleware, dialects, sinks and
relay, so routing and both SSE sequences are covered without a live model. The
fake backend can be scripted to stream deltas, fail before streaming begins, or
fail after — which is how the two branches of the relay are covered.

Everything the tests cover is deterministic; nothing needs the network. That is
also why CI does not need a live `opencode` server to run them.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request to `main` and
`dev`, and a newer push to the same branch cancels the run it supersedes.

| Job | What it does |
| --- | ------------ |
| `verify` | `bun install --frozen-lockfile`, then `bun run typecheck` and `bun run test` |
| `image` | builds linux/amd64 *and* linux/arm64, then smoke-tests the artefacts |

`image` depends on `verify`, so a red test never spends a build. It builds both
supported architectures on every run — that is what keeps the [platform
ceiling](platforms.md) honest, since a missing platform manifest or a broken
musl build fails in CI rather than on someone else's server. It then loads a
native image and asserts the things that regress silently: `/app/proxy` is
executable, `opencode --version` runs, and no `node_modules`, `src/` or bun
runtime leaked into the runtime image.

Run the same gate locally before pushing:

```bash
bun run check    # typecheck + test
```

The workflow builds the image but does not push it. If you want it published to
a registry from `main`, that is a separate step to add — see
[platforms.md](platforms.md).

## Logs

`hono/logger` prints a line per request:

```
<-- POST /v1/messages
--> POST /v1/messages 200 2s
```

On a streaming request the second line fires when the stream is committed, so its
duration is time-to-first-token rather than the length of the whole answer.

On boot the proxy prints the backend URL, the model list, and every API key; the
[quickstart](../README.md) reads the key from those lines. Under `bun start` the
same lines are in your terminal.