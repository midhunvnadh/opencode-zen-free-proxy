import { findBinary } from "./lib.ts";

export const PORT = Number(process.env.PROXY_PORT ?? process.env.PORT ?? 8790);
export const PROXY_PORT = PORT;

export const OC_SERVER = process.env.OC_SERVER;
export const OC_USERNAME = process.env.OC_USERNAME || "opencode";
export const OC_PASSWORD = process.env.OC_PASSWORD;
export const OC_BIN = process.env.OC_BIN || (await findBinary());
export const OC_WORKDIR = process.env.OC_WORKDIR || `${process.cwd()}/oc-workspace`;
export const REQUEST_TIMEOUT = Number(process.env.OC_TIMEOUT || 600) * 1000;
export const KEYS_FILE = process.env.KEYS_FILE || `${process.cwd()}/api-keys.json`;
