import { GoogleAuth } from 'google-auth-library';

import type { CronJobDefinition, SchedulerMirror } from './scheduler.js';

interface CloudSchedulerMirrorConfig {
  projectId: string;
  location: string;
  dispatchUrl: string;
  dispatchApiKey: string;
  jobPrefix: string;
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
  private readonly auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
  private readonly parentPath: string;

  constructor(private readonly config: CloudSchedulerMirrorConfig) {
    this.parentPath = `projects/${config.projectId}/locations/${config.location}`;
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
    const url = `${this.jobsApiBase}?pageSize=500`;
    const response = await client.request<{ jobs?: Array<{ name?: string; description?: string }> }>({
      url,
      method: 'GET',
    });
    return response.data.jobs ?? [];
  }

  private async upsertJob(definition: CronJobDefinition): Promise<void> {
    const client = await this.auth.getClient();
    const fullName = this.getFullJobName(definition.name);

    const payload = this.buildJobPayload(definition);
    try {
      await client.request({
        url: `https://cloudscheduler.googleapis.com/v1/${fullName}`,
        method: 'PATCH',
        params: {
          updateMask: 'schedule,timeZone,httpTarget,description',
        },
        data: payload,
      });
      return;
    } catch (error) {
      const status = errorStatus(error);
      if (status === 409) {
        // Concurrent upserts can temporarily conflict; treat as eventually-consistent success.
        return;
      }
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
        await client.request({
          url: `https://cloudscheduler.googleapis.com/v1/${fullName}`,
          method: 'PATCH',
          params: {
            updateMask: 'schedule,timeZone,httpTarget,description',
          },
          data: payload,
        });
      } catch (patchError) {
        const patchStatus = errorStatus(patchError);
        if (patchStatus !== 404 && patchStatus !== 409) {
          throw toErrorWithStatus(`Cloud Scheduler patch-after-create failed for ${definition.name}`, patchError);
        }
      }
    }
  }

  private async deleteJobByFullName(fullName: string): Promise<void> {
    const client = await this.auth.getClient();
    try {
      await client.request({
        url: `https://cloudscheduler.googleapis.com/v1/${fullName}`,
        method: 'DELETE',
      });
    } catch (error) {
      const status = errorStatus(error);
      if (status !== 404 && status !== 409) {
        throw toErrorWithStatus(`Cloud Scheduler delete failed for ${fullName}`, error);
      }
    }
  }

  async upsert(definition: CronJobDefinition): Promise<void> {
    await this.upsertJob(definition);
  }

  async remove(name: string): Promise<void> {
    await this.deleteJobByFullName(this.getFullJobName(name));
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
      if (!desired.has(fullName)) {
        await this.deleteJobByFullName(fullName);
      }
    }
  }

  async shutdown(): Promise<void> {
    // No persistent local resources to release.
  }
}

export function createCloudSchedulerMirrorFromEnv(): CloudSchedulerMirror | null {
  const projectId = process.env.CLOUD_SCHEDULER_PROJECT_ID?.trim();
  const location = process.env.CLOUD_SCHEDULER_LOCATION?.trim();
  const dispatchApiKey = process.env.SCHEDULER_DISPATCH_API_KEY?.trim();

  const explicitDispatchUrl = process.env.CLOUD_SCHEDULER_DISPATCH_URL?.trim();
  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim();
  const fallbackDispatchUrl = publicBaseUrl
    ? `${trimTrailingSlash(publicBaseUrl)}/internal/scheduler/dispatch`
    : undefined;
  const dispatchUrl = explicitDispatchUrl || fallbackDispatchUrl;

  if (!projectId || !location || !dispatchApiKey || !dispatchUrl) {
    return null;
  }

  const jobPrefix = process.env.CLOUD_SCHEDULER_JOB_PREFIX?.trim() || 'labby';

  return new CloudSchedulerMirror({
    projectId,
    location,
    dispatchUrl,
    dispatchApiKey,
    jobPrefix,
  });
}
