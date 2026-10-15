# Tool calling

## How it works

opencode runs an agentic loop: the model asks for a tool, opencode runs it, and the
model answers. Clients that use tools expect the opposite — they want the call, they
run it themselves, and they send the result back. The gap is bridged with opencode's
permission system, which is the one hook that lets the proxy stop a tool *before* it
runs.

Verified against opencode v2.0.29:

| Step | What the backend does |
| ---- | --------------------- |
| Create the session with `permissions: [{action: "*", resource: "*", effect: "ask"}]` | every tool call blocks |
| The model asks for a tool | the part's `state.status` is `running`, not `completed`, and the turn never ends |
| `GET /api/session/:id/permission` | lists the pending request: `action`, `source.id` (the call id) |
| `GET /api/session/:id/message` | the blocked part carries `name` and `state.input` — the arguments |
| `POST /api/session/:id/permission/:requestID/reply` `{decision: "reject"}` | aborts the tool (`state.status: "error"`, `error.type: "aborted"`) and ends the turn |
| A follow-up prompt carrying the result | the model continues and answers |

`POST /api/experimental/session/:id/wait` blocks for as long as a permission is
pending, so waiting for the turn and watching for the request happen together.

## The turn loop

1. The request carries `tools`. The session is created with the `ask` rule above.
2. The prompt runs. Text and reasoning stream as usual.
3. A tool of opencode's own blocks. The proxy rejects it — nothing has run yet — and
   points the model at the caller's functions.
4. The model announces one in a `tool_call` block and the proxy answers with
   `finish_reason: "tool_calls"`. A block naming anything the client did not declare is
   not handed over: the model is pointed at the ones it did and answers without it.
5. The client executes the tool and sends the result back in `role: "tool"` (OpenAI) or
   a `tool_result` block (Anthropic).
6. The proxy turns the result into prompt text and prompts the same session again. The
   model answers, and the reply to the client is an ordinary completion.

## Rules

- **Only declared tools are handed over.** The proxy is what tells the caller's machine
  what to run, so a block naming a function the client never offered is dropped rather
  than dispatched. Both refusals — this one and opencode's own tool — cost the same round
  and leave the model pointed at the functions that do exist.
- **The block is never answer text.** It is the proxy's own convention, so it is lifted out
  of the answer whatever is inside it: a call, the instruction template copied back
  verbatim, or an opener a truncated turn left unclosed.
- **A tool result is a request.** `role: "tool"` / `tool_result` with no new user text
  is a continuation, not an empty request.
- **The call id is opencode's.** It travels out as `tool_call_id` and comes back
  unchanged.

Measured against a real model (`cat-jam-free`), naming a function the client never
declared fires on the first try, not as a rare edge case: the model emits a block for
whatever the request names. The live suite pins it in
`test/live.test.ts`.