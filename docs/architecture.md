# Architecture

## Before you start

- Reading only: no Docker, no Bun, no server to run.
- Comfortable with TypeScript and HTTP. The streaming parts assume you know
  server-sent events; `protocols.ts` shows the two wire formats side by side.
- [development.md](development.md) covers the workflow for changing the code;
  this page covers why it is shaped this way.

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

## Request path

1. `app.ts` matches the route and picks a dialect — `/v1/chat/completions` is
   OpenAI, `/v1/messages` is Anthropic.
2. `middleware.ts` parses the body once and resolves the model id against the
   backend's list, rejecting unknown models before any model work starts.
3. Both routes land in one `completion` handler. Without `stream` it awaits the
   answer and formats it through the dialect; with `stream` it hands the sink to
   `stream.ts`.
4. `opencode.ts` owns everything backend: the session, the prompt, and the event
   tail that `stream.ts` turns into SSE frames.

A `Dialect` is only the bundle — prompt in, response out, SSE sink, error
format. `protocols.ts` and `stream.ts` implement those, so a new provider is
one entry in `dialects.ts` plus its two wire formats.

## Tools

A request that carries `tools` takes one extra step in each direction, and each
step belongs where it is:

- `protocols.ts` reads both dialects' tool shapes into one `Tools` — the
  functions offered and the results coming back — writes the results as prompt
  text, describes the functions for the model, and lifts a call back out of the
  answer.
- `opencode.ts` creates the session with every tool set to ask, waits for the
  turn or for a request to run a tool together, and refuses the ones the caller
  never offered. The details are in [tool-calling.md](tool-calling.md).
- `stream.ts` carries a call as a `tool_calls` delta or a `tool_use` block, and
  a request that offers tools does not stream live — there is nothing to stream
  until the turn ends and the answer is known to be prose or a call.

## Errors

Failures are thrown as `HttpError` from `lib.ts` and rendered by `protocols.ts`
in whichever dialect the route selected — so a client sees an OpenAI error on
the OpenAI route and an Anthropic one on the Anthropic route, and an unknown
route is reported the OpenAI way. An `HttpError` is the client's business and
stays quiet in the log; anything else is logged and reported as a 500.