import type { Context, MiddlewareHandler } from "hono";
import type { Dialect } from "./dialects.ts";
import { HttpError } from "./lib.ts";
import { listModels } from "./opencode.ts";

export interface Env {
  Variables: {
    body: any;
    modelId: string;
    dialect: Dialect;
  };
}

/** Parses the request body once, so the middleware below and the handler all read
 *  it from the context instead of re-reading the consumed stream. An empty body
 *  is an empty object; invalid JSON is left to bubble up into the error handler. */
export const withBody: MiddlewareHandler<Env> = async (c, next) => {
  const raw = await c.req.text();
  c.set("body", raw ? JSON.parse(raw) : {});
  await next();
};

/** Picks the wire format this request is answered and failed in. */
export const dialect = (d: Dialect): MiddlewareHandler<Env> =>
  async (c, next) => {
    c.set("dialect", d);
    await next();
  };

/** Resolves the requested model against the backend's list, from the path for
 *  `GET /v1/models/:model` and from the body for the completion routes, and rejects
 *  unknown ones before any model work starts. */
export const resolveModel: MiddlewareHandler<Env> = async (c, next) => {
  const id = c.req.param("model") ?? c.get("body")?.model;
  const models = await listModels();
  const modelId = String(id ?? "").replace(/^opencode\//, "");
  if (!models.includes(modelId)) {
    const message = `Unknown model: ${modelId}. Available: ${models.join(", ")}`;
    throw new HttpError(c.req.param("model") ? 404 : 400, message, "invalid_request_error");
  }
  c.set("modelId", modelId);
  await next();
};
