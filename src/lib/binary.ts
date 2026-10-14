export async function findBinary(): Promise<string> {
  const home = process.env.HOME || "";
  const candidates = [
    home && `${home}/.opencode/bin/opencode`,
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return Bun.which("opencode") || "opencode";
}