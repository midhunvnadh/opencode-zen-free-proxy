import { createHash } from "node:crypto";

/** Canonical JSON serialization with sorted object keys for deterministic hashing. */
export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalJson).join(",") + "]";
  }
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(record[k])).join(",") + "}";
}

/** Computes the SHA-256 digest of a single message object. */
export function msgDigest(m: unknown): string {
  return createHash("sha256").update(canonicalJson(m)).digest("hex");
}

/** Returns the SHA-256 digests for all message objects in a list. */
export function digestsOf(messages: unknown[]): string[] {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m !== null && typeof m === "object")
    .map(msgDigest);
}

/** Canonical hash of the effective tools contract (tools list + tool_choice). */
export function toolsSignature(tools: unknown, toolChoice?: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ tools: tools || [], toolChoice: toolChoice ?? null }))
    .digest("hex");
}

export interface RegistryEntry {
  digests: string[];
  sid: string;
  lastReply: string;
  lastReasoning: string;
  toolsSig: string;
  used: number;
  tainted: boolean;
  key?: string | null;
}

/** Decides whether the [client tools] instructions belong in the prompt.
 *  On append-only delta turns where the tool contract has not changed,
 *  the backend session already holds it from the initial turn. */
export function shouldSendToolBlock(
  mode: "resync" | "delta",
  entry: RegistryEntry | null,
  hasTools: boolean,
  toolsSig: string
): boolean {
  if (!hasTools) return false;
  if (mode !== "delta" || !entry) return true;
  return entry.toolsSig !== toolsSig;
}

/** Drops an echoed assistant turn at the head of a delta tail when the backend
 *  session already holds that turn natively. Assistant turns carrying tool_calls
 *  or new reasoning are preserved. */
export function dropEchoedAssistant(tail: any[], lastReply = "", lastReasoning = ""): any[] {
  if (!tail || !tail.length || !lastReply) return tail;
  const head = tail[0];
  if (!head || typeof head !== "object" || head.role !== "assistant") return tail;
  // Never drop turns that carry tool calls; OpenAI IDs are protocol state needed for result pairing
  if (head.tool_calls && Array.isArray(head.tool_calls) && head.tool_calls.length > 0) return tail;
  // If head has reasoning that differs from stored lastReasoning, keep it
  const reasoning = typeof head.reasoning_content === "string" ? head.reasoning_content : "";
  if (reasoning && reasoning.trim() !== (lastReasoning || "").trim()) return tail;

  const content = typeof head.content === "string" ? head.content : "";
  if (content.trim() === (lastReply || "").trim()) {
    return tail.slice(1);
  }
  return tail;
}

/** Maps conversation message digests to backend OpenCode sessions. */
export class Registry {
  public readonly maxEntries: number;
  private entries: RegistryEntry[] = [];

  constructor(maxEntries: number = 64) {
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Finds the entry whose stored digests form the longest prefix match of incoming digests. */
  match(digests: string[], toolsSig: string, key?: string | null): RegistryEntry | null {
    let best: RegistryEntry | null = null;
    let bestLen = -1;

    for (const e of this.entries) {
      if (e.tainted) continue;
      // If a key was provided, match on key as well
      if (key && e.key && e.key !== key) continue;
      // Tool contract must match
      if (e.toolsSig !== toolsSig) continue;

      const stored = e.digests;
      if (stored.length <= bestLen) continue;
      if (digests.length >= stored.length && stored.every((d, i) => d === digests[i])) {
        best = e;
        bestLen = stored.length;
      }
    }

    if (best) {
      // Touch LRU: move to newest
      this.entries = this.entries.filter((e) => e !== best);
      best.used = Date.now();
      this.entries.push(best);
      return best;
    }
    return null;
  }

  /** Records or updates an entry in the registry. */
  record(
    digests: string[],
    sid: string,
    lastReply: string,
    lastReasoning: string,
    toolsSig: string,
    key?: string | null
  ): RegistryEntry {
    const entry: RegistryEntry = {
      digests: [...digests],
      sid,
      lastReply,
      lastReasoning,
      toolsSig,
      used: Date.now(),
      tainted: false,
      key: key ?? null,
    };
    this.entries = this.entries.filter((e) => e.sid !== sid);
    this.entries.push(entry);
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    return entry;
  }

  /** Marks a session tainted so subsequent requests force a fresh session. */
  markTainted(sid: string): void {
    for (const e of this.entries) {
      if (e.sid === sid) e.tainted = true;
    }
  }

  /** Drops an entry by session id. */
  invalidate(sid: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.sid !== sid);
    return this.entries.length !== before;
  }

  clear(): void {
    this.entries = [];
  }
}

export const globalRegistry = new Registry();
