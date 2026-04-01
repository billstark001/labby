import type { Context, Next } from "hono";

import { fail } from "../lib/http.js";
import { UserRole, type AuthRole } from "../lib/auth.js";
import type { AuthService, AuthSession } from "../lib/auth.js";

export function requireRequestId(c: Context, next: Next): Promise<void | Response> {
  if (!c.req.header("X-Request-Id")) {
    return Promise.resolve(fail(c, "VALIDATION_ERROR", "X-Request-Id header is required", 400));
  }
  return next();
}

export function requireClientAuth(authService: AuthService) {
  return async (c: Context, next: Next): Promise<void | Response> => {
    const auth = c.req.header("Authorization") ?? "";
    if (!auth.startsWith("Bearer ") || auth.length <= "Bearer ".length) {
      return fail(c, "AUTH_INVALID", "Bearer token is required", 401);
    }

    try {
      const session = await authService.verifyAccessToken(auth.slice("Bearer ".length));
      c.set("auth", session as never);
      return next();
    } catch {
      return fail(c, "AUTH_INVALID", "Bearer token is invalid", 401);
    }
  };
}

export function requireMinRole(minRole: AuthRole) {
  return (c: Context, next: Next): Promise<void | Response> => {
    const session = c.get("auth") as AuthSession | undefined;
    if (!session) {
      return Promise.resolve(fail(c, "AUTH_INVALID", "authentication required", 401));
    }
    const validRoles: AuthRole[] = [UserRole.User, UserRole.Admin, UserRole.Root];
    if (!validRoles.includes(session.role)) {
      return Promise.resolve(fail(c, "AUTH_INVALID", "invalid session role", 401));
    }
    if (session.role < minRole) {
      return Promise.resolve(fail(c, "AUTH_FORBIDDEN", "insufficient permissions", 403));
    }
    return next();
  };
}

export function getAuthSession(c: Context): AuthSession {
  const session = c.get("auth") as AuthSession | undefined;
  if (!session) {
    throw new Error("auth session missing from context");
  }
  return session;
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

export { UserRole };
