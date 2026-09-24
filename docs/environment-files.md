# Environment file resolution

Environment files are resolved from the command's owning package. Project commands never load the
repository-root `.env`; an existing root file is outside the supported command contract and is not
interchangeable with `packages/server/.env`. Existing shell variables take precedence wherever a
command combines the shell with dotenv files.

## Command matrix

| Command or runtime | Dotenv files, in increasing precedence | Notes |
| --- | --- | --- |
| `pnpm dev:server`, `pnpm --filter @labby/server dev` | `packages/server/.env`, optional `packages/server/.env.local`, shell | Node loads both files explicitly. |
| `pnpm --filter @labby/server start:local` | `packages/server/.env`, optional `packages/server/.env.local`, shell | Same local layering without watch mode. |
| `pnpm --filter @labby/server start` | none | Production-style start consumes only `process.env`, including variables injected by Railway, Cloud Run, Docker, or the shell. |
| `pnpm db:init`, `pnpm db:migrate`, `pnpm --filter @labby/server db:similarity-locks` | `packages/server/.env`, optional `packages/server/.env.local`, shell | The package scripts execute the CLI through `env-lane run server`. `local` is the default; set `ENV_BUILD=NAME` to select another configured build. Explicit `--postgres` / `--pglite` options have highest connection-selection priority. |
| `pnpm --filter @labby/server auth:gmail` | `packages/server/.env`, then shell | `dotenv` resolves `.env` from the package working directory. It does not read `.env.local`. |
| `pnpm dev`, `pnpm dev:server:web`, direct web `dev*` | `packages/web/.env`, `packages/web/.env.local`, `packages/web/.env.development`, `packages/web/.env.development.local`, then shell | Vite development mode. The scripts explicitly set `VITE_DB_CONFIG` and `VITE_DEPLOYMENT_MODE`, so those two shell values win. |
| web `build*`, root `build*` when they build web | `packages/web/.env`, `packages/web/.env.local`, `packages/web/.env.production`, `packages/web/.env.production.local`, then shell | Vite production mode. The frontend/server build variants explicitly set their two deployment variables. |
| `pnpm preview` | `packages/web/.env`, `packages/web/.env.local`, `packages/web/.env.production`, `packages/web/.env.production.local`, then shell | Vite preview serves the already-built output; changing env files does not rewrite that output. |
| `pnpm deploy:railway`, `:incremental` | `packages/server/.env`, optional `packages/server/.env.railway.production` | env-lane is called with `includeProcessEnv: false`; only allowlisted values from these files are synchronized. Railway targeting/control variables such as `RAILWAY_SERVICE` come from the shell, not these files. |
| `pnpm deploy:railway:cron`, `:incremental` | `packages/server/.env`, optional `packages/server/.env.railway.cron.production` | Only the Cron allowlist is synchronized. Use `--env-build NAME` to select another configured build. |
| `pnpm deploy:cloudrun:incremental` | `packages/server/.env`, optional `packages/server/.env.cloudrun.production` | Runtime synchronization uses allowlisted file values only. For local deployment-control values such as `CLOUD_RUN_PROJECT_ID`, an existing shell value overrides the resolved file value. |
| `pnpm railway:plan`, `pnpm railway:apply` | none | IaC evaluates `.railway/railway.ts`; it preserves remote values and does not import dotenv contents. Railway authentication/link state comes from the CLI and shell. |
| `pnpm railway:cron` | none | This is the compiled one-shot entry point. Railway injects its service variables in production; a local invocation must provide shell variables explicitly. |
| `pnpm docker:up` | `packages/server/.env`, then shell, for Compose interpolation | The wrapper passes the package file with Docker Compose's `--env-file`. Compose passes only variables declared in `docker-compose.yml`; the image itself does not load dotenv files. |
| Docker image, Railway runtime, Cloud Run runtime | none | `.dockerignore` excludes every `.env` variant. Runtime configuration must be injected by the platform. |
| `pnpm test` | Node/`tsx` tests: none. Vitest phases: package-local `.env`, `.env.local`, `.env.test`, `.env.test.local`, then shell | Vitest autoloads only `VITE_`-prefixed dotenv variables; tests also set isolated variables programmatically. |
| `typecheck`, `lint`, core/server-only builds | none | Web builds are the exception and follow the Vite production row above. CI workflows otherwise use workflow `env` and secrets. |

`packages/web/.env.frontend-only.example` and `.env.server.example` are reference templates, not
filenames Vite loads automatically. The checked-in scripts already select those modes with shell
assignments. Other web variables should use Vite's conventional filenames shown above.

## Deployment layering

The env-lane configuration uses `.env` followed by `.env.{build}`. Later files override earlier
files. The deployment scripts deliberately disable process-environment injection for the runtime
sync plan, preventing unrelated shell secrets from being copied to a provider. Omission retains a
remote value, an explicit empty assignment synchronizes an empty string, and deletion requires
`--delete-env KEY`.

## Sorting

Templates define the intended key and comment order. Sorting preserves values and comments; keys
not present in a template are appended under an unlisted-variable section where configured.
Missing private env files are skipped and are never created by sorting.

```sh
# Rewrite every existing configured env file.
pnpm env:sort

# Check for drift without writing; exits nonzero when sorting would change a file.
pnpm env:sort:check

# Limit either operation to one target.
pnpm env:sort server
pnpm env:sort railway-production
```

Configured targets are `server`, `server-local`, `railway-production`, `railway-cron-production`,
and `cloudrun-production`. Every target is rooted in `packages/server`. Sorting changes layout only; it does not alter
which files a command loads or their precedence. The repository wrapper deliberately selects each
target's explicitly configured file; raw `env-lane sort TARGET` also infers every selector build and
would reuse that target's template for those inferred files, which is not appropriate when provider
files have different templates.
