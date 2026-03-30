import type { Context, Next } from "hono";

import { fail } from "../lib/http.js";

export function requireRequestId(c: Context, next: Next): Promise<void | Response> {
  if (!c.req.header("X-Request-Id")) {
    return Promise.resolve(fail(c, "VALIDATION_ERROR", "X-Request-Id header is required", 400));
  }
  return next();
}

export function requireClientAuth(c: Context, next: Next): Promise<void | Response> {
  const auth = c.req.header("Authorization") ?? "";
  if (!auth.startsWith("Bearer ") || auth.length <= "Bearer ".length) {
    return Promise.resolve(fail(c, "AUTH_INVALID", "Bearer token is required", 401));
  }
  return next();
}

export function requireServerAuth(apiKey: string) {
  return (c: Context, next: Next): Promise<void | Response> => {
    const auth = c.req.header("Authorization") ?? "";
    const xApiKey = c.req.header("X-Api-Key") ?? "";
    const valid = auth === `ApiKey ${apiKey}` || xApiKey === apiKey;
    if (!valid) {
      return Promise.resolve(fail(c, "AUTH_INVALID", "ApiKey authentication failed", 401));
    }
    return next();
  };
}

export function requireIdempotencyKey(c: Context, next: Next): Promise<void | Response> {
  const key = c.req.header("X-Idempotency-Key");
  if (!key) {
    return Promise.resolve(fail(c, "VALIDATION_ERROR", "X-Idempotency-Key header is required", 400));
  }
  return next();
}
