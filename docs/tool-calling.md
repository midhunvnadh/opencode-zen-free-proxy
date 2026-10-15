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
3. A tool call blocks. If its name is one the client declared, the proxy rejects it —
   nothing has run yet — and answers with `finish_reason: "tool_calls"`.
4. The client executes the tool and sends the result back in `role: "tool"` (OpenAI) or
   a `tool_result` block (Anthropic).
5. The proxy turns the result into prompt text and prompts the same session again. The
   model answers, and the reply to the client is an ordinary completion.

## Rules

- **Only declared tools are handed over.** A tool the model asks for that the client
  did not declare is rejected too — the proxy never runs a tool the caller did not
  ask for. The model is told the tool is unavailable and answers without it.
- **A tool result is a request.** `role: "tool"` / `tool_result` with no new user text
  is a continuation, not an empty request.
- **The call id is opencode's.** It travels out as `tool_call_id` and comes back
  unchanged.