import crypto from "crypto";

export function randomHex(bytes = 12): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function rid(prefix: string, bytes = 12): string {
  return prefix + randomHex(bytes);
}