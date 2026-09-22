/** One-shot entry point for a Railway Cron service. */
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const baseUrl = required('LABBY_SERVER_URL').replace(/\/+$/, '');
const apiKey = required('SCHEDULER_DISPATCH_API_KEY');
const jobName = required('LABBY_CRON_JOB');

const response = await fetch(`${baseUrl}/internal/scheduler/dispatch`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
  body: JSON.stringify({ jobName }),
  signal: AbortSignal.timeout(Number(process.env.LABBY_CRON_TIMEOUT_MS ?? 120_000)),
});

if (!response.ok) {
  throw new Error(`Cron dispatch for ${jobName} failed (${response.status}): ${await response.text()}`);
}
console.info(`[railway-cron] Dispatched ${jobName}.`);
