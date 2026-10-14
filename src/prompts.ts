// @ts-nocheck
export function extractText(content: any) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (c.type === "text") return c.text ?? "";
        if (c.type === "tool_result")
          return typeof c.content === "string"
            ? c.content
            : Array.isArray(c.content)
              ? c.content.map((x: any) => x.text || "").join("\n")
              : "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function messagesToPrompt(messages: any[]) {
  let system = "";
  const turns: string[] = [];
  for (const m of messages || []) {
    if (m.role === "system") system += (system ? "\n\n" : "") + extractText(m.content);
    else turns.push(`${m.role === "assistant" ? "Assistant" : "User"}: ${extractText(m.content)}`);
  }
  const lastUserText = [...turns].reverse().find((t) => t.startsWith("User:"))?.slice(6) ?? "";
  return { system, transcript: turns.join("\n\n"), lastUserText };
}

export function anthropicToPrompt(body: any) {
  const system = typeof body.system === "string" ? body.system : extractText(body.system);
  const { transcript, lastUserText } = messagesToPrompt(body.messages);
  return { system, transcript, lastUserText };
}
