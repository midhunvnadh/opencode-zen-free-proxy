// @ts-nocheck
import { randomHex } from "./lib/id.ts";
import { KEYS_FILE } from "./config.ts";

export let apiKeys: Record<string, string> = {};

export async function loadKeys() {
  const file = Bun.file(KEYS_FILE);
  try {
    if (await file.exists()) apiKeys = await file.json();
  } catch {}
  if (Object.keys(apiKeys).length === 0) {
    apiKeys = {
      default: "oc-" + randomHex(20),
    };
    await Bun.write(KEYS_FILE, JSON.stringify(apiKeys, null, 2));
    console.log("[INIT] Generated new API key ->", KEYS_FILE);
  }
}