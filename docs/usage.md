# Usage

## Before you start

- A running proxy — the [quickstart](../README.md). Confirm it with
  `curl -s http://localhost:8790/health`.
- A model id from `/v1/models`. The free models change over time, so read that
  list rather than copying the ids in the examples below.
- An OpenAI-compatible client, or just curl. Nothing to install for the curl
  path.
- **Check the client against [compatibility.md](compatibility.md) first.** Any
  OpenAI-compatible client connects. Tool calling works, on both routes — see
  [tool-calling.md](tool-calling.md) for how it is reached and what it costs.
  Images do not: the API is text-only, single-choice, and ignores sampling
  parameters.

You do not need the API key — any value is accepted. To paste the real one
instead, `docker compose exec proxy cat /keys/api-keys.json`.

Not running it yet? [deployment.md](deployment.md).

## Base URL and API key

| Client | Base URL |
| ------ | -------- |
| OpenAI-compatible | `http://localhost:8790/v1` |
| Anthropic | `http://localhost:8790` |

The API key is the `oc-…` the container prints at startup. Any value is
accepted — see [auth](#auth-and-conversations).

## Call it

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

Or with curl:

```bash
curl -s http://localhost:8790/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"hello"}]}'
```

## Models

```bash
curl -s http://localhost:8790/v1/models | head -c 300
```

The ids change over time, so read the list rather than copying the examples
above. An `opencode/` prefix is optional — `opencode/big-pickle` and
`big-pickle` are the same model. An unknown id is rejected before any model work
starts, with the available ones in the error:

```
Unknown model: nope. Available: big-pickle, …
```

## Endpoints

| Method | Path | Format |
| ------ | ---- | ------ |
| `GET` | `/v1/models` | OpenAI model list |
| `GET` | `/v1/models/:model` | single model |
| `POST` | `/v1/chat/completions` | OpenAI chat (stream supported) |
| `POST` | `/v1/messages` | Anthropic messages (stream supported) |
| `GET` | `/health` | status |

`/health` reports the backend URL and the number of models, which is the first
thing to look at when a request misbehaves:

```bash
curl -s http://localhost:8790/health
```

## Auth and conversations

Auth is optional: any `Authorization: Bearer …` / `x-api-key` is accepted and
`OPENCODE_API_KEY` is no longer needed.

Without a conversation key, every turn is its own stateless session. Send
`x-oc-session: <name>` (or an OpenAI `user` field / Anthropic
`metadata.user_id`) to keep one opencode session per name: the first turn
replays the transcript the client sent and later turns continue it.

```bash
curl -s http://localhost:8790/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'x-oc-session: my-chat' \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"hello"}]}'
```

## Tools

Send `tools` and the model is given them. When it wants one, the reply carries
`finish_reason: "tool_calls"` instead of an answer; run the function, send the
result back, and the next reply is the answer to your original question.

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8790/v1", api_key="oc-…")
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Current weather for a city.",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    },
}]

messages = [{"role": "user", "content": "weather in Paris?"}]
res = client.chat.completions.create(model="big-pickle", messages=messages, tools=tools)
while res.choices[0].finish_reason == "tool_calls":
    call = res.choices[0].message.tool_calls[0]
    print("running", call.function.name, call.function.arguments)
    messages += [
        res.choices[0].message.model_dump(exclude_none=True),
        {"role": "tool", "tool_call_id": call.id, "content": look_up_weather(**json.loads(call.function.arguments))},
    ]
    res = client.chat.completions.create(model="big-pickle", messages=messages, tools=tools)

print(res.choices[0].message.content)
```

The Anthropic route takes `tools` in its own shape and answers with a
`tool_use` block; send the result back in a `tool_result` block. Both are in
[tool-calling.md](tool-calling.md), along with what this path costs: the tools
are described to the model rather than given to it, so it sometimes answers in
prose instead of calling.