// @ts-nocheck
import fs from "fs";
import { randomHex } from "./lib/id.ts";
import { KEYS_FILE } from "./config.ts";

export let apiKeys: Record<string, string> = {};

export function loadKeys() {
  try { apiKeys = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8")); } catch {}
  if (Object.keys(apiKeys).length === 0) {
    apiKeys = {
      default: "oc-" + randomHex(20),
    };
    fs.writeFileSync(KEYS_FILE, JSON.stringify(apiKeys, null, 2));
    console.log("[INIT] Generated new API key ->", KEYS_FILE);
  }
}

loadKeys();
