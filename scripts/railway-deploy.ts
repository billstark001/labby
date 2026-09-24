import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildDeploymentEnvPlan, diffDeploymentEnvironment, parseDeploymentEnvArguments, RAILWAY_CRON_ENV_KEYS, SERVER_RUNTIME_ENV_KEYS } from './deploy-env.js';

export type RailwayServiceKind = 'server' | 'cron';

const DEFAULT_RAILWAY_SERVICES: Record<RailwayServiceKind, string> = {
  server: 'labby-api',
  cron: 'labby-auth-cleanup',
};

const SHARED_DEPLOY_PATTERNS = [
  /^Dockerfile$/,
  /^\.railway\/railway\.ts$/,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^packages\/core\//,
  /^packages\/server\//,
];

const TARGET_DEPLOY_PATTERNS: Record<RailwayServiceKind, RegExp[]> = {
  server: [/^packages\/web\//],
  cron: [],
};

function run(command: string, args: string[], options: { capture?: boolean; input?: string } = {}): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    input: options.input,
    stdio: options.capture ? ['pipe', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0) {
    const detail = options.capture ? (result.stderr ?? '').trim() : '';
    throw new Error(`${command} ${args.join(' ')} failed with code ${result.status ?? 1}${detail ? `: ${detail}` : ''}`);
  }
  return (result.stdout ?? '').trim();
}

function tryRun(command: string, args: string[]): string | null {
  try {
    return run(command, args, { capture: true });
  } catch {
    return null;
  }
}

export function shouldDeployRailway(files: string[], target: RailwayServiceKind): boolean {
  const patterns = [...SHARED_DEPLOY_PATTERNS, ...TARGET_DEPLOY_PATTERNS[target]];
  return files.some((file) => patterns.some((pattern) => pattern.test(file)));
}

function changedFiles(): { base: string; files: string[] } | null {
  const requestedBase = process.env.DEPLOY_DIFF_BASE?.trim();
  const candidates = requestedBase ? [requestedBase] : ['origin/main', 'main', 'HEAD^'];
  const head = run('git', ['rev-parse', 'HEAD'], { capture: true });
  for (const candidate of candidates) {
    const base = tryRun('git', ['merge-base', 'HEAD', candidate]);
    if (!base) continue;
    // A ref pointing at HEAD says nothing about changes since the last upload.
    if (base === head) return null;
    const output = tryRun('git', ['diff', '--name-only', `${base}..HEAD`]);
    if (output === null) continue;
    return { base, files: output.split('\n').map((file) => file.trim()).filter(Boolean) };
  }
  return null;
}

export function parseRailwayDeployArguments(args: string[]): { incremental: boolean; target: RailwayServiceKind } {
  let incremental = false;
  let full = false;
  let target: RailwayServiceKind = 'server';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--incremental') {
      incremental = true;
    } else if (argument === '--full') {
      full = true;
    } else if (argument === '--target') {
      const value = args[index + 1];
      if (value !== 'server' && value !== 'cron') throw new Error('--target must be server or cron');
      target = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (incremental === full) throw new Error('Specify exactly one of --full or --incremental');
  return { incremental, target };
}

export function railwayScopeArgs(target: RailwayServiceKind, env: NodeJS.ProcessEnv = process.env): string[] {
  const args: string[] = [];
  args.push('--service', env.RAILWAY_SERVICE?.trim() || DEFAULT_RAILWAY_SERVICES[target]);
  if (env.RAILWAY_ENVIRONMENT?.trim()) args.push('--environment', env.RAILWAY_ENVIRONMENT.trim());
  if (env.RAILWAY_PROJECT_ID?.trim()) {
    if (!env.RAILWAY_ENVIRONMENT?.trim()) {
      throw new Error('RAILWAY_PROJECT_ID requires RAILWAY_ENVIRONMENT');
    }
    args.push('--project', env.RAILWAY_PROJECT_ID.trim());
  }
  return args;
}

function syncRailwayEnvironment(
  railway: string,
  scopeArgs: string[],
  updates: Record<string, string>,
  deletes: readonly string[],
): boolean {
  const currentRaw = run(railway, ['variable', 'list', ...scopeArgs, '--json'], { capture: true });
  const current = JSON.parse(currentRaw) as Record<string, string>;
  const changed = diffDeploymentEnvironment(current, updates, deletes);

  for (const key of changed.deletes) {
    run(railway, ['variable', 'delete', key, ...scopeArgs, '--json'], { capture: true });
  }
  for (const [key, value] of changed.updates) {
    run(railway, ['variable', 'set', key, '--stdin', '--skip-deploys', ...scopeArgs, '--json'], {
      capture: true,
      input: value,
    });
  }

  if (changed.deletes.length > 0 || changed.updates.length > 0) {
    console.info(`[railway] Synced ${changed.updates.length} update(s) and ${changed.deletes.length} explicit deletion(s).`);
    return true;
  }
  console.info('[railway] Environment is already synchronized.');
  return false;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const targetHintIndex = args.indexOf('--target');
  const targetHint = targetHintIndex >= 0 ? args[targetHintIndex + 1] : undefined;
  const defaultBuild = targetHint === 'cron' ? 'railway.cron.production' : 'railway.production';
  const parsedEnv = parseDeploymentEnvArguments(args, defaultBuild);
  const { incremental, target } = parseRailwayDeployArguments(parsedEnv.remaining);
  const railway = process.env.RAILWAY_CLI?.trim() || 'railway';
  const scopeArgs = railwayScopeArgs(target);
  let envChanged = false;

  if (parsedEnv.env.sync) {
    const root = run('git', ['rev-parse', '--show-toplevel'], { capture: true });
    const plan = await buildDeploymentEnvPlan({
      root,
      build: parsedEnv.env.build,
      allowedKeys: target === 'cron' ? RAILWAY_CRON_ENV_KEYS : SERVER_RUNTIME_ENV_KEYS,
      deleteKeys: parsedEnv.env.deleteKeys,
    });
    console.info(`[railway] Syncing environment from ${plan.files.join(', ')} (${plan.build}).`);
    envChanged = syncRailwayEnvironment(railway, scopeArgs, plan.updates, plan.deletes);
  }

  if (incremental) {
    const changes = changedFiles();
    if (!changes) {
      console.warn('[railway] Could not determine a safe diff base; deploying instead of skipping.');
    } else if (!envChanged && !shouldDeployRailway(changes.files, target)) {
      console.info(`[railway] No ${target} runtime changes since ${changes.base}; deployment skipped.`);
      return;
    }
  }

  const railwayArgs = ['up', process.env.RAILWAY_DETACH === 'true' ? '--detach' : '--ci'];
  railwayArgs.push(...scopeArgs);
  console.info(`[railway] Starting ${incremental ? 'incremental' : 'full'} ${target} deployment.`);
  run(railway, railwayArgs);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) await main();
