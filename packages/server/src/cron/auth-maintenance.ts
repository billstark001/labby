import type { SqliteStore } from '../store/index.js';
import type { CronScheduler } from './scheduler.js';

interface AuthMaintenanceConfig {
  cronExpression?: string;
  timezone: string;
}

export interface CreateAuthMaintenanceServiceOptions {
  scheduler: CronScheduler;
  store: SqliteStore;
}

function normalizeCronExpression(value: string | undefined): string {
  return value?.trim() || '17 3 * * *';
}

export class AuthMaintenanceService {
  constructor(
    private readonly options: CreateAuthMaintenanceServiceOptions,
    private readonly config: AuthMaintenanceConfig,
  ) {}

  syncJobs(): void {
    this.options.scheduler.unregister('auth-maintenance-cleanup');
    this.options.scheduler.register({
      name: 'auth-maintenance-cleanup',
      expression: this.config.cronExpression ?? '17 3 * * *',
      timezone: this.config.timezone,
      handler: async () => {
        await this.options.store.pruneExpiredRefreshTokens();
        await this.options.store.pruneAuthVerificationCodes();
      },
    });
  }
}

export function createAuthMaintenanceServiceFromEnv(
  options: CreateAuthMaintenanceServiceOptions,
): AuthMaintenanceService {
  return new AuthMaintenanceService(options, {
    cronExpression: normalizeCronExpression(process.env.AUTH_CLEANUP_CRON),
    timezone: process.env.AUTH_CLEANUP_TIMEZONE?.trim() || 'UTC',
  });
}
