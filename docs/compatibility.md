# Compatibility

## Before you start

- Check your client against the tables below *before* wiring it up. Any
  OpenAI-compatible client works, but clients that depend on **tool calling** or
  **images** will not — see [what is not supported](#what-is-not-supported).
- The proxy is a text-in, text-out adapter. It speaks the wire formats; it does
  not extend them.
- The container is what carries compatibility. Anything inside the image —
  opencode's own binary, the Bun runtime — is pinned there and rebuilt with
  `--build`, so a stale local checkout is never the problem.

## Clients

| Client | Base URL | Key |
| ------ | -------- | --- |
| OpenAI SDKs (python, node) and anything OpenAI-compatible | `http://localhost:8790/v1` | any value |
| Anthropic SDK | `http://localhost:8790` | any value |

No key is enforced — the proxy accepts whatever you send and never checks it.
That also means it will happily serve an unauthenticated client on a shared
network; put it behind something that authenticates if it is reachable by
anyone else.

Anthropic's SDK validates `max_tokens` client-side even though the proxy ignores
it, so keep passing it.

## What is supported

| Field | Notes |
| ----- | ----- |
| `model` | required; `opencode/` prefix optional; unknown ids rejected with the list |
| `messages` | roles `system`, `user`, `assistant` |
| `messages[].content` | a string, or an array of `text` / `tool_result` blocks |
| `stream` | `true` streams; default answers with one JSON body |
| `system` | Anthropic only, where it sits next to the messages |
| `user` / `metadata.user_id` / `x-oc-session` | the conversation key |

Responses carry one choice at index 0, `finish_reason` `stop` or `length`, and
`usage`. Reasoning models add `reasoning_content` to the OpenAI message (the
OpenRouter convention, not OpenAI's) and a `thinking` block to an Anthropic
stream — note the Anthropic *non-streaming* body contains the text block only.

Streaming emits the right frame and event sequence for each dialect: chat
completion chunks closed by `data: [DONE]`, or `message_start`,
`content_block_start/delta/stop`, `message_delta`, `message_stop`.

## What is not supported

Accepted without complaint, with no effect — the proxy never forwards them to
opencode:

`temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `stop`, `seed`,
`presence_penalty`, `frequency_penalty`, `n`, `logprobs`, `stream_options`,
`response_format`, `tools`, `tool_choice`, `parallel_tool_calls`

Consequences worth knowing before you commit to this proxy:

- **No tool calling.** No `tool_calls` are ever returned. A client that drives a
  model through tools will get prose instead, or stall.
- **No images or audio.** Content blocks that are not `text` or `tool_result`
  are dropped, so a vision request arrives as an empty string.
- **One choice.** `n` is ignored; you always get index 0.
- **No sampling control.** The model answers however the backend chooses. The
  system prompt is prepended as text, not sent as a real system role.

## Hosts and runtimes

| | |
| ------ | --- |
| Linux | native |
| macOS, Windows | through Docker Desktop or WSL2, running Linux containers |
| Local (no Docker) | Bun 1.2 or newer |

Container CPU support is in [platforms.md](platforms.md).

## The opencode backend

The image ships `@opencode/cli@2`, and the proxy talks to that server over its
HTTP API — `/api/model`, `/api/session`, `/api/session/:id/prompt`,
`/api/session/:id/message`, `/api/event`, and one `experimental` wait endpoint.
The coupling is real: an opencode release that moves those endpoints, changes
the shape of `/api/model`, or renames the `build` agent the proxy creates
sessions with will break the proxy until it is updated.

Only models with `providerID: "opencode"` are exposed — opencode's own models.
Other providers in your opencode config are deliberately not proxied.

If you need an opencode version the image does not ship, run your own server
and point the proxy at it with [`OC_SERVER`](configuration.md); the
`OC_USERNAME` / `OC_PASSWORD` pair is its basic auth.