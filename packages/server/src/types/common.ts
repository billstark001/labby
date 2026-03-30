export type ErrorCode =
  | "AUTH_INVALID"
  | "AUTH_EXPIRED"
  | "VALIDATION_ERROR"
  | "DEVICE_NOT_FOUND"
  | "TOKEN_INVALID"
  | "IDEMPOTENCY_CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export interface CommonRequestHeaders {
  Authorization: string;
  "X-Request-Id": string;
  "X-Idempotency-Key"?: string;
  "Content-Type": "application/json";
}

export interface ErrorResponse {
  error: ErrorCode;
  message: string;
  requestId: string;
}

export interface ApiResponse<T> {
  data: T;
  requestId: string;
  serverTime: number;
}
