export function randomHex(bytes = 12): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function rid(prefix: string, bytes = 12): string {
  return prefix + randomHex(bytes);
}