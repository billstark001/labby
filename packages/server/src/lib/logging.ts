export function safeErrorInfo(error: unknown): { errorType: string; code?: string } {
  let current: unknown = error;
  let code: string | undefined;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === 'string' && /^[A-Z0-9_]{2,20}$/.test(value.code)) code = value.code;
    current = value.cause;
  }
  return { errorType: error instanceof Error ? error.constructor.name : 'UnknownError', code };
}
