import { GoogleAuth } from 'google-auth-library';
import { createPrivateKey } from 'node:crypto';

import type { CronJobDefinition, SchedulerMirror } from './scheduler.js';
import { validateHttpUrl } from '../lib/runtime-config.js';

interface CloudSchedulerMirrorConfig {
  projectId: string;
  location: string;
  dispatchUrl: string;
  dispatchApiKey: string;
  jobPrefix: string;
  credentials?: { client_email: string; private_key: string; project_id: string };
}

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

function errorStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } })?.response?.status;
}

function toErrorWithStatus(prefix: string, error: unknown): Error {
  const status = errorStatus(error);
  const message = status ? `${prefix} (status ${status})` : prefix;
  return new Error(message);
}

async function retryConflicts<T>(operation: () => Promise<T>, retryStatuses: readonly number[] = [409]): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 4 || !retryStatuses.includes(errorStatus(error) ?? 0)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * (2 ** attempt)));
    }
  }
}

function normalizeJobName(prefix: string, rawName: string): string {
  const slug = rawName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'job';
  return `${prefix}-${slug}`.slice(0, 500);
}

function trimTrailingSlash(input: string): string {
  return input.replace(/\/+$/, '');
}

function encodeDispatchPayload(jobName: string): string {
  return Buffer.from(JSON.stringify({ jobName })).toString('base64');
}

export class CloudSchedulerMirror implements SchedulerMirror {
  private readonly auth: GoogleAuth;
  private readonly parentPath: string;

  constructor(private readonly config: CloudSchedulerMirrorConfig) {
    this.parentPath = `projects/${config.projectId}/locations/${config.location}`;
    this.auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE], credentials: config.credentials });
  }

  private get jobsApiBase(): string {
    return `https://cloudscheduler.googleapis.com/v1/${this.parentPath}/jobs`;
  }

  private getFullJobName(localJobName: string): string {
    return `${this.parentPath}/jobs/${normalizeJobName(this.config.jobPrefix, localJobName)}`;
  }

  private buildJobPayload(definition: CronJobDefinition): Record<string, unknown> {
    return {
      name: this.getFullJobName(definition.name),
      description: `Labby mirrored job: ${definition.name}`,
      schedule: definition.expression,
      timeZone: definition.timezone ?? 'UTC',
      retryConfig: { retryCount: 0 },
      httpTarget: {
        uri: this.config.dispatchUrl,
        httpMethod: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': this.config.dispatchApiKey,
        },
        body: encodeDispatchPayload(definition.name),
      },
    };
  }

  private async listJobs(): Promise<Array<{ name?: string; description?: string }>> {
    const client = await this.auth.getClient();
    const jobs: Array<{ name?: string; description?: string }> = [];
    let pageToken: string | undefined;
    do {
      const response = await client.request<{
        jobs?: Array<{ name?: string; description?: string }>;
        nextPageToken?: string;
      }>({
        url: this.jobsApiBase,
        method: 'GET',
        params: { pageSize: 500, ...(pageToken ? { pageToken } : {}) },
      });
      jobs.push(...response.data.jobs ?? []);
      pageToken = response.data.nextPageToken;
    } while (pageToken);
    return jobs;
  }

  private async upsertJob(definition: CronJobDefinition): Promise<void> {
    const client = await this.auth.getClient();
    const fullName = this.getFullJobName(definition.name);

    const payload = this.buildJobPayload(definition);
    const patch = () => client.request({
      url: `https://cloudscheduler.googleapis.com/v1/${fullName}`,
      method: 'PATCH',
      params: { updateMask: 'schedule,timeZone,httpTarget,description,retryConfig' },
      data: payload,
    });
    try {
      await retryConflicts(patch);
      return;
    } catch (error) {
      const status = errorStatus(error);
      if (status !== 404) {
        throw toErrorWithStatus(`Cloud Scheduler patch failed for ${definition.name}`, error);
      }
    }

    try {
      await client.request({
        url: this.jobsApiBase,
        method: 'POST',
        data: payload,
      });
    } catch (error) {
      const status = errorStatus(error);
      if (status !== 409) {
        throw toErrorWithStatus(`Cloud Scheduler create failed for ${definition.name}`, error);
      }

      try {
        await retryConflicts(patch, [404, 409]);
      } catch (patchError) {
        throw toErrorWithStatus(`Cloud Scheduler patch-after-create failed for ${definition.name}`, patchError);
      }
    }
  }

  private async deleteJobByFullName(fullName: string): Promise<void> {
    const client = await this.auth.getClient();
    try {
      await retryConflicts(() => client.request({
        url: `https://cloudscheduler.googleapis.com/v1/${fullName}`,
        method: 'DELETE',
      }));
    } catch (error) {
      const status = errorStatus(error);
      if (status !== 404) {
        throw toErrorWithStatus(`Cloud Scheduler delete failed for ${fullName}`, error);
      }
    }
  }

  async sync(definitions: CronJobDefinition[]): Promise<void> {
    const desired = new Map(definitions.map((item) => [this.getFullJobName(item.name), item]));

    for (const definition of definitions) {
      await this.upsertJob(definition);
    }

    const existingJobs = await this.listJobs();
    for (const job of existingJobs) {
      const fullName = job.name;
      if (!fullName) continue;
      const expectedPrefix = `${this.parentPath}/jobs/${this.config.jobPrefix}-`;
      if (!fullName.startsWith(expectedPrefix)) continue;
      if (!job.description?.startsWith('Labby mirrored job: ')) continue;
      if (!desired.has(fullName)) {
        await this.deleteJobByFullName(fullName);
      }
    }
  }

  async shutdown(): Promise<void> {
    // No persistent local resources to release.
  }
}

export function createCloudSchedulerMirrorFromEnv(env: NodeJS.ProcessEnv = process.env): CloudSchedulerMirror | null {
  const projectId = env.CLOUD_SCHEDULER_PROJECT_ID?.trim();
  const location = env.CLOUD_SCHEDULER_LOCATION?.trim();
  const dispatchApiKey = env.SCHEDULER_DISPATCH_API_KEY?.trim();

  const explicitDispatchUrl = env.CLOUD_SCHEDULER_DISPATCH_URL?.trim();
  const publicBaseUrl = env.PUBLIC_BASE_URL?.trim();
  const fallbackDispatchUrl = publicBaseUrl
    ? `${trimTrailingSlash(publicBaseUrl)}/internal/scheduler/dispatch`
    : undefined;
  const dispatchUrl = explicitDispatchUrl || fallbackDispatchUrl;

  if (!projectId || !location || !dispatchApiKey || !dispatchUrl) {
    return null;
  }

  const jobPrefix = env.CLOUD_SCHEDULER_JOB_PREFIX?.trim() || 'labby';
  const dispatchUrlName = explicitDispatchUrl ? 'CLOUD_SCHEDULER_DISPATCH_URL' : 'PUBLIC_BASE_URL';
  const clientEmail = env.GOOGLE_CLOUD_CLIENT_EMAIL?.trim();
  const privateKeyValue = env.GOOGLE_CLOUD_PRIVATE_KEY?.trim();
  if (Boolean(clientEmail) !== Boolean(privateKeyValue)) {
    throw new Error('GOOGLE_CLOUD_CLIENT_EMAIL and GOOGLE_CLOUD_PRIVATE_KEY must be set together');
  }
  const privateKey = privateKeyValue?.replace(/\\n/g, '\n');
  if (privateKey) {
    try {
      createPrivateKey(privateKey);
    } catch {
      throw new Error('GOOGLE_CLOUD_PRIVATE_KEY is not a valid private key');
    }
  }

  return new CloudSchedulerMirror({
    projectId,
    location,
    dispatchUrl: validateHttpUrl(dispatchUrlName, dispatchUrl),
    dispatchApiKey,
    jobPrefix,
    credentials: clientEmail && privateKey ? { client_email: clientEmail, private_key: privateKey, project_id: projectId } : undefined,
  });
}
