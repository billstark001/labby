import { spawnSync } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';

function runText(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
  return (result.stdout ?? '').trim();
}

function run(command: string, args: string[], cwd?: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with code ${result.status ?? 1}`);
  }
}

function tryRunText(command: string, args: string[], cwd?: string): string | null {
  try {
    return runText(command, args, cwd);
  } catch {
    return null;
  }
}

function parseExtraArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  const matches = raw.match(/"(?:\\"|[^"])*"|'(?:\\'|[^'])*'|\S+/g) ?? [];
  return matches.map((segment) => {
    if ((segment.startsWith('"') && segment.endsWith('"')) || (segment.startsWith("'") && segment.endsWith("'"))) {
      return segment.slice(1, -1);
    }
    return segment;
  });
}

function getMergeBase(root: string): string {
  const explicitRef = process.env.DEPLOY_DIFF_BASE?.trim();
  if (explicitRef) {
    const explicitBase = tryRunText('git', ['merge-base', 'HEAD', explicitRef], root);
    if (explicitBase) return explicitBase;
  }

  const originMainBase = tryRunText('git', ['merge-base', 'HEAD', 'origin/main'], root);
  if (originMainBase) return originMainBase;

  const localMainBase = tryRunText('git', ['merge-base', 'HEAD', 'main'], root);
  if (localMainBase) return localMainBase;

  return 'HEAD~1';
}

function getChangedFiles(root: string): string[] {
  const mergeBase = getMergeBase(root);
  const diffRange = `${mergeBase}...HEAD`;
  const output = runText('git', ['diff', '--name-only', diffRange], root);
  if (!output) {
    return [];
  }
  return output.split('\n').map((item) => item.trim()).filter(Boolean);
}

function shouldDeploy(files: string[]): { deploy: boolean; matched: string[] } {
  const triggers = [
    /^Dockerfile$/,
    /^docker-compose\.yml$/,
    /^package\.json$/,
    /^pnpm-lock\.yaml$/,
    /^pnpm-workspace\.yaml$/,
    /^packages\/core\//,
    /^packages\/server\//,
    /^packages\/web\//,
  ];

  const matched = files.filter((file) => triggers.some((rule) => rule.test(file)));
  return {
    deploy: matched.length > 0,
    matched,
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function timestampTag(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear().toString();
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = now.getUTCDate().toString().padStart(2, '0');
  const hh = now.getUTCHours().toString().padStart(2, '0');
  const mi = now.getUTCMinutes().toString().padStart(2, '0');
  const ss = now.getUTCSeconds().toString().padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function main(): void {
  const root = runText('git', ['rev-parse', '--show-toplevel']);
  loadDotenv({ path: `${root}/.env`, override: false });
  // const changedFiles = getChangedFiles(root);

  // if (changedFiles.length === 0) {
  //   console.log('[deploy] No changed files in diff range; skip Cloud Run deploy.');
  //   return;
  // }

  // const decision = shouldDeploy(changedFiles);
  // if (!decision.deploy) {
  //   console.log('[deploy] Changes do not affect deployable targets; skip Cloud Run deploy.');
  //   return;
  // }

  const projectId = requiredEnv('CLOUD_RUN_PROJECT_ID');
  const region = requiredEnv('CLOUD_RUN_REGION');
  const repository = requiredEnv('CLOUD_RUN_REPOSITORY');
  const service = requiredEnv('CLOUD_RUN_SERVICE');

  const image = `${region}-docker.pkg.dev/${projectId}/${repository}/${service}:${timestampTag()}-amd64`;
  // console.log(`[deploy] Changed files requiring deploy: ${decision.matched.join(', ')}`);
  console.log(`[deploy] Building image: ${image}`);

  run('docker', [
    'buildx',
    'build',
    '--platform',
    'linux/amd64',
    '--build-arg',
    'VITE_DB_CONFIG=api',
    '-t',
    image,
    '--push',
    '.',
  ], root);

  const deployArgs = [
    'run',
    'deploy',
    service,
    '--image',
    image,
    '--project',
    projectId,
    '--region',
    region,
    '--allow-unauthenticated',
    '--port',
    '4410',
  ];

  const envVarsFile = process.env.CLOUD_RUN_ENV_VARS_FILE?.trim();
  if (envVarsFile) {
    deployArgs.push('--env-vars-file', envVarsFile);
  }

  const updateSecrets = process.env.CLOUD_RUN_UPDATE_SECRETS?.trim();
  if (updateSecrets) {
    deployArgs.push('--update-secrets', updateSecrets);
  }

  const extraArgs = parseExtraArgs(process.env.CLOUD_RUN_DEPLOY_ARGS);
  deployArgs.push(...extraArgs);

  if ((process.env.CLOUD_RUN_QUIET ?? 'true').toLowerCase() !== 'false') {
    deployArgs.push('--quiet');
  }

  console.log(`[deploy] Deploying service: ${service}`);
  run('gcloud', deployArgs, root);
  console.log('[deploy] Cloud Run incremental deploy finished.');
}

main();
