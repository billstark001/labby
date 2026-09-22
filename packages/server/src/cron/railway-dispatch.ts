import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

type Environment = Record<string, string | undefined>;
type Fetch = typeof fetch;

export interface RailwayCronDispatchOptions {
  env?: Environment;
  fetch?: Fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInteger(env: Environment, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Dispatch one registered server job and return after it completes.
 * Railway Serverless may return a transient gateway error during a cold start,
 * so only gateway/network failures are retried. Application 4xx/5xx failures
 * remain visible immediately and are never reported as successful.
 */
export async function dispatchRailwayCron(options: RailwayCronDispatchOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? delay;
  const baseUrl = required(env, 'LABBY_SERVER_URL').replace(/\/+$/, '');
  const apiKey = required(env, 'SCHEDULER_DISPATCH_API_KEY');
  const jobName = required(env, 'LABBY_CRON_JOB');
  const timeoutMs = positiveInteger(env, 'LABBY_CRON_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const attempts = positiveInteger(env, 'LABBY_CRON_ATTEMPTS', DEFAULT_ATTEMPTS);
  const dispatchUrl = new URL('/internal/scheduler/dispatch', `${baseUrl}/`);

  if (dispatchUrl.protocol !== 'https:' && dispatchUrl.hostname !== 'localhost' && dispatchUrl.hostname !== '127.0.0.1') {
    throw new Error('LABBY_SERVER_URL must use HTTPS outside localhost');
  }

  let lastFailure = 'unknown failure';
  let attempted = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    attempted = attempt;
    try {
      const response = await fetchImpl(dispatchUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ jobName }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        console.info(`[railway-cron] Dispatched ${jobName}.`);
        return;
      }

      const responseBody = (await response.text()).slice(0, 2_000);
      lastFailure = `HTTP ${response.status}${responseBody ? `: ${responseBody}` : ''}`;
      if (!RETRYABLE_STATUSES.has(response.status)) break;
    } catch (error) {
      lastFailure = errorMessage(error);
    }

    if (attempt < attempts) {
      await sleep(Math.min(1_000 * (2 ** (attempt - 1)), 10_000));
    }
  }

  throw new Error(`Cron dispatch for ${jobName} failed after ${attempted} attempt(s): ${lastFailure}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  await dispatchRailwayCron();
}
