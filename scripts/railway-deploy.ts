import { spawnSync } from 'node:child_process';

function run(command: string, args: string[], capture = false): string {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with code ${result.status ?? 1}`);
  return (result.stdout ?? '').trim();
}

const incremental = process.argv.includes('--incremental');
if (incremental) {
  const base = process.env.DEPLOY_DIFF_BASE?.trim() || 'HEAD~1';
  const files = run('git', ['diff', '--name-only', `${base}...HEAD`], true).split('\n').filter(Boolean);
  const deployable = files.some(file => /^(Dockerfile|railway\.json|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|packages\/(core|server|web)\/)/.test(file));
  if (!deployable) {
    console.info(`[railway] No runtime changes since ${base}; deployment skipped.`);
    process.exit(0);
  }
}

const args = ['up', '--detach'];
if (process.env.RAILWAY_SERVICE) args.push('--service', process.env.RAILWAY_SERVICE);
if (process.env.RAILWAY_ENVIRONMENT) args.push('--environment', process.env.RAILWAY_ENVIRONMENT);
console.info(`[railway] Starting ${incremental ? 'incremental' : 'full'} server deployment.`);
run(process.env.RAILWAY_CLI || 'railway', args);
