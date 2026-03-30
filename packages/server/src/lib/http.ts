import type { Context } from "hono";

import type { ApiResponse, ErrorResponse, ErrorCode } from "../types/common.js";

export function getRequestId(c: Context): string {
  return c.req.header("X-Request-Id") ?? crypto.randomUUID();
}

export function ok<T>(c: Context, data: T, status = 200): Response {
  const requestId = getRequestId(c);
  const body: ApiResponse<T> = {
    data,
    requestId,
    serverTime: Date.now(),
  };
  return c.json(body, status as never);
}

export function fail(c: Context, code: ErrorCode, message: string, status: number): Response {
  const requestId = getRequestId(c);
  const body: ErrorResponse = {
    error: code,
    message,
    requestId,
  };
  return c.json(body, status as never);
}
