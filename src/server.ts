import { createApp } from "./app.ts";
import { KEYS_FILE, PORT } from "./config.ts";
import { randomHex } from "./lib.ts";
import { listModels, start } from "./opencode.ts";

/** Reads the API keys, generating the file on the first start. */
async function loadKeys(): Promise<Record<string, string>> {
  const file = Bun.file(KEYS_FILE);
  let keys: Record<string, string> = {};
  try {
    if (await file.exists()) keys = await file.json();
  } catch {}
  if (Object.keys(keys).length === 0) {
    keys = { default: "oc-" + randomHex(20) };
    await Bun.write(KEYS_FILE, JSON.stringify(keys, null, 2));
    console.log("[INIT] Generated new API key ->", KEYS_FILE);
  }
  return keys;
}

const app = createApp();

// Bun closes a connection after idleTimeout seconds of silence (default 10), which
// would cut off a slow model mid-answer, so POSTs opt out per request.
const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 255,
  fetch(req, srv) {
    if (req.method === "POST") srv.timeout(req, 0);
    return app.fetch(req);
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.stop(true).then(() => process.exit(0));
  });
}

console.log(`openai compat proxy on http://0.0.0.0:${PORT}`);
const keys = await loadKeys();
try {
  await start();
  console.log("  Models:", (await listModels()).join(", "));
  for (const [name, key] of Object.entries(keys)) console.log(`  ${name.padEnd(15)} ${key}`);
} catch (e) {
  console.error("  Failed to start opencode backend:", e instanceof Error ? e.message : e);
  process.exit(1);
}
