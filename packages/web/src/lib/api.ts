import { apiFetch } from './auth.js';
import { isServerDeployment } from './runtime.js';

function redirectToLoginOnUnauthorized(status: number): void {
  if (!isServerDeployment || status !== 401 || typeof window === 'undefined') {
    return;
  }
  if (window.location.hash !== '#/login') {
    window.location.hash = '#/login';
  }
}

interface ApiEnvelope<T> {
  data: T;
  requestId: string;
  serverTime: number;
}

interface ApiErrorEnvelope {
  error?: string;
  message?: string;
  requestId?: string;
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class ApiClient {
  constructor(private readonly baseUrl = '/api/v1') {}

  private withHeaders(init: RequestInit = {}): RequestInit {
    const headers = new Headers(init.headers ?? {});
    if (!headers.has('X-Request-Id')) {
      headers.set('X-Request-Id', createRequestId());
    }
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    return {
      ...init,
      headers,
    };
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await apiFetch(`${this.baseUrl}${path}`, this.withHeaders(init));
    redirectToLoginOnUnauthorized(response.status);

    if (response.status === 204) {
      return undefined as T;
    }

    const body = await response.json().catch(() => undefined) as ApiEnvelope<T> | ApiErrorEnvelope | T | undefined;
    if (!response.ok) {
      if (body && typeof body === 'object' && ('message' in body || 'error' in body)) {
        throw new Error((body as ApiErrorEnvelope).message ?? (body as ApiErrorEnvelope).error ?? 'Request failed');
      }
      throw new Error(`Request failed with status ${response.status}`);
    }

    if (body && typeof body === 'object' && 'data' in body) {
      return (body as ApiEnvelope<T>).data;
    }

    return body as T;
  }

  async requestRaw(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await apiFetch(`${this.baseUrl}${path}`, this.withHeaders(init));
    redirectToLoginOnUnauthorized(response.status);
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as ApiErrorEnvelope | undefined;
      throw new Error(body?.message ?? body?.error ?? `Request failed with status ${response.status}`);
    }
    return response;
  }
}

export const apiClient = new ApiClient();