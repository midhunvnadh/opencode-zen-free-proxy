// @ts-nocheck
import { ocReq } from "./backend.ts";

let modelCache: string[] | null = null;

export async function getModels() {
  if (modelCache) return modelCache;
  const r: any = await ocReq("GET", "/api/model");
  if (r.status !== 200 || !Array.isArray(r.json?.data)) throw new Error("failed to list opencode models");
  modelCache = r.json.data
    .filter((m: any) => m.providerID === "opencode")
    .map((m: any) => m.id || m.modelID)
    .filter(Boolean);
  if (!modelCache.length) throw new Error("no opencode models found");
  return modelCache;
}

export function modelCacheCount() { return modelCache ? modelCache.length : 0; }
