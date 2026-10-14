import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";

export function findBinary() {
  const candidates = [
    path.join(os.homedir(), ".opencode", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    const found = execSync("command -v opencode", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (found) return found;
  } catch {}
  return "opencode";
}